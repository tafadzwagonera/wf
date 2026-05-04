import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ErrorHandler } from '../shared/utils/error-handler';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';

const ISSUE_FETCH_EXAMPLES: CliExample[] = [
  {
    comment: 'Fetch ticket from primary platform',
    command: 'wf issue:fetch WBP-2971',
  },
  {
    comment: 'Specify platform and format',
    command: 'wf issue:fetch WBP-2971 --platform jira --format md',
  },
];

const warnOnIgnoredRepos = (repos?: string[]): void => {
  if ((repos?.length ?? 0) > 1) {
    console.log(
      chalk.yellow(
        `⚠️ Only the first repository will be used for issue:fetch. Ignoring: ${repos!.slice(1).join(', ')}`,
      ),
    );
  }
};

type OutputFormat = 'json' | 'md' | 'yaml' | 'yml';

interface IssueFetchOptions {
  format?: OutputFormat;
  platform?: string;
  repos?: string[];
  dryRun?: boolean;
}

@Injectable()
@Command({
  name: 'issue:fetch',
  description:
    'Fetch ticket description from a platform. ' +
    'NB: This command will override the locally generated artifact with the ticket description fetched from the specified platform',
  arguments: '<ticket-key>',
})
export class IssueFetchCommand extends CommandRunner {
  constructor(
    private readonly platformService: PlatformService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly fetchStageService: FetchStageService,
  ) {
    super();
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the fetch operation without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '-f, --format <format>',
    description: 'Output format (json|md|yaml|yml)',
  })
  parseFormat(format: string): OutputFormat {
    const validFormats: OutputFormat[] = ['json', 'md', 'yaml', 'yml'];
    if (!validFormats.includes(format as OutputFormat)) {
      throw new Error(
        `Invalid format: ${format}. Valid formats: ${validFormats.join(', ')}`,
      );
    }
    return format as OutputFormat;
  }

  @Option({
    flags: '-p, --platform <platform>',
    description: 'Target platform (jira|github|bitbucket)',
  })
  parsePlatform(platform: string): string {
    const validPlatforms = ['jira', 'github', 'bitbucket'];
    if (!validPlatforms.includes(platform)) {
      throw new Error(
        `Invalid platform: ${platform}. Valid platforms: ${validPlatforms.join(', ')}`,
      );
    }
    return platform;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; only the first repo is used and additional repos are ignored with a warning',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  async run([ticketKey]: [string], options?: IssueFetchOptions): Promise<void> {
    printExamples(ISSUE_FETCH_EXAMPLES);

    try {
      fs.mkdirSync(path.join(os.homedir(), '.wf'), { recursive: true });
      warnOnIgnoredRepos(options?.repos);

      // Get platform (from option or config)
      const platformName =
        options?.platform ||
        this.configService.get<string>('platforms.primary', 'jira');

      // Get format (from option or config)
      const format: OutputFormat =
        options?.format ||
        (this.configService.get<string>(
          'output.defaultFormat',
          'md',
        ) as OutputFormat);

      const extension = format === 'md' ? 'md' : format;
      const repoBase = resolveRepoBasePath(options?.repos?.[0]);
      const platformDir = resolveArtifactDir(repoBase, platformName);
      const filePath = path.join(platformDir, `${ticketKey}.${extension}`);

      if (options?.dryRun) {
        this.dryRunPreview.showHeader('issue:fetch', ticketKey);

        this.dryRunPreview.previewApiCall({
          method: 'GET',
          endpoint: `/${platformName}/issues/${ticketKey}`,
          platform: platformName,
          description: `Fetch ticket ${ticketKey} from ${platformName}`,
          estimatedResponse: '200 OK — ticket data returned',
        });

        this.dryRunPreview.previewFileWrite({
          filePath,
          operation: fs.existsSync(filePath) ? 'overwrite' : 'create',
          sizeEstimate: '1–5 KB',
          format,
          contentPreview: this.buildTicketContentPreview(ticketKey, format),
        });

        this.dryRunPreview.showSummary({
          apiCallCount: 1,
          fileCreatedCount: 1,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          terminalOutputLines: [
            `✓ Ticket saved to: ${filePath}`,
            '',
            'Ticket Details:',
            '  Title: <fetched from platform>',
            '  Type: <type>',
            '  Status: <status>',
            '  Priority: <priority>',
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      this.logger.info(`Fetching ticket ${ticketKey} from ${platformName}...`);

      // Format reference for Bitbucket
      const ticket = await this.fetchStageService.fetchTicket(ticketKey, {
        platformName,
        repo: options?.repos?.[0],
      });

      // Format ticket content
      const content = this.formatTicket(ticket, format);

      // Determine output file path
      if (!fs.existsSync(platformDir)) {
        fs.mkdirSync(platformDir, { recursive: true });
      }

      // Write to file
      await fs.promises.writeFile(filePath, content, 'utf-8');

      this.logger.success(`✓ Ticket saved to: ${filePath}`);
      this.logger.info(`\nTicket Details:`);
      this.logger.info(`  Title: ${ticket.title}`);
      this.logger.info(`  Type: ${ticket.type || 'N/A'}`);
      this.logger.info(`  Status: ${ticket.status}`);
      this.logger.info(`  Priority: ${ticket.priority || 'N/A'}`);
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  private formatTicket(ticket: any, format: OutputFormat): string {
    switch (format) {
      case 'json':
        return JSON.stringify(ticket, null, 2);

      case 'yaml':
      case 'yml':
        return YAML.stringify(ticket);

      case 'md':
      default:
        return this.toMarkdown(ticket);
    }
  }

  private toMarkdown(ticket: any): string {
    let md = `# ${ticket.title}\n\n`;
    md += `**Ticket:** ${ticket.key}\n`;
    md += `**Type:** ${ticket.type || 'N/A'}\n`;
    md += `**Status:** ${ticket.status}\n`;
    md += `**Priority:** ${ticket.priority || 'N/A'}\n`;
    md += `**Assignee:** ${ticket.assignee || 'Unassigned'}\n`;
    md += `**Reporter:** ${ticket.reporter || 'Unknown'}\n\n`;

    if (ticket.labels && ticket.labels.length > 0) {
      md += `**Labels:** ${ticket.labels.join(', ')}\n\n`;
    }

    md += `## Description\n\n${ticket.description || 'No description provided'}\n`;

    return md;
  }

  /**
   * Build a representative first-10-line content preview for a ticket artifact
   * @param ticketKey Ticket identifier
   * @param format Output format
   * @returns Truncated preview string (at most 10 lines)
   */
  private buildTicketContentPreview(
    ticketKey: string,
    format: OutputFormat,
  ): string {
    if (format === 'json') {
      return [
        '{',
        `  "key": "${ticketKey}",`,
        '  "title": "<title>",',
        '  "type": "<type>",',
        '  "status": "<status>",',
        '  "priority": "<priority>",',
        '  "description": "<description>"',
        '}',
      ].join('\n');
    }
    if (format === 'yaml') {
      return [
        `key: ${ticketKey}`,
        'title: <title>',
        'type: <type>',
        'status: <status>',
        'priority: <priority>',
        'description: <description>',
      ].join('\n');
    }
    if (format === 'yml') {
      return [
        `key: ${ticketKey}`,
        'title: <title>',
        'type: <type>',
        'status: <status>',
        'priority: <priority>',
        'description: <description>',
      ].join('\n');
    }
    // markdown (default)
    return buildTicketMarkdownPreview(ticketKey);
  }
}
