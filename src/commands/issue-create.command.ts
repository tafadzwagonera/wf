import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ValidationError, FileSystemError, ExecutionError } from '../shared/utils/errors';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import { TicketPriority, TicketType } from '../common/dto/universal-ticket.dto';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import { parseReposOption } from './utils/repos-option';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { JiraAdapter } from '../integrations/issue-trackers/jira/jira-adapter';
import { stripRedundantSections } from '../common/utils/markdown-text';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

const createEmptyFormattingStats = (): DescriptionFormattingStats => ({
  headingCount: 0,
  paragraphCount: 0,
  codeBlockCount: 0,
  bulletListCount: 0,
  orderedListCount: 0,
  suspiciousMarkers: [],
});

const NODE_TYPE_COUNTERS: Record<string, keyof DescriptionFormattingStats> = {
  heading: 'headingCount',
  paragraph: 'paragraphCount',
  codeBlock: 'codeBlockCount',
  bulletList: 'bulletListCount',
  orderedList: 'orderedListCount',
};

const detectSuspiciousMarkers = (text: string): string[] => {
  const markers: string[] = [];
  if (text.includes('{code')) markers.push('raw {code} marker found in text node');
  if (text.includes('{noformat}')) markers.push('raw {noformat} marker found in text node');
  if (text.includes('{{') || text.includes('}}')) markers.push('raw "{{...}}" inline code marker found in text node');
  if (/^\*\s+/m.test(text)) markers.push('raw "*" bullet marker found in paragraph text');
  return markers;
};

const buildDescriptionFormattingStats = (
  node: unknown,
  stats: DescriptionFormattingStats = createEmptyFormattingStats()
): DescriptionFormattingStats => {
  if (!node || typeof node !== 'object') return stats;

  const adfNode = node as { type?: string; text?: string; content?: unknown[] };
  const counterKey = adfNode.type ? NODE_TYPE_COUNTERS[adfNode.type] : undefined;

  if (counterKey) (stats[counterKey] as number)++;
  if (adfNode.type === 'text' && typeof adfNode.text === 'string') {
    stats.suspiciousMarkers.push(...detectSuspiciousMarkers(adfNode.text));
  }

  for (const child of adfNode.content ?? []) {
    buildDescriptionFormattingStats(child, stats);
  }
  return stats;
};

const buildJiraPayloadPreviewLines = (payload: Record<string, unknown>): string[] => {
  const description = (payload.fields as { description?: unknown } | undefined)?.description;
  const stats = buildDescriptionFormattingStats(description);
  const suspiciousMarkers = stats.suspiciousMarkers.length > 0 ? stats.suspiciousMarkers.join('; ') : 'none';
  const looksJiraSafe
    = stats.suspiciousMarkers.length === 0 && stats.headingCount + stats.codeBlockCount + stats.bulletListCount > 0;

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

const splitIntoSectionBlocks = (lines: string[]): string[][] => {
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    const isNewSection = current.length > 0
      && /^#{3,4}\s+/.test(line)
      && current.some(l => l.trim().length > 0);

    if (isNewSection) {
      blocks.push(current);
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
};

const selectPreviewBlocks = (blocks: string[][]): string[] => {
  const preview: string[] = [];
  let used = 0;

  for (const block of blocks) {
    if (used >= 3 || (preview.length > 0 && preview.length + block.length > 24)) break;
    preview.push(...block);
    used++;
  }
  return preview;
};

const buildTicketPreviewLines = (description: string): string[] => {
  const trimmed = description.trim();
  if (!trimmed) return ['Ticket Preview', '  No description content found'];

  const lines = trimmed.split('\n').map(line => line.trimEnd());
  const preview = selectPreviewBlocks(splitIntoSectionBlocks(lines));
  if (preview.length < lines.length) preview.push('...');
  return ['Ticket Preview', ...preview.map(line => '  ' + line)];
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
      reject(new ExecutionError('Timed out waiting for stdin input'));
    }, STDIN_TIMEOUT_IN_MS);
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });

const logFileInput = (filePath: string): void => {
  console.log(chalk.bold.cyan(`\n📋 Creating Ticket from Input\n`));
  console.log(chalk.gray(`  Input file: ${filePath}`));
};

const warnOnIgnoredRepos = (repos?: string[]): void => {
  if (repos?.length) {
    const ignoredRepos = repos.slice(1).join(', ');
    console.log(
      chalk.yellow(
        `⚠ Only the first repository will be used for issue:create artifact lookup. Ignoring: ${ignoredRepos}`
      )
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
    command: 'wf issue:create ticket.md --tracker jira --ticket-project WBP --type story',
  },
  {
    comment: 'Create Jira ticket with project-specific priority resolution',
    command: 'wf issue:create ticket.md --tracker jira --ticket-project WBP --priority medium',
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
      'yarn test:manual test-issue-update-jira-adf-smoke WBP-3092 --description-file /Users/tafadzwagonera/.wf/terraform-aws/jira/2026-05-13-3d6f5adb-ticket-description.md --live --confirm-live-update',
  },
];

/**
 * Command to create tickets on various trackers from standardized input
 * Supports multiple trackers and formats
 */
@Injectable()
@Command({
  name: 'issue:create',
  description: 'Create tickets on various trackers from standardized input (file or stdin)',
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
    private readonly dryRunPreview: DryRunPreviewService
  ) {
    super();
  }

  async run(passedParams: string[], options?: IssueCreateOptions): Promise<void> {
    if (!options?.silent) {
      printExamples(ISSUE_CREATE_EXAMPLES);
      warnOnIgnoredRepos(options?.repos);
    }

    await executeAsyncWithCatch({ fn: async () => {
      const { ticket, trackerName } = await this.resolveTicketInput(passedParams[0], options);

      if (options?.dryRun) return this.previewDryRun(ticket, trackerName);

      await this.executeCreate(ticket, trackerName, options);
    } });
  }

  private async resolveTicketInput(inputPath: string | undefined, options?: IssueCreateOptions) {
    const stdinAvailable = !inputPath && !process.stdin.isTTY;
    if (!inputPath && !stdinAvailable) {
      throw new ValidationError('Input file path is required when using --file source');
    }

    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    const { content, format } = inputPath
      ? this.readFromFile(inputPath, trackerName, options)
      : await this.readFromStdin(options);

    const converter = this.formatConverterService.getConverter(format);
    const ticket = converter.parse(content);

    if (options?.ticketProject) ticket.project = options.ticketProject;
    if (options?.type) ticket.type = options.type as TicketType;
    if (options?.priority) ticket.priority = options.priority as TicketPriority;
    ticket.description = stripRedundantSections(ticket.description);

    if (!options?.silent) console.log(chalk.gray(`  Target tracker: ${trackerName}\n`));
    return { ticket, trackerName };
  }

  private async readFromStdin(options?: IssueCreateOptions): Promise<{ content: string; format: string }> {
    const content = await readStdin();
    if (!content.trim()) {
      throw new ValidationError('No content received from stdin. Pipe content to stdin or pass an input file path as the first argument.');
    }
    const format = options?.format ?? 'md';
    if (!options?.silent) {
      console.log(chalk.bold.cyan(`\n📋 Creating Ticket from stdin\n`));
      console.log(chalk.gray(`  Detected format: ${format}`));
    }
    return { content, format };
  }

  private readFromFile(
    inputPath: string, trackerName: string, options?: IssueCreateOptions,
  ): { content: string; format: string } {
    const repoBaseDir = resolveRepoBasePath(options?.repos?.[0]);
    const inputFilePath = path.isAbsolute(inputPath)
      ? inputPath
      : path.join(resolveArtifactDir(repoBaseDir, trackerName), path.basename(inputPath));
    if (!fs.existsSync(inputFilePath)) {
      throw new FileSystemError(`Input file not found: ${inputFilePath}. Verify the file path and try again.`);
    }
    if (!options?.silent) logFileInput(inputFilePath);
    const content = fs.readFileSync(inputFilePath, 'utf-8');
    const format = options?.format ?? this.formatConverterService.detectFormat(inputFilePath);
    if (!format) {
      throw new ValidationError(`Unable to detect format from file extension in '${inputFilePath}'. Use --format to specify explicitly.`);
    }
    if (!options?.silent) console.log(chalk.gray(`  Detected format: ${format}`));
    return { content, format };
  }

  private previewDryRun(ticket: any, trackerName: string): void {
    this.dryRunPreview.showHeader('issue:create', ticket.title?.substring(0, 40));
    const payload = trackerName === 'jira'
      ? this.jiraAdapter.buildCreatePayload(ticket)
      : { title: ticket.title, type: ticket.type || 'task', priority: ticket.priority || 'medium', project: ticket.project || '<from config>' };
    this.dryRunPreview.previewApiCall({
      method: 'POST', endpoint: `/${trackerName}/issues`, platform: trackerName,
      description: `Create ticket on ${trackerName}`, estimatedResponse: '201 Created — ticket key and URL returned',
      payloadPreviewLines: trackerName === 'jira'
        ? [...buildJiraPayloadPreviewLines(payload), '', ...buildTicketPreviewLines(ticket.description)]
        : [],
    });
    this.dryRunPreview.showSummary({
      apiCallCount: 1, fileCreatedCount: 0, fileModifiedCount: 0, gitOperationCount: 0,
      terminalOutputLines: ['✔ Ticket created successfully!', '', `Platform: ${trackerName}`,
        'Key: <tracker-assigned-key>', 'ID: <tracker-assigned-id>', 'URL: <tracker-ticket-url>'],
    });
    this.dryRunPreview.showValidationResult();
  }

  private async executeCreate(ticket: any, trackerName: string, options?: IssueCreateOptions): Promise<void> {
    const adapter = this.issueTrackerService.getAdapter(trackerName);
    if (!options?.silent) console.log(chalk.cyan('🚀 Creating ticket on tracker...\n'));
    const reference = await adapter.createTicket(ticket);

    if (options?.silent) {
      console.log(reference.key);
      return;
    }
    console.log(chalk.green('✔ Ticket created successfully!\n'));
    console.log(chalk.bold('Tracker:'), chalk.cyan(reference.tracker));
    console.log(chalk.bold('Key:'), chalk.bold.cyan(reference.key));
    console.log(chalk.bold('ID:'), chalk.cyan(reference.id));
    if (reference.url) console.log(chalk.bold('URL:'), chalk.cyan(reference.url));
    console.log();
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
      throw new ValidationError(`Invalid format: ${val}. Valid formats: ${validFormats.join(', ')}`);
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
    description: 'Suppress decorative output and interactive prompts. Emits only the ticket key for piping',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '--ticket-project <project>',
    description: 'Project key (Jira) or repository (Bitbucket: workspace/repo) - overrides input file',
  })
  parseTicketProject(val: string): string {
    return val;
  }

  @Option({
    flags: '--tracker <tracker>',
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
