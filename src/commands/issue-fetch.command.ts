import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ErrorHandler } from '../shared/utils/error-handler';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import { ensureWfHome } from '../shared/utils/ensure-wf-home';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

const ISSUE_FETCH_EXAMPLES: CliExample[] = [
  {
    comment: 'Fetch ticket from primary tracker',
    command: 'wf issue:fetch WBP-2971',
  },
  {
    comment: 'Specify tracker and format',
    command: 'wf issue:fetch WBP-2971 --tracker jira --format md',
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
  tracker?: string;
  repos?: string[];
  dryRun?: boolean;
  silent?: boolean;
}

@Injectable()
@Command({
  name: 'issue:fetch',
  description:
    'Fetch ticket description from a tracker. ' +
    'NB: This command will override the locally generated artifact with the ticket description fetched from the specified tracker',
  arguments: '<ticket-key>',
})
export class IssueFetchCommand extends CommandRunner {
  constructor(
    private readonly issueTrackerService: IssueTrackerService,
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
    description: 'Output format (json|md|yaml|yml) - default: md',
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
    flags: '-t, --tracker <tracker>',
    description: 'Target tracker (jira|github|bitbucket)',
  })
  parseTracker(tracker: string): string {
    const validTrackers = ['jira', 'github', 'bitbucket'];
    if (!validTrackers.includes(tracker)) {
      throw new Error(
        `Invalid tracker: ${tracker}. Valid trackers: ${validTrackers.join(', ')}`,
      );
    }
    return tracker;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; only the first repo is used and additional repos are ignored with a warning',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '-s, --silent',
    description:
      'Suppress decorative output and interactive prompts. Emits only the file path for piping',
  })
  parseSilent(): boolean {
    return true;
  }

  async run([ticketKey]: [string], options?: IssueFetchOptions): Promise<void> {
    if (!options?.silent) {
      printExamples(ISSUE_FETCH_EXAMPLES);
    }

    try {
      await ensureWfHome();
      if (!options?.silent) {
        warnOnIgnoredRepos(options?.repos);
      }

      // Get tracker (from option or config)
      const trackerName =
        options?.tracker || this.configService.get<string>('tracker', 'jira');

      // Output format: CLI flag > hardcoded default (fetch has no stage config)
      const format: OutputFormat = options?.format || 'md';

      const extension = format === 'md' ? 'md' : format;
      const repoBase = resolveRepoBasePath(options?.repos?.[0]);
      const trackerDir = resolveArtifactDir(repoBase, trackerName);
      const filePath = path.join(trackerDir, `${ticketKey}.${extension}`);

      if (options?.dryRun) {
        this.dryRunPreview.showHeader('issue:fetch', ticketKey);

        this.dryRunPreview.previewApiCall({
          method: 'GET',
          endpoint: `/${trackerName}/issues/${ticketKey}`,
          platform: trackerName,
          description: `Fetch ticket ${ticketKey} from ${trackerName}`,
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
            '  Title: <fetched from tracker>',
            '  Type: <type>',
            '  Status: <status>',
            '  Priority: <priority>',
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      if (!options?.silent) {
        this.logger.info(`Fetching ticket ${ticketKey} from ${trackerName}...`);
      }

      // Format reference for Bitbucket
      const ticket = await this.fetchStageService.fetchTicket(ticketKey, {
        trackerName,
        repo: options?.repos?.[0],
      });

      // Format ticket content
      const content = this.formatTicket(ticket, format);

      // Determine output file path
      if (!fs.existsSync(trackerDir)) {
        fs.mkdirSync(trackerDir, { recursive: true });
      }

      // Write to file
      await fs.promises.writeFile(filePath, content, 'utf-8');

      if (options?.silent) {
        console.log(filePath);
      } else {
        this.logger.success(`✓ Ticket saved to: ${filePath}`);
        this.logger.info(`\nTicket Details:`);
        this.logger.info(`  Title: ${ticket.title}`);
        this.logger.info(`  Type: ${ticket.type || 'N/A'}`);
        this.logger.info(`  Status: ${ticket.status}`);
        this.logger.info(`  Priority: ${ticket.priority || 'N/A'}`);
      }
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
