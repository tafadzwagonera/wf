import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { PlatformService } from '../integrations/platforms/platform.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { TicketType } from '../common/dto/universal-ticket.dto';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import { parseReposOption } from './utils/repos-option';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { JiraAdapter } from '../integrations/platforms/jira/jira-adapter';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

interface IssueCreateOptions {
  platform?: string;
  repos?: string[];
  ticketProject?: string;
  type?: string;
  dryRun?: boolean;
}

interface DescriptionFormattingStats {
  headingCount: number;
  paragraphCount: number;
  codeBlockCount: number;
  bulletListCount: number;
  orderedListCount: number;
  suspiciousMarkers: string[];
}

const buildDescriptionFormattingStats = (
  node: unknown,
  stats: DescriptionFormattingStats = {
    headingCount: 0,
    paragraphCount: 0,
    codeBlockCount: 0,
    bulletListCount: 0,
    orderedListCount: 0,
    suspiciousMarkers: [],
  },
): DescriptionFormattingStats => {
  if (!node || typeof node !== 'object') {
    return stats;
  }

  const adfNode = node as {
    type?: string;
    text?: string;
    content?: unknown[];
  };

  switch (adfNode.type) {
    case 'heading':
      stats.headingCount++;
      break;
    case 'paragraph':
      stats.paragraphCount++;
      break;
    case 'codeBlock':
      stats.codeBlockCount++;
      break;
    case 'bulletList':
      stats.bulletListCount++;
      break;
    case 'orderedList':
      stats.orderedListCount++;
      break;
    case 'text':
      if (typeof adfNode.text === 'string') {
        if (adfNode.text.includes('{code')) {
          stats.suspiciousMarkers.push('raw {code} marker found in text node');
        }
        if (/^\*\s+/m.test(adfNode.text)) {
          stats.suspiciousMarkers.push(
            'raw "*" bullet marker found in paragraph text',
          );
        }
      }
      break;
  }

  adfNode.content?.forEach((child) =>
    buildDescriptionFormattingStats(child, stats),
  );
  return stats;
};

const buildJiraPayloadPreviewLines = (
  payload: Record<string, unknown>,
): string[] => {
  const description = (payload.fields as { description?: unknown } | undefined)
    ?.description;
  const stats = buildDescriptionFormattingStats(description);
  const suspiciousMarkers =
    stats.suspiciousMarkers.length > 0
      ? stats.suspiciousMarkers.join('; ')
      : 'none';
  const looksJiraSafe =
    stats.suspiciousMarkers.length === 0 &&
    stats.codeBlockCount > 0 &&
    stats.bulletListCount > 0;

  return [
    'Formatting Summary',
    `  Headings: ${stats.headingCount}`,
    `  Paragraphs: ${stats.paragraphCount}`,
    `  Code blocks: ${stats.codeBlockCount}`,
    `  Bullet lists: ${stats.bulletListCount}`,
    `  Ordered lists: ${stats.orderedListCount}`,
    `  Suspicious raw markers: ${suspiciousMarkers}`,
    `  Verdict: ${looksJiraSafe ? 'looks Jira-safe' : 'needs review'}`,
  ];
};

const buildTicketPreviewLines = (description: string): string[] => {
  const trimmedDescription = description.trim();
  if (!trimmedDescription) {
    return ['Ticket Preview', '  No description content found'];
  }

  const lines = trimmedDescription.split('\n').map((line) => line.trimEnd());
  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const line of lines) {
    const startsNewSection =
      currentBlock.length > 0 &&
      /^#{3,4}\s+/.test(line) &&
      currentBlock.some((existingLine) => existingLine.trim().length > 0);

    if (startsNewSection) {
      blocks.push(currentBlock);
      currentBlock = [line];
      continue;
    }

    currentBlock.push(line);
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  const previewLines: string[] = [];
  let usedBlockCount = 0;

  for (const block of blocks) {
    const nextLength = previewLines.length + block.length;
    if (usedBlockCount >= 3 || (previewLines.length > 0 && nextLength > 24)) {
      break;
    }
    previewLines.push(...block);
    usedBlockCount++;
  }

  if (previewLines.length < lines.length) {
    previewLines.push('...');
  }

  return ['Ticket Preview', ...previewLines.map((line) => `  ${line}`)];
};

const warnOnIgnoredRepos = (repos?: string[]): void => {
  if ((repos?.length ?? 0) > 1) {
    console.log(
      chalk.yellow(
        `⚠️ Only the first repository will be used for issue:create artifact lookup. Ignoring: ${repos!.slice(1).join(', ')}`,
      ),
    );
  }
};

const ISSUE_CREATE_EXAMPLES: CliExample[] = [
  {
    comment: 'Create ticket from JSON on primary platform',
    command: 'wf issue:create ticket.json',
  },
  {
    comment: 'Create on a specific platform and override the Jira project',
    command:
      'wf issue:create ticket.md --platform jira --ticket-project WBP --type story',
  },
];

/**
 * Command to create tickets on various platforms from standardized input
 * Supports multiple platforms and formats
 */
@Injectable()
@Command({
  name: 'issue:create',
  description: 'Create tickets on various platforms from standardized input',
  arguments: '<input>',
  options: { isDefault: false },
})
export class IssueCreateCommand extends CommandRunner {
  constructor(
    private readonly platformService: PlatformService,
    private readonly jiraAdapter: JiraAdapter,
    private readonly formatConverterService: FormatConverterService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
  ) {
    super();
  }

  async run(
    passedParams: string[],
    options?: IssueCreateOptions,
  ): Promise<void> {
    printExamples(ISSUE_CREATE_EXAMPLES);

    const inputPath = passedParams[0];

    if (!inputPath) {
      console.error(chalk.red('Error: Input file path is required'));
      console.log(chalk.gray('Usage: wf issue:create <input> [options]'));
      console.log(
        chalk.gray(
          'Example: wf issue:create ticket.json --platform github --type bug',
        ),
      );
      process.exit(1);
    }

    try {
      const platformName =
        options?.platform ||
        this.configService.get<string>('platforms.primary', 'jira');
      warnOnIgnoredRepos(options?.repos);
      const resolved = path.resolve(inputPath);
      const repoBaseDir = resolveRepoBasePath(options?.repos?.[0]);
      const artifactPath =
        path.basename(inputPath) === inputPath
          ? path.join(resolveArtifactDir(repoBaseDir, platformName), inputPath)
          : null;
      const inputFilePath = fs.existsSync(resolved)
        ? resolved
        : artifactPath && fs.existsSync(artifactPath)
          ? artifactPath
          : resolved;

      if (!fs.existsSync(inputFilePath)) {
        throw new Error(`Input file not found: ${inputFilePath}`);
      }

      console.log(chalk.bold.cyan(`\n📋 Creating Ticket from Input\n`));
      console.log(chalk.gray(`  Input file: ${inputFilePath}`));

      // Detect format and parse
      const content = fs.readFileSync(inputFilePath, 'utf-8');
      const format = this.formatConverterService.detectFormat(inputFilePath);

      if (!format) {
        throw new Error(
          `Unable to detect format from file: ${inputFilePath}. Supported: .json, .yaml, .md, .xml`,
        );
      }

      console.log(chalk.gray(`  Detected format: ${format}`));

      const converter = this.formatConverterService.getConverter(format);
      const ticket = converter.parse(content);

      // Apply command-line overrides
      if (options?.ticketProject) {
        ticket.project = options.ticketProject;
      }
      if (options?.type) {
        ticket.type = options.type as TicketType;
      }

      // Get platform adapter
      console.log(chalk.gray(`  Target platform: ${platformName}\n`));

      // Dry run mode - just validate
      if (options?.dryRun) {
        this.dryRunPreview.showHeader(
          'issue:create',
          ticket.title?.substring(0, 40),
        );

        const payload =
          platformName === 'jira'
            ? this.jiraAdapter.buildCreatePayload(ticket)
            : {
                title: ticket.title,
                type: ticket.type || 'task',
                priority: ticket.priority || 'medium',
                project: ticket.project || '<from config>',
              };

        this.dryRunPreview.previewApiCall({
          method: 'POST',
          endpoint: `/${platformName}/issues`,
          platform: platformName,
          description: `Create ticket on ${platformName}`,
          estimatedResponse: '201 Created — ticket key and URL returned',
          payloadPreviewLines:
            platformName === 'jira'
              ? [
                  ...buildJiraPayloadPreviewLines(payload),
                  '',
                  ...buildTicketPreviewLines(ticket.description),
                ]
              : [],
        });

        this.dryRunPreview.showSummary({
          apiCallCount: 1,
          fileCreatedCount: 0,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          terminalOutputLines: [
            '✅ Ticket created successfully!',
            '',
            `Platform: ${platformName}`,
            'Key: <platform-assigned-key>',
            'ID: <platform-assigned-id>',
            'URL: <platform-ticket-url>',
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      // Create ticket on platform
      const adapter = this.platformService.getAdapter(platformName);
      console.log(chalk.cyan('🚀 Creating ticket on platform...\n'));
      const reference = await adapter.createTicket(ticket);

      console.log(chalk.green('✅ Ticket created successfully!\n'));
      console.log(chalk.bold('Platform:'), chalk.cyan(reference.platform));
      console.log(chalk.bold('Key:'), chalk.bold.cyan(reference.key));
      console.log(chalk.bold('ID:'), chalk.cyan(reference.id));
      if (reference.url) {
        console.log(chalk.bold('URL:'), chalk.cyan(reference.url));
      }
      console.log();
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  @Option({
    flags: '--dry-run',
    description: 'Validate without creating - preview only',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '-p, --platform <platform>',
    description: 'Target platform (jira|github|bitbucket) - default from env',
  })
  parsePlatform(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; only the first repo is used for artifact lookup and others are ignored with a warning',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '--ticket-project <project>',
    description:
      'Project key (Jira) or repository (Bitbucket: workspace/repo) - overrides input file',
  })
  parseTicketProject(val: string): string {
    return val;
  }

  @Option({
    flags: '-t, --type <type>',
    description: 'Issue type (task|bug|story|todo) - overrides input file',
  })
  parseType(val: string): string {
    return val;
  }
}
