import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { TicketPriority, TicketType } from '../common/dto/universal-ticket.dto';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import { parseReposOption } from './utils/repos-option';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { JiraAdapter } from '../integrations/issue-trackers/jira/jira-adapter';
import { stripRedundantSections } from '../common/utils/markdown-text';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

interface IssueCreateOptions {
  format?: string;
  tracker?: string;
  repos?: string[];
  ticketProject?: string;
  priority?: string;
  type?: string;
  dryRun?: boolean;
  silent?: boolean;
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
        if (adfNode.text.includes('{noformat}')) {
          stats.suspiciousMarkers.push(
            'raw {noformat} marker found in text node',
          );
        }
        if (adfNode.text.includes('{{') || adfNode.text.includes('}}')) {
          stats.suspiciousMarkers.push(
            'raw "{{...}}" inline code marker found in text node',
          );
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
    stats.headingCount + stats.codeBlockCount + stats.bulletListCount > 0;

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

const STDIN_TIMEOUT_IN_MS = 30_000;

/**
 * Read all data from stdin until EOF.
 * Rejects after STDIN_TIMEOUT_IN_MS if no data arrives and stdin never closes.
 *
 * @returns The full stdin content as a UTF-8 string
 */
const readStdin = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      reject(new Error('Timed out waiting for stdin input'));
    }, STDIN_TIMEOUT_IN_MS);
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

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
    comment: 'Create ticket from JSON on primary tracker',
    command: 'wf issue:create ticket.json',
  },
  {
    comment: 'Create on a specific tracker and override the Jira project',
    command:
      'wf issue:create ticket.md --tracker jira --ticket-project WBP --type story',
  },
  {
    comment: 'Create Jira ticket with project-specific priority resolution',
    command:
      'wf issue:create ticket.md --tracker jira --ticket-project WBP --priority medium',
  },
  {
    comment: 'Dry-run a repo-scoped generated Jira artifact before creation',
    command:
      'wf issue:create 2026-05-12-d38b5be9-ticket-description.md --ticket-project WBP -r terraform-aws --dry-run',
  },
  {
    comment:
      'Live smoke-test a Jira description update using a generated artifact; --live requires --confirm-live-update and shows a y/N prompt before the PUT',
    command:
      'nr test:manual -- test-issue-update-jira-adf-smoke WBP-3092 --description-file /Users/tafadzwagonera/.wf/terraform-aws/jira/2026-05-13-3d6f5adb-ticket-description.md --live --confirm-live-update',
  },
];

/**
 * Command to create tickets on various trackers from standardized input
 * Supports multiple trackers and formats
 */
@Injectable()
@Command({
  name: 'issue:create',
  description:
    'Create tickets on various trackers from standardized input (file or stdin)',
  arguments: '[input]',
  options: { isDefault: false },
})
export class IssueCreateCommand extends CommandRunner {
  constructor(
    private readonly issueTrackerService: IssueTrackerService,
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
    if (!options?.silent) {
      printExamples(ISSUE_CREATE_EXAMPLES);
    }

    const inputPath = passedParams[0];
    const stdinAvailable = !inputPath && !process.stdin.isTTY;

    if (!inputPath && !stdinAvailable) {
      console.error(chalk.red('Error: Input file path is required'));
      console.log(
        chalk.gray(
          'Usage: wf issue:create [input] [options]  (or pipe content to stdin)',
        ),
      );
      console.log(
        chalk.gray(
          'Example: wf issue:create ticket.json --tracker github --type bug',
        ),
      );
      console.log(
        chalk.gray('         wf issue:generate ./spec.md -s | wf issue:create'),
      );
      process.exit(1);
    }

    try {
      const trackerName =
        options?.tracker || this.configService.get<string>('tracker', 'jira');
      if (!options?.silent) {
        warnOnIgnoredRepos(options?.repos);
      }

      let content: string;
      let format: string;

      if (stdinAvailable) {
        content = await readStdin();
        if (!content.trim()) {
          throw new Error('No content received from stdin');
        }
        format = options?.format ?? 'md';
        if (!options?.silent) {
          console.log(chalk.bold.cyan(`\n📋 Creating Ticket from stdin\n`));
          console.log(chalk.gray(`  Detected format: ${format}`));
        }
      } else {
        const resolved = path.resolve(inputPath);
        const repoBaseDir = resolveRepoBasePath(options?.repos?.[0]);
        const artifactPath = path.join(
          resolveArtifactDir(repoBaseDir, trackerName),
          path.basename(inputPath),
        );
        const inputFilePath = fs.existsSync(resolved)
          ? resolved
          : fs.existsSync(artifactPath)
            ? artifactPath
            : resolved;

        if (!fs.existsSync(inputFilePath)) {
          throw new Error(`Input file not found: ${inputFilePath}`);
        }

        if (!options?.silent) {
          console.log(chalk.bold.cyan(`\n📋 Creating Ticket from Input\n`));
          console.log(chalk.gray(`  Input file: ${inputFilePath}`));
        }

        content = fs.readFileSync(inputFilePath, 'utf-8');
        const detected =
          options?.format ??
          this.formatConverterService.detectFormat(inputFilePath);

        if (!detected) {
          throw new Error(
            `Unable to detect format from file: ${inputFilePath}. Supported: .json, .yaml, .md, .xml`,
          );
        }
        format = detected;

        if (!options?.silent) {
          console.log(chalk.gray(`  Detected format: ${format}`));
        }
      }

      const converter = this.formatConverterService.getConverter(format);
      const ticket = converter.parse(content);

      // Apply command-line overrides
      if (options?.ticketProject) {
        ticket.project = options.ticketProject;
      }
      if (options?.type) {
        ticket.type = options.type as TicketType;
      }
      if (options?.priority) {
        ticket.priority = options.priority as TicketPriority;
      }

      ticket.description = stripRedundantSections(ticket.description);

      // Get tracker adapter
      if (!options?.silent) {
        console.log(chalk.gray(`  Target tracker: ${trackerName}\n`));
      }

      // Dry run mode - just validate
      if (options?.dryRun) {
        this.dryRunPreview.showHeader(
          'issue:create',
          ticket.title?.substring(0, 40),
        );

        const payload =
          trackerName === 'jira'
            ? this.jiraAdapter.buildCreatePayload(ticket)
            : {
                title: ticket.title,
                type: ticket.type || 'task',
                priority: ticket.priority || 'medium',
                project: ticket.project || '<from config>',
              };

        this.dryRunPreview.previewApiCall({
          method: 'POST',
          endpoint: `/${trackerName}/issues`,
          platform: trackerName,
          description: `Create ticket on ${trackerName}`,
          estimatedResponse: '201 Created — ticket key and URL returned',
          payloadPreviewLines:
            trackerName === 'jira'
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
            `Platform: ${trackerName}`,
            'Key: <tracker-assigned-key>',
            'ID: <tracker-assigned-id>',
            'URL: <tracker-ticket-url>',
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      // Create ticket on tracker
      const adapter = this.issueTrackerService.getAdapter(trackerName);
      if (!options?.silent) {
        console.log(chalk.cyan('🚀 Creating ticket on tracker...\n'));
      }
      const reference = await adapter.createTicket(ticket);

      if (options?.silent) {
        console.log(reference.key);
      } else {
        console.log(chalk.green('✅ Ticket created successfully!\n'));
        console.log(chalk.bold('Tracker:'), chalk.cyan(reference.tracker));
        console.log(chalk.bold('Key:'), chalk.bold.cyan(reference.key));
        console.log(chalk.bold('ID:'), chalk.cyan(reference.id));
        if (reference.url) {
          console.log(chalk.bold('URL:'), chalk.cyan(reference.url));
        }
        console.log();
      }
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
    flags: '-f, --format <format>',
    description:
      'Input format (json|md|yaml|yml) - overrides file extension detection; required when reading from stdin',
  })
  parseFormat(val: string): string {
    const validFormats = ['json', 'md', 'yaml', 'yml'];
    if (!validFormats.includes(val)) {
      throw new Error(
        `Invalid format: ${val}. Valid formats: ${validFormats.join(', ')}`,
      );
    }
    return val;
  }

  @Option({
    flags: '--priority <priority>',
    description:
      'Override normalized ticket priority (highest|high|medium|low|lowest); Jira resolves it to an allowed project value',
  })
  parsePriority(val: string): string {
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
    flags: '-s, --silent',
    description:
      'Suppress decorative output and interactive prompts. Emits only the ticket key for piping',
  })
  parseSilent(): boolean {
    return true;
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
    flags: '-t, --tracker <tracker>',
    description: 'Target tracker (jira|github|bitbucket) - default from config',
  })
  parseTracker(val: string): string {
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
