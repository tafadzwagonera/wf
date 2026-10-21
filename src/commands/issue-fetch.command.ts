import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../common/logger/logger.service';
import { DryRunPreviewService } from '../common/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../common/preview/preview.helpers';
import { ValidationError } from '../common/utils/errors';
import { executeAsyncWithCatch } from '../common/utils/execute-with-catch';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import { printCommandHeader } from '../common/utils/command-header.helper';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import { ensureWfHome } from '../common/utils/ensure-wf-home';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';
const warnOnIgnoredRepos = (repos?: string[]): void => {
  if ((repos?.length ?? 0) > 1) {
    console.log(
      chalk.yellow(`⚠ Only the first repository will be used for issue:fetch. Ignoring: ${(repos ?? []).slice(1).join(', ')}`)
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
    'Fetch ticket description from a tracker. '
    + 'NB: This command will override the locally generated artifact with the ticket description fetched from the specified tracker',
  arguments: '<ticket-key>',
})
export class IssueFetchCommand extends CommandRunner {
  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly fetchStageService: FetchStageService
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
      throw new ValidationError(`Invalid format: ${format}. Valid formats: ${validFormats.join(', ')}`);
    }
    return format as OutputFormat;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; only the first repo is used and additional repos are ignored with a warning. Names resolve from cwd, a sibling directory, then $WF_REPOS_DIR (default: $HOME/Apps, Projects, apps, projects)',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '-s, --silent',
    description: 'Suppress decorative output and interactive prompts. Emits only the file path for piping',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description: 'Target tracker (jira|github|bitbucket)',
  })
  parseTracker(tracker: string): string {
    const validTrackers = ['jira', 'github', 'bitbucket'];
    if (!validTrackers.includes(tracker)) {
      throw new ValidationError(`Invalid tracker: ${tracker}. Valid trackers: ${validTrackers.join(', ')}`);
    }
    return tracker;
  }

  async run([ticketKey]: [string], options?: IssueFetchOptions): Promise<void> {
    if (!options?.silent) {
      printCommandHeader('issue:fetch');
    }

    await executeAsyncWithCatch({ fn: async () => {
      await ensureWfHome();
      if (!options?.silent) warnOnIgnoredRepos(options?.repos);

      const ctx = this.resolveInputs(ticketKey, options);

      if (options?.dryRun) return this.previewDryRun(ctx);

      await this.executeFetch(ctx, options);
    } });
  }

  private resolveInputs(ticketKey: string, options?: IssueFetchOptions) {
    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    const format: OutputFormat = options?.format || 'md';
    const repoBase = resolveRepoBasePath(options?.repos?.[0]);
    const trackerDir = resolveArtifactDir(repoBase, trackerName);
    const filePath = path.join(trackerDir, `${ticketKey}.${format}`);
    return { ticketKey, trackerName, format, trackerDir, filePath };
  }

  private previewDryRun(ctx: ReturnType<IssueFetchCommand['resolveInputs']>): void {
    this.dryRunPreview.showHeader('issue:fetch', ctx.ticketKey);
    this.dryRunPreview.previewApiCall({
      method: 'GET',
      endpoint: '/' + ctx.trackerName + '/issues/' + ctx.ticketKey,
      platform: ctx.trackerName,
      description: 'Fetch ticket ' + ctx.ticketKey + ' from ' + ctx.trackerName,
      estimatedResponse: '200 OK — ticket data returned',
    });
    this.dryRunPreview.previewFileWrite({
      filePath: ctx.filePath,
      operation: fs.existsSync(ctx.filePath) ? 'overwrite' : 'create',
      sizeEstimate: '1–5 KB',
      format: ctx.format,
      contentPreview: this.buildTicketContentPreview(ctx.ticketKey, ctx.format),
    });
    this.previewFetchSummary(ctx.filePath);
  }

  private previewFetchSummary(filePath: string): void {
    this.dryRunPreview.showSummary({
      apiCallCount: 1, fileCreatedCount: 1, fileModifiedCount: 0, gitOperationCount: 0,
      terminalOutputLines: [
        '✔ Ticket saved to: ' + filePath, '',
        'Ticket Details:', '  Title: <fetched from tracker>',
        '  Type: <type>', '  Status: <status>', '  Priority: <priority>',
      ],
    });
    this.dryRunPreview.showValidationResult();
  }

  private async executeFetch(
    ctx: ReturnType<IssueFetchCommand['resolveInputs']>,
    options?: IssueFetchOptions
  ): Promise<void> {
    if (!options?.silent) {
      this.logger.info('Fetching ticket ' + ctx.ticketKey + ' from ' + ctx.trackerName + '...');
    }

    const ticket = await this.fetchStageService.fetchTicket(ctx.ticketKey, {
      trackerName: ctx.trackerName, repo: options?.repos?.[0],
    });

    const content = this.formatTicket(ticket, ctx.format);
    if (!fs.existsSync(ctx.trackerDir)) fs.mkdirSync(ctx.trackerDir, { recursive: true });
    await fs.promises.writeFile(ctx.filePath, content, 'utf-8');

    if (options?.silent) {
      console.log(ctx.filePath);
      return;
    }
    this.printTicketDetails(ticket, ctx.filePath);
  }

  private printTicketDetails(ticket: any, filePath: string): void {
    this.logger.success('✔ Ticket saved to: ' + filePath);
    this.logger.info('\nTicket Details:');
    this.logger.info('  Title: ' + ticket.title);
    this.logger.info('  Type: ' + (ticket.type || 'N/A'));
    this.logger.info('  Status: ' + ticket.status);
    this.logger.info('  Priority: ' + (ticket.priority || 'N/A'));
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
  private buildTicketContentPreview(ticketKey: string, format: OutputFormat): string {
    switch (format) {
      case 'json':
        return '{\n  "key": "' + ticketKey + '",\n  "title": "<title>",\n  "type": "<type>",'
          + '\n  "status": "<status>",\n  "priority": "<priority>",\n  "description": "<description>"\n}';
      case 'yaml':
      case 'yml':
        return 'key: ' + ticketKey + '\ntitle: <title>\ntype: <type>'
          + '\nstatus: <status>\npriority: <priority>\ndescription: <description>';
      default:
        return buildTicketMarkdownPreview(ticketKey);
    }
  }
}
