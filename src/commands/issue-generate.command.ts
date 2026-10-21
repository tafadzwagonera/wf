import { Command, CommandRunner, Option } from 'nest-commander';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { AiService, requireAiResponseContent } from '../integrations/ai/ai.service';
import { ConfigService } from '@nestjs/config';
import { DryRunPreviewService } from '../common/preview/dry-run-preview.service';
import { isAiProviderErrorLike, ValidationError, ExecutionError, ConfigurationError } from '../common/utils/errors';
import { executeAsyncWithCatch } from '../common/utils/execute-with-catch';
import { SlackService } from '../integrations/slack/slack.service';
import { StageAgentService } from '../integrations/ai/stage-agent.service';
import { resolveArtifactDir, resolveCustomArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { resolveExistingRepoDir } from '../common/utils/repo-resolution';
import { parseReposOption } from './utils/repos-option';
import { printCommandHeader } from '../common/utils/command-header.helper';
import {
  buildGeneratedTicketArtifactFilename,
  buildGeneratedTicketManifestFilename,
  buildGeneratedTicketManifestPath,
  buildGeneratedTicketSourceManifest,
  hashGeneratedTicketSources,
} from '../common/utils/generated-ticket-artifact';
import { UniversalTicket, TicketType, TicketPriority } from '../common/dto/universal-ticket.dto';
import { generateTicketSchema } from '../common/schemas/generate-ticket.schema';
import { appendToLogFile } from '../common/logger/log-file-writer';
import inquirer from 'inquirer';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import axios from 'axios';
import { ensureWfHome } from '../common/utils/ensure-wf-home';
import {
  detectRepoConventions,
  formatRepoConventionsPromptSection,
  type RepoConventionsContext,
} from '../common/utils/detect-repo-conventions';
import {
  detectPriorPlans,
  formatPriorPlansPromptSection,
  correlatePlans,
  formatPlanCorrelationPromptSection,
  type PriorPlanContext,
  type PlanCorrelationResult,
} from '../common/utils/detect-prior-plans';
import {
  detectCrossRepoPatterns,
  formatCrossRepoPatternsPromptSection,
  type CrossRepoContext,
} from '../common/utils/detect-cross-repo-patterns';

const MAX_SOURCE_CONTENT_LENGTH = 30_000;
const SLACK_CHANNEL_HISTORY_LIMIT = 50;
const SLACK_THREAD_PATH = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/i;
const SLACK_CHANNEL_PATH = /^\/archives\/([A-Z0-9]+)\/?$/i;
const JIRA_BROWSE_PATH = /^\/browse\/([A-Z]+-\d+)\/?$/i;
const contractionMap: ReadonlyMap<string, string> = new Map([
  ['don\'t', 'do not'],
  ['can\'t', 'cannot'],
  ['won\'t', 'will not'],
  ['isn\'t', 'is not'],
  ['aren\'t', 'are not'],
  ['doesn\'t', 'does not'],
  ['wasn\'t', 'was not'],
  ['weren\'t', 'were not'],
  ['couldn\'t', 'could not'],
  ['wouldn\'t', 'would not'],
  ['shouldn\'t', 'should not'],
  ['it\'s', 'it is'],
  ['that\'s', 'that is'],
  ['there\'s', 'there is'],
  ['here\'s', 'here is'],
  ['what\'s', 'what is'],
  ['who\'s', 'who is'],
  ['let\'s', 'let us'],
  ['i\'m', 'I am'],
  ['we\'re', 'we are'],
  ['they\'re', 'they are'],
  ['you\'re', 'you are'],
  ['we\'ve', 'we have'],
  ['they\'ve', 'they have'],
  ['you\'ve', 'you have'],
  ['i\'ve', 'I have'],
  ['we\'ll', 'we will'],
  ['they\'ll', 'they will'],
  ['you\'ll', 'you will'],
  ['i\'ll', 'I will'],
  ['he\'s', 'he is'],
  ['she\'s', 'she is'],
  ['didn\'t', 'did not'],
  ['hasn\'t', 'has not'],
  ['haven\'t', 'have not'],
  ['hadn\'t', 'had not'],
  ['we\'d', 'we would'],
  ['i\'d', 'I would'],
  ['they\'d', 'they would'],
  ['you\'d', 'you would'],
  ['shan\'t', 'shall not'],
  ['mustn\'t', 'must not'],
  ['needn\'t', 'need not'],
]);

const CONTRACTION_PATTERN = new RegExp(
  Array.from(contractionMap.keys())
    .map(k => k.replaceAll('\'', '[\'\u2019]'))
    .join('|'),
  'gi'
);

const SYNTHESIS_PROMPT_TEMPLATE = [
  'Synthesize the following sources into a single Jira ticket. Every sentence must earn its place; omit filler, redundancy, and preamble.\n',
  'Return ONLY a valid JSON object with no surrounding commentary or code fence. Do not wrap the output in markdown. The object must have exactly these fields:\n',
  '  "title": "<concise title — a short imperative phrase>",',
  '  "type": "<task|bug|story|epic|subtask>",',
  '  "priority": "<highest|high|medium|low|lowest>",',
  '  "description": "<full ticket body as a markdown string containing:\\n## Description\\n### Summary\\n...\\n#### Technical Details\\n...\\n### Acceptance Criteria\\n- criterion\\n### Risks & Assumptions\\n- risk\\n#### Out of Scope\\n- item>"\n',
  'Rules:',
  '- Write in formal British English throughout.',
  '- Do not use contractions (e.g., write "do not" instead of "don\'t", "cannot" instead of "can\'t").',
  '- Use the active voice (e.g., "The system validates input" instead of "Input is validated by the system").',
  '- Do not use informal or colloquial language (e.g., avoid "basically", "just", "a lot of", "pretty much").',
  '- Use third-person perspective only (e.g., do not use "you", "we", "our").',
  '- Use British English spelling (e.g., "behaviour", "colour", "organisation", "serialise").',
  '- Be concise: prefer short, direct sentences; remove filler words, redundant qualifiers, and unnecessary preamble.',
  '- Use fenced Markdown code blocks (```lang) for code samples within the description string; never use Jira wiki {code} syntax.',
  '- Use `- ` for every unordered bullet item within the description string; never use `* ` bullets.',
  '- The description field must be non-empty and include all the listed sub-sections.',
  '- JSON string values must not contain literal newline characters; use \\n for line breaks within strings.\n',
].join('\n');
interface IssueGenerateOptions {
  format?: OutputFormat;
  output?: string;
  save?: boolean;
  silent?: boolean;
  tracker?: string;
  title?: string;
  type?: string;
  priority?: string;
  repos?: string[];
  dryRun?: boolean;
}
type OutputFormat = 'json' | 'md' | 'yaml' | 'yml';

interface ResolvedRepo {
  input: string;
  basePath: string;
}

interface LocalSourceResolution {
  concreteSources: string[];
  matchedRepoInputs: string[];
}

interface SlackThreadSourceMatch {
  kind: 'thread';
  channelId: string;
  threadTs: string;
}

interface SlackChannelSourceMatch {
  kind: 'channel';
  channelId: string;
}

type SlackSourceMatch = SlackThreadSourceMatch | SlackChannelSourceMatch;

interface TrackerSourceMatch {
  ticketKey: string;
}

interface RepoDiscoveryContext {
  conventions?: RepoConventionsContext;
  priorPlans?: PriorPlanContext;
  planCorrelation?: PlanCorrelationResult;
  crossRepoPatterns?: CrossRepoContext;
}

class UnresolvedSourceError extends Error {}

/**
 * Command to generate ticket descriptions from multiple sources
 * Supports local files, repo-scoped artifacts via `--repos`, URLs, Jira keys,
 * and AI synthesis. Local `.md`, `.json`, `.yaml`, and `.yml` files that parse
 * as tickets are imported as tickets; files that are not recognized as
 * ticket-formatted content remain plain file sources. When `--repos` resolves
 * to a local checkout, bootstrap config is loaded from that repository before
 * command execution. Repo-scoped discovery inspects the full
 * `~/.wf/<repo>/` artifact tree for
 * plan artifacts and correlates them by keyword similarity so
 * planning prompts can reuse earlier implementation context. Generated
 * serialized output enforces formal writing conventions before display or save.
 */
@Command({
  name: 'issue:generate',
  description:
    'Generate ticket descriptions from local files, repo-scoped artifacts via --repos, URLs, or ticket keys. Tracker browse URLs (e.g., https://<org>.atlassian.net/browse/<KEY>) are automatically detected and fetched via the tracker REST API instead of scraping HTML; self-hosted instances are supported when atlassian.baseUrl is configured. Local .md, .json, .yaml, and .yml files that parse as tickets are imported as tickets; files that are not recognized as ticket-formatted content remain plain file sources. Repo-scoped generation inspects prior plan artifacts anywhere under ~/.wf/<repo>/**/* and correlates them by keyword similarity so synthesis prompts can reuse earlier implementation context. When multiple repos are supplied, the synthesis prompt also compares repo conventions, including linter and formatter rules, and git-hook tools across checkouts. AI synthesis always runs on every source to enrich and standardize the output. The AI is instructed to return a structured JSON object (title, type, priority, description) that is validated against the ticket schema before conversion to the requested output format. When agent or CLI backends are used, the provider session ID is threaded across oversized-source summarisation, clarification, and synthesis so all calls share coherent context. Generated output enforces formal writing conventions (concise prose, no contractions, active voice, British English) before display or save. Blank AI generate-stage responses fail fast with provider-aware diagnostics. Can use an agent backend when stages.generate.backend is set to agent',
  arguments: '<sources...>',
  options: { isDefault: false },
})
export class IssueGenerateCommand extends CommandRunner {
  constructor(
    private readonly issueTrackerService: IssueTrackerService,
    private readonly formatConverterService: FormatConverterService,
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly slackService: SlackService,
    private readonly stageAgentService: StageAgentService
  ) {
    super();
  }

  async run(passedParams: string[], options?: IssueGenerateOptions): Promise<void> {
    if (!options?.silent) {
      printCommandHeader('issue:generate');
    }
    await ensureWfHome();

    await executeAsyncWithCatch({ fn: async () => {
      if (!passedParams || passedParams.length === 0) {
        throw new ValidationError('At least one source is required. Use --ticket, --file, or --url.');
      }

      if (options?.dryRun) return this.previewGenerateDryRun(passedParams, options);

      await this.executeGenerate(passedParams, options);
    } });
  }

  private async previewGenerateDryRun(sources: string[], options: IssueGenerateOptions): Promise<void> {
    const format = options?.format || this.configService.get<string>('stages.generate.outputFormat') || 'md';
    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    const artifactBaseDir = resolveRepoBasePath(options?.repos?.[0]);

    this.dryRunPreview.showHeader('issue:generate', `${sources.length} source(s)`);

    let apiCallCount = await this.previewDryRunSources(sources, options, trackerName, artifactBaseDir);
    apiCallCount += this.previewSynthesisApiCall(sources.length);

    const fileCreatedCount = this.previewDryRunOutputFiles(sources, options, format, trackerName, artifactBaseDir);

    this.dryRunPreview.showSummary({
      apiCallCount, fileCreatedCount, fileModifiedCount: 0, gitOperationCount: 0,
      terminalOutputLines: this.buildDryRunTerminalLines(options),
    });
    this.dryRunPreview.showValidationResult();
  }

  private async previewDryRunSources(
    sources: string[], options: IssueGenerateOptions, trackerName: string, artifactBaseDir: string
  ): Promise<number> {
    let count = 0;
    for (const source of sources) {
      const resolvedSources = await this.resolveSourceInputs(source, options?.repos, options?.silent ?? false);
      this.assertResolvableSourceSelection(source, resolvedSources, options?.repos);
      for (const resolvedSource of resolvedSources) {
        count += this.previewDryRunSource(resolvedSource, trackerName, artifactBaseDir);
      }
    }
    return count;
  }

  private previewSynthesisApiCall(sourceCount: number): number {
    this.dryRunPreview.previewApiCall({
      method: 'POST', endpoint: this.aiService.getProviderEndpoint('generate'),
      platform: this.aiService.getProviderDisplayName('generate'),
      description: `Synthesise ${sourceCount} source(s) into a unified ticket`,
      estimatedResponse: '{\n  "title": "<synthesized title>",\n  "type": "task",\n  "priority": "medium",\n  "description": "<synthesized from sources>"\n}',
    });
    return 1;
  }

  private previewDryRunOutputFiles(
    sources: string[], options: IssueGenerateOptions, format: string, trackerName: string, artifactBaseDir: string
  ): number {
    const preview = '# <synthesized title>\n\n**Type:** task\n**Priority:** medium\n\n## Description\n\n<synthesized from sources>';
    let count = 0;
    if (options?.save) {
      count += this.previewSaveArtifacts(sources, format, trackerName, artifactBaseDir, preview);
    }
    if (options?.output) {
      this.dryRunPreview.previewFileWrite({
        filePath: path.resolve(options.output), operation: 'create', sizeEstimate: '2–10 KB', format, contentPreview: preview,
      });
      count++;
    }
    return count;
  }

  private previewSaveArtifacts(
    sources: string[], format: string, trackerName: string, baseDir: string, preview: string
  ): number {
    const timestamp = new Date();
    const artifactFilename = buildGeneratedTicketArtifactFilename(timestamp, sources, format);
    const dir = resolveArtifactDir(baseDir, trackerName);
    const filePath = path.join(dir, artifactFilename);
    this.dryRunPreview.previewFileWrite({ filePath, operation: 'create', sizeEstimate: '2–10 KB', format, contentPreview: preview });
    const manifest = buildGeneratedTicketSourceManifest(filePath, trackerName, format, sources, timestamp);
    this.dryRunPreview.previewFileWrite({
      filePath: path.join(dir, buildGeneratedTicketManifestFilename(artifactFilename)),
      operation: 'create', sizeEstimate: '1–2 KB', format: 'json',
      contentPreview: JSON.stringify(manifest, null, 2),
    });
    return 2;
  }

  private buildDryRunTerminalLines(options?: IssueGenerateOptions): string[] {
    return [
      ...(options?.save ? ['✔ Ticket saved to: <tracker-dir>/YYYY-MM-DD-<hash>-ticket-description.<format>'] : []),
      ...(options?.output ? [`✔ Ticket also saved to: ${path.resolve(options.output)}`] : []),
      ...(!options?.save && !options?.output ? ['✔ Generated Ticket:', '', '  <ticket content printed to stdout>'] : []),
    ];
  }

  private async executeGenerate(sources: string[], options?: IssueGenerateOptions): Promise<void> {
    const silent = options?.silent ?? false;
    const onProgress = silent ? undefined : (line: string) => console.log(chalk.gray(line));

    if (!silent) console.log(chalk.bold.cyan(`\n📝 Generating Ticket from ${sources.length} source(s)\n`));

    const sourceContents = await this.fetchAllSources(sources, options?.tracker, options?.repos, silent);
    this.assertSourcesAvailable(sourceContents, sources);
    let generateSessionId = await this.summariseOversizedSources(sourceContents, silent, onProgress);
    generateSessionId = await this.gatherClarifications(sourceContents, silent, onProgress, generateSessionId);

    const repoContext = await this.gatherRepoContext(options?.repos, sourceContents);
    const synthesizedTicket = await this.synthesizeWithAI(
      sourceContents, silent, repoContext, onProgress, generateSessionId
    );

    this.applyMetadataOverrides(synthesizedTicket, options);
    this.normalizeTicketTextFields(synthesizedTicket);

    const format = options?.format || this.configService.get<string>('stages.generate.outputFormat') || 'md';
    const output = this.buildSerializedOutput(synthesizedTicket, format);

    await this.outputResults(synthesizedTicket, output, format, sources, silent, options);
    this.assertNoContractionsInSerializedOutput(output, 'stdout/file output');
  }

  private async gatherClarifications(
    sourceContents: SourceContent[], silent: boolean,
    onProgress?: (line: string) => void, resumeSessionId?: string
  ): Promise<string | undefined> {
    if (silent || !this.isInteractiveSession()) return resumeSessionId;

    const { questions, sessionId } = await this.identifyClarifications(sourceContents, onProgress, resumeSessionId);
    if (questions.length === 0) return sessionId;

    const userResponses = await this.promptClarifications(questions);
    sourceContents.push({ type: 'file', source: 'user-clarifications', content: userResponses });
    return sessionId;
  }

  private applyMetadataOverrides(ticket: UniversalTicket, options?: IssueGenerateOptions): void {
    if (options?.title) ticket.title = options.title;
    if (options?.type) ticket.type = options.type as TicketType;
    if (options?.priority) ticket.priority = options.priority as any;
  }

  private async outputResults(
    ticket: UniversalTicket, output: string, format: string,
    sources: string[], silent: boolean, options?: IssueGenerateOptions
  ): Promise<void> {
    if (options?.save) {
      await this.saveGeneratedTicket(ticket, format, sources, silent, options);
    }

    if (options?.output) {
      const outputPath = path.resolve(options.output);
      fs.writeFileSync(outputPath, output);
      console.log(silent ? outputPath : `${chalk.green('\n✔ Ticket also saved to:')} ${chalk.cyan(outputPath)}`);
    }
    if (!options?.save && !options?.output) {
      if (!silent) console.log(chalk.green('\n✔ Generated Ticket:\n'));
      console.log(output);
    }

    if (!silent) {
      console.log(chalk.gray('\n💡 Tip: Use --save to save to tracker directory, --output to save to file, or --format to change output format\n'));
    }
  }

  private async saveGeneratedTicket(
    ticket: UniversalTicket, format: string, sources: string[], silent: boolean, options?: IssueGenerateOptions
  ): Promise<void> {
    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    const saveTargets = await this.resolveSaveTargets(options?.repos, silent);
    const targetRepos = saveTargets.length > 0 ? saveTargets : [undefined];

    for (const targetRepo of targetRepos) {
      const savedPath = await this.saveTicketLocally(ticket, trackerName, format, sources, targetRepo);
      console.log(silent ? savedPath : `${chalk.green('\n✔ Ticket saved to:')} ${chalk.cyan(savedPath)}`);
    }
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the generate operation without making changes',
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
    flags: '-o, --output <path>',
    description: 'Output file path - default: stdout',
  })
  parseOutput(val: string): string {
    return val;
  }

  @Option({
    flags: '--priority <priority>',
    description: 'Override ticket priority (highest|high|medium|low|lowest)',
  })
  parsePriority(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; the first repo anchors artifact storage and read context, remaining repos provide additional read context for the AI. Names resolve from cwd, a sibling directory, then $WF_REPOS_DIR (default: $HOME/Apps, Projects, apps, projects)',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '--save',
    description: 'Save generated ticket to tracker directory',
  })
  parseSave(): boolean {
    return true;
  }

  @Option({
    flags: '-s, --silent',
    description:
      'Suppress decorative output and interactive prompts (clarification, disambiguation). Emits only file paths (with --save/--output) or raw ticket content for piping',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '-t, --title <title>',
    description: 'Override generated title with custom title',
  })
  parseTitle(val: string): string {
    return val;
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description: 'Tracker for ticket sources (jira|github|bitbucket)',
  })
  parseTracker(val: string): string {
    return val;
  }

  @Option({
    flags: '--type <type>',
    description: 'Override ticket type (task|bug|story|epic)',
  })
  parseType(val: string): string {
    return val;
  }

  /**
   * Fetch content from all sources
   */
  private async fetchAllSources(
    sources: string[],
    tracker?: string,
    repos?: string[],
    silent = false
  ): Promise<SourceContent[]> {
    const contents: SourceContent[] = [];
    for (const source of sources) {
      if (!silent) console.log(chalk.gray('  Fetching: ' + source));
      const fetched = await this.fetchSingleSource(source, tracker, repos, silent);
      contents.push(...fetched);
    }
    return contents;
  }

  private async fetchSingleSource(
    source: string, tracker?: string, repos?: string[], silent = false
  ): Promise<SourceContent[]> {
    try {
      const resolved = await this.resolveSourceInputs(source, repos, silent);
      this.assertResolvableSourceSelection(source, resolved, repos);
      if (resolved.length === 0) {
        if (!silent) console.log(chalk.yellow('    ⚠ Skipped: no sources selected'));
        return [];
      }
      return this.fetchResolvedSources(resolved, tracker, repos?.[0], silent);
    } catch (error) {
      if (error instanceof UnresolvedSourceError) throw error;
      if (!silent) console.log(chalk.yellow('    ⚠ Failed: ' + error.message));
      return [];
    }
  }

  private async fetchResolvedSources(
    resolved: string[], tracker?: string, repo?: string, silent = false
  ): Promise<SourceContent[]> {
    const contents: SourceContent[] = [];
    for (const resolvedSource of resolved) {
      const content = await this.fetchSource(resolvedSource, tracker, repo);
      contents.push(content);
      if (!silent) console.log(chalk.green('    ✔ Fetched (' + content.type + ')'));
    }
    return contents;
  }

  /**
   * Ensure there is usable source material before invoking AI synthesis.
   *
   * @param contents - Successfully fetched source contents
   * @param sources - Raw source arguments for error reporting
   * @returns Nothing; throws when all source fetches failed
   */
  private assertSourcesAvailable(contents: SourceContent[], sources: string[]): void {
    if (contents.length > 0) {
      return;
    }

    throw new ExecutionError(
      `Failed to fetch usable content from ${sources.length} source(s). ` + 'Resolve the source access issue and retry.'
    );
  }

  /**
   * Fetch content from a single source
   */
  private async fetchSource(source: string, tracker?: string, repo?: string): Promise<SourceContent> {
    const slack = this.parseSlackSource(source);
    if (slack?.kind === 'thread') return this.fetchFromSlack(source, slack.channelId, slack.threadTs, repo);
    if (slack?.kind === 'channel') return this.fetchFromSlackChannel(source, slack.channelId, repo);

    const trackerMatch = this.parseTrackerSource(source);
    if (trackerMatch) return this.fetchFromTracker(trackerMatch.ticketKey, tracker, repo);
    if (source.startsWith('http://') || source.startsWith('https://')) return this.fetchFromUrl(source);
    if (fs.existsSync(source)) return this.fetchFromFile(source);
    if (/^[A-Z]+-\d+$/i.test(source)) return this.fetchFromTracker(source, tracker, repo);

    throw new ValidationError(
      'Unknown source type: ' + source + '. Supported: URL, local file path, ticket key (ABC-123), Slack thread URL'
    );
  }

  /**
   * Fetch content from a Slack thread permalink
   */
  private async fetchFromSlack(
    source: string,
    channelId: string,
    threadTs: string,
    repo?: string
  ): Promise<SourceContent> {
    const result = await this.slackService.fetchThread(channelId, threadTs);
    const threadId = this.normalizeSlackTimestamp(threadTs);
    const formattedText = this.formatSlackMessages(result.messages);
    await this.writeSlackArtifact(repo, `slack-thread-${channelId}-${threadId}.md`, formattedText);
    return { type: 'slack', source, content: formattedText };
  }

  /**
   * Fetch content from a Slack channel archive URL.
   */
  private async fetchFromSlackChannel(source: string, channelId: string, repo?: string): Promise<SourceContent> {
    const result = await this.slackService.fetchChannelHistory(channelId, SLACK_CHANNEL_HISTORY_LIMIT);
    const formattedText = this.formatSlackMessages(result.messages);
    const conversationTs = this.getSlackConversationArtifactTs(result.messages);
    await this.writeSlackArtifact(repo, `slack-thread-${channelId}-${conversationTs}.md`, formattedText);
    return { type: 'slack', source, content: formattedText };
  }

  /**
   * Fetch content from URL
   */
  private async fetchFromUrl(url: string): Promise<SourceContent> {
    const response = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
    });

    return {
      type: 'url',
      source: url,
      content: response.data,
    };
  }

  /**
   * Fetch content from local file
   */
  private async fetchFromFile(filePath: string): Promise<SourceContent> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();

    if (['.json', '.yaml', '.yml', '.md'].includes(ext)) {
      const ticket = this.tryParseAsTicket(filePath, content);
      if (ticket) {
        return { type: 'ticket', source: filePath, content, ticket };
      }
    }

    return {
      type: 'file',
      source: filePath,
      content: content,
    };
  }

  /**
   * Attempt to parse file content as a ticket via format detection.
   * Returns null when the format is unrecognized or parsing fails.
   *
   * @param filePath - Path used for format detection
   * @param content - Raw file content
   * @returns Parsed ticket or null
   */
  private tryParseAsTicket(filePath: string, content: string): UniversalTicket | null {
    const format = this.formatConverterService.detectFormat(filePath);
    if (!format) return null;

    const converter = this.formatConverterService.getConverter(format);
    try {
      return converter.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Fetch ticket from tracker (Jira, GitHub, BitBucket)
   */
  private async fetchFromTracker(ticketKey: string, tracker?: string, repo?: string): Promise<SourceContent> {
    try {
      const adapter = tracker
        ? this.issueTrackerService.getAdapter(tracker)
        : this.issueTrackerService.getDefaultAdapter();

      const ticketReference
        = tracker === 'bitbucket' && repo ? this.formatBitbucketReference(ticketKey, repo, this.configService) : ticketKey;

      const ticket = await adapter.getTicket(ticketReference);

      return {
        type: 'tracker',
        source: ticketKey,
        content: `${ticket.title}\n\n${ticket.description}`,
        ticket: ticket,
      };
    } catch (error) {
      throw new ExecutionError(`Failed to fetch ticket ${ticketKey} from platform: ${(error as Error).message}`);
    }
  }

  /**
   * Convert Slack messages into the text format used for synthesis artifacts.
   *
   * @param messages - Slack messages to serialize
   * @returns Readable plain-text conversation content
   */
  private formatSlackMessages(messages: Array<{ user: string; ts: string; text: string }>): string {
    return [...messages]
      .sort((left, right) => this.compareSlackTimestamps(left.ts, right.ts))
      .map(message => `[${message.ts}] ${message.user}: ${message.text}`)
      .join('\n');
  }

  /**
   * Pick a deterministic timestamp anchor for Slack conversation artifacts.
   *
   * Bare Slack archive URLs do not include a message timestamp, so use the
   * earliest fetched message to keep artifact names stable and chronological.
   *
   * @param messages - Slack messages returned for the conversation
   * @returns Normalized Slack timestamp for the artifact filename
   */
  private getSlackConversationArtifactTs(messages: Array<{ ts: string }>): string {
    if (messages.length === 0) {
      return 'no-messages';
    }

    const earliestMessage = [...messages].sort((left, right) => this.compareSlackTimestamps(left.ts, right.ts))[0];

    return this.normalizeSlackTimestamp(earliestMessage.ts);
  }

  /**
   * Preview a single resolved source for dry-run mode.
   * @returns 1 when an API call was previewed, 0 otherwise
   */
  private previewDryRunSource(source: string, trackerName: string, baseDir: string): number {
    const slack = this.parseSlackSource(source);
    if (slack?.kind === 'thread') return this.previewSlackThread(source, slack, baseDir);
    if (slack?.kind === 'channel') return this.previewSlackChannel(source, slack, baseDir);
    if (source.startsWith('http://') || source.startsWith('https://')) return this.previewUrlSource(source);
    if (/^[A-Z]+-\d+$/i.test(source)) return this.previewTrackerSource(source, trackerName);
    if (fs.existsSync(source)) {
      this.dryRunPreview.previewFileRead({
        filePath: path.resolve(source), exists: true,
        sizeInKb: (fs.statSync(source).size / 1024).toFixed(2),
      });
    }
    return 0;
  }

  private previewSlackThread(
    source: string, match: { channelId: string; threadTs: string }, baseDir: string
  ): number {
    const [seconds, micros] = match.threadTs.split('.');
    this.dryRunPreview.previewApiCall({
      method: 'GET', endpoint: 'https://slack.com/api/conversations.replies', platform: 'Slack',
      description: 'Fetch thread ' + source, estimatedResponse: '200 OK — thread messages JSON',
    });
    const fileName = 'slack-thread-' + match.channelId + '-' + seconds + '-' + micros + '.md';
    this.dryRunPreview.previewFileWrite({
      filePath: path.join(resolveArtifactDir(baseDir, 'slack'), fileName),
      operation: 'create', sizeEstimate: '1–20 KB', format: 'md',
      contentPreview: '[<ts>] <user>: <message>\n[<ts>] <user>: <reply>',
    });
    return 1;
  }

  private previewSlackChannel(source: string, match: { channelId: string }, baseDir: string): number {
    this.dryRunPreview.previewApiCall({
      method: 'GET', endpoint: 'https://slack.com/api/conversations.history', platform: 'Slack',
      description: 'Fetch recent channel history ' + source,
      estimatedResponse: '200 OK — channel messages JSON',
    });
    const fileName = 'slack-thread-' + match.channelId + '-<oldest-message-ts>.md';
    this.dryRunPreview.previewFileWrite({
      filePath: path.join(resolveArtifactDir(baseDir, 'slack'), fileName),
      operation: 'create', sizeEstimate: '1–20 KB', format: 'md',
      contentPreview: '[<ts>] <user>: <message>\n[<ts>] <user>: <message>',
    });
    return 1;
  }

  private previewUrlSource(source: string): number {
    this.dryRunPreview.previewApiCall({
      method: 'GET', endpoint: source, platform: 'Web',
      description: 'Fetch content from URL', estimatedResponse: '200 OK — HTML / text content',
    });
    return 1;
  }

  private previewTrackerSource(source: string, trackerName: string): number {
    this.dryRunPreview.previewApiCall({
      method: 'GET', endpoint: '/' + trackerName + '/issues/' + source, platform: trackerName,
      description: 'Fetch ticket ' + source, estimatedResponse: '200 OK — ticket data',
    });
    return 1;
  }

  /**
   * Compare Slack timestamps numerically while preserving sub-second ordering.
   *
   * @param leftTs - First Slack timestamp
   * @param rightTs - Second Slack timestamp
   * @returns Negative when left is earlier, positive when right is earlier
   */
  private compareSlackTimestamps(leftTs: string, rightTs: string): number {
    const leftValue = Number(leftTs);
    const rightValue = Number(rightTs);

    return leftValue - rightValue;
  }

  /**
   * Convert a Slack timestamp into the filename-safe form used by artifacts.
   *
   * @param timestamp - Slack timestamp, usually in seconds.microseconds form
   * @returns Timestamp string safe for file naming
   */
  private normalizeSlackTimestamp(timestamp: string): string {
    return timestamp.replace('.', '-');
  }

  /**
   * Persist fetched Slack content to the existing artifact namespace.
   *
   * @param repo - Optional repo namespace for artifacts
   * @param fileName - Artifact filename
   * @param content - Slack content to save
   * @returns Nothing
   */
  private async writeSlackArtifact(repo: string | undefined, fileName: string, content: string): Promise<void> {
    const artifactDir = resolveArtifactDir(resolveRepoBasePath(repo), 'slack');
    await fs.promises.mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, fileName);
    await fs.promises.writeFile(artifactPath, content, 'utf-8');
    console.log(chalk.gray(`  Artifact: ${artifactPath}`));
  }

  /**
   * Save ticket to tracker directory with generated filename
   */
  private async saveTicketLocally(
    ticket: UniversalTicket, trackerName: string, format: string, sources: string[], repo?: string
  ): Promise<string> {
    const trackerDir = resolveArtifactDir(resolveRepoBasePath(repo), trackerName);
    await fs.promises.mkdir(trackerDir, { recursive: true });

    const timestamp = new Date();
    const artifactPath = this.resolveArtifactPath(trackerDir, sources, format, timestamp);

    this.normalizeTicketTextFields(ticket);
    const content = this.buildSerializedOutput(ticket, format);
    await fs.promises.writeFile(artifactPath, content, 'utf-8');
    await this.writeManifest(artifactPath, trackerName, format, sources, timestamp);
    this.assertNoContractionsInSerializedOutput(content, 'saved artifact for ' + trackerName);

    return artifactPath;
  }

  private resolveArtifactPath(dir: string, sources: string[], format: string, timestamp: Date): string {
    const hash8 = hashGeneratedTicketSources(sources);
    const extension = format === 'md' ? 'md' : format;
    const pattern = new RegExp(String.raw`^\d{4}-\d{2}-\d{2}-` + hash8 + String.raw`-ticket-description\.` + extension + '$');
    const existing = fs.readdirSync(dir).find(name => pattern.test(name));
    if (existing) return path.join(dir, existing);
    return path.join(dir, buildGeneratedTicketArtifactFilename(timestamp, sources, format));
  }

  private async writeManifest(
    artifactPath: string, trackerName: string, format: string, sources: string[], timestamp: Date
  ): Promise<void> {
    const manifestPath = buildGeneratedTicketManifestPath(artifactPath);
    const manifest = buildGeneratedTicketSourceManifest(artifactPath, trackerName, format, sources, timestamp);
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  /**
   * Resolve a raw source argument into concrete sources for fetching.
   *
   * Filename-only sources are checked against repo-scoped `~/.wf/<repo>/`
   * artifacts when `--repos` is supplied. When no `--repos` is provided,
   * falls back to `~/.wf/<cwd-basename>/<source>` (artifact dir inferred
   * from cwd).
   *
   * @param source - Raw CLI source argument
   * @param repos - Optional repos supplied via `--repos`
   * @param silent - When true, fail instead of prompting on ambiguity
   * @returns Resolved source paths or original non-file source
   */
  private async resolveSourceInputs(source: string, repos?: string[], silent = false): Promise<string[]> {
    if (this.isNonFileSource(source)) return [source];
    if (path.isAbsolute(source) && fs.existsSync(source)) return [source];

    const resolvedRepoSources = await this.resolveRepoRelativeSources(source, repos, silent);
    if (resolvedRepoSources.concreteSources.length > 0) return resolvedRepoSources.concreteSources;

    if (!path.isAbsolute(source)) {
      const cwdArtifactPath = path.join(resolveCustomArtifactDir(process.cwd()), source);
      if (fs.existsSync(cwdArtifactPath)) return [cwdArtifactPath];
    }

    return [];
  }

  private isNonFileSource(source: string): boolean {
    return this.parseSlackSource(source) !== null
      || this.parseTrackerSource(source) !== null
      || source.startsWith('http://')
      || source.startsWith('https://')
      || /^[A-Z]+-\d+$/i.test(source);
  }

  /**
   * Raise a specific error when a local-looking source cannot be resolved.
   *
   * @param source - Raw CLI source argument
   * @param resolvedSources - Concrete paths or identifiers derived from the source
   * @param repos - Optional repos supplied via `--repos`
   * @returns Nothing; throws when the source should surface actionable guidance
   */
  private assertResolvableSourceSelection(source: string, resolvedSources: string[], repos?: string[]): void {
    if (resolvedSources.length > 0) {
      return;
    }

    if (!this.isUnresolvedLocalSourceCandidate(source, repos)) {
      return;
    }

    throw new UnresolvedSourceError(this.buildUnresolvedSourceMessage(source, repos));
  }

  /**
   * Check whether a source token should receive local artifact guidance.
   *
   * @param source - Raw CLI source argument
   * @param repos - Optional repos supplied via `--repos`
   * @returns True when the unresolved source looks like a local artifact/file
   */
  private isUnresolvedLocalSourceCandidate(source: string, repos?: string[]): boolean {
    if (repos?.length) {
      return false;
    }

    return !(path.isAbsolute(source)
      || this.parseSlackSource(source) !== null
      || this.parseTrackerSource(source) !== null
      || source.startsWith('http://')
      || source.startsWith('https://')
      || /^[A-Z]+-\d+$/i.test(source));
  }

  /**
   * Build the actionable error shown when a local artifact name cannot resolve.
   *
   * @param source - Raw CLI source argument
   * @param repos - Optional repos supplied via `--repos`
   * @returns User-facing error message
   */
  private buildUnresolvedSourceMessage(source: string, repos?: string[]): string {
    const suggestedRepo = repos?.[0] ?? path.basename(resolveRepoBasePath(repos?.[0]));

    return (
      `Source "${source}" could not be resolved from the current directory. `
      + 'If this is a repo-scoped artifact under ~/.wf/<repo>/, re-run with '
      + `--repos <repo> (for example: wf issue:generate ${source} -r ${suggestedRepo}).`
    );
  }

  /**
   * Resolve a relative source against the repositories supplied via `--repos`.
   *
   * @param source - Raw relative source path
   * @param repos - Optional repos supplied via `--repos`
   * @param silent - When true, fail instead of prompting on ambiguity
   * @returns Concrete source paths plus the matching repo identifiers
   */
  private async resolveRepoRelativeSources(
    source: string, repos?: string[], silent = false
  ): Promise<LocalSourceResolution> {
    if (!repos?.length || path.isAbsolute(source)) return { concreteSources: [], matchedRepoInputs: [] };

    const matches = this.findRepoSourceMatches(source, repos);
    if (matches.length === 0) return { concreteSources: [], matchedRepoInputs: [] };
    if (matches.length === 1) {
      return { concreteSources: [matches[0].filePath], matchedRepoInputs: [matches[0].repoInput] };
    }

    this.assertCanDisambiguate(source, matches, silent);
    return this.promptSourceSelection(source, matches);
  }

  private findRepoSourceMatches(
    source: string, repos: string[]
  ): Array<{ repoInput: string; filePath: string }> {
    return this.resolveRepos(repos)
      .map(repo => this.findSourceInRepo(source, repo))
      .filter((match): match is { repoInput: string; filePath: string } => match !== null);
  }

  private findSourceInRepo(
    source: string, repo: { input: string; basePath: string }
  ): { repoInput: string; filePath: string } | null {
    const artifactPath = path.join(resolveCustomArtifactDir(repo.basePath), source);
    if (fs.existsSync(artifactPath)) return { repoInput: repo.input, filePath: artifactPath };
    const repoPath = path.join(repo.basePath, source);
    if (fs.existsSync(repoPath)) return { repoInput: repo.input, filePath: repoPath };
    return null;
  }

  private assertCanDisambiguate(
    source: string, matches: Array<{ repoInput: string }>, silent: boolean
  ): void {
    const repoList = matches.map(m => m.repoInput).join(', ');
    if (!this.isInteractiveSession()) {
      throw new ValidationError(
        'Source "' + source + '" matches multiple repositories: ' + repoList
        + '. Re-run in an interactive terminal or pass a single unambiguous --repos value.'
      );
    }
    if (silent) {
      throw new ValidationError(
        'Source "' + source + '" matches multiple repositories: ' + repoList
        + '. Pass a single unambiguous --repos value in silent mode.'
      );
    }
  }

  private async promptSourceSelection(
    source: string, matches: Array<{ repoInput: string; filePath: string }>
  ): Promise<LocalSourceResolution> {
    const answers = await inquirer.prompt([{
      type: 'checkbox', name: 'selectedSources',
      message: 'Select matching files for ' + source + ':',
      prefix: ' ',
      choices: matches.map(m => ({ name: m.repoInput + ': ' + m.filePath, value: m.filePath })),
    }]);
    const selected = (answers.selectedSources ?? []) as string[];
    const repoInputs = matches.filter(m => selected.includes(m.filePath)).map(m => m.repoInput);
    return { concreteSources: selected, matchedRepoInputs: repoInputs };
  }

  /**
   * Parse a Slack source URL into the supported thread or channel forms.
   * Query params on Slack permalinks are ignored so pasted thread URLs still
   * resolve to the existing thread-fetch flow.
   *
   * @param source - Raw CLI source argument
   * @returns Slack source metadata when the URL is supported; otherwise null
   */
  private parseSlackSource(source: string): SlackSourceMatch | null {
    if (!URL.canParse(source)) return null;
    const url = new URL(source);
    if (!url.hostname.endsWith('.slack.com')) return null;

    const thread = new RegExp(SLACK_THREAD_PATH).exec(url.pathname);
    if (thread) {
      return { kind: 'thread', channelId: thread[1], threadTs: thread[2] + '.' + thread[3] };
    }

    const channel = new RegExp(SLACK_CHANNEL_PATH).exec(url.pathname);
    if (channel) return { kind: 'channel', channelId: channel[1] };

    return null;
  }

  /**
   * Parse a tracker browse URL into its ticket key.
   *
   * @param source - Raw CLI source argument
   * @returns Parsed ticket key or null if the source is not a tracker browse URL
   */
  private parseTrackerSource(source: string): TrackerSourceMatch | null {
    if (!URL.canParse(source)) return null;
    const parsedUrl = new URL(source);

    const configuredBaseUrl = this.configService.get<string>('atlassian.baseUrl');
    const configuredHostname
      = configuredBaseUrl && URL.canParse(configuredBaseUrl) ? new URL(configuredBaseUrl).hostname : null;

    const isConfiguredHost = configuredHostname !== null && parsedUrl.hostname === configuredHostname;
    const isWellKnownHost = parsedUrl.hostname.endsWith('.atlassian.net');

    if (!isConfiguredHost && !isWellKnownHost) {
      return null;
    }

    const browseMatch = new RegExp(JIRA_BROWSE_PATH).exec(parsedUrl.pathname);
    if (!browseMatch) {
      return null;
    }

    return { ticketKey: browseMatch[1] };
  }

  /**
   * Resolve save targets for `--save`.
   *
   * @param repos - Optional repos supplied via `--repos`
   * @param silent - When true, fail instead of prompting on ambiguity
   * @returns Repo identifiers to use as artifact namespaces
   */
  private async resolveSaveTargets(repos?: string[], silent = false): Promise<string[]> {
    if (!repos?.length) return [];

    const resolved = this.resolveRepos(repos);
    if (resolved.length <= 1) return resolved.map(r => r.input);

    this.assertSaveNotAmbiguous(resolved, silent);
    return this.promptSaveRepoSelection(resolved);
  }

  private assertSaveNotAmbiguous(
    repos: Array<{ input: string }>, silent: boolean
  ): void {
    const repoList = repos.map(r => r.input).join(', ');
    if (!this.isInteractiveSession()) {
      throw new ValidationError(
        'Cannot save to multiple repositories in a non-interactive session. Matching repositories: ' + repoList + '.'
      );
    }
    if (silent) {
      throw new ValidationError(
        'Cannot save to multiple repositories in silent mode. Matching repositories: ' + repoList + '.'
      );
    }
  }

  private async promptSaveRepoSelection(
    repos: Array<{ input: string; basePath: string }>
  ): Promise<string[]> {
    const answers = await inquirer.prompt([{
      type: 'checkbox', name: 'selectedRepos',
      message: 'Select repositories to save the generated artifact into:',
      prefix: ' ',
      choices: repos.map(r => ({ name: r.input + ': ' + r.basePath, value: r.input })),
      validate: (sel: string[]) => sel.length > 0 || 'Select at least one repository to save the generated artifact.',
    }]);
    return answers.selectedRepos as string[];
  }

  /**
   * Resolve each repo identifier to a real local directory.
   *
   * @param repos - Raw repo identifiers from `--repos`
   * @returns Resolved repo directories in input order
   */
  private resolveRepos(repos: string[]): ResolvedRepo[] {
    return repos.flatMap(repo => {
      const resolvedRepo = this.resolveRepoDirectory(repo);
      if (!resolvedRepo) {
        console.log(
          chalk.yellow(`⚠ Repository '${repo}' not found as a path, sibling directory, or under any repos directory.`)
        );
        return [];
      }

      return [{ input: repo, basePath: resolvedRepo }];
    });
  }

  /**
   * Resolve a repo identifier to a local directory without falling back to cwd.
   *
   * @param repo - Repository identifier from `--repos`
   * @returns Absolute repo path, or undefined when not found
   */
  private resolveRepoDirectory(repo: string): string | undefined {
    return resolveExistingRepoDir(repo, process.cwd()) ?? undefined;
  }

  /**
   * Check whether the current session can show interactive prompts.
   *
   * @returns True when both stdin and stdout are TTYs
   */
  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  /**
   * Summarize and interactively review any source whose content exceeds
   * MAX_SOURCE_CONTENT_LENGTH. Replaces the source content in-place with
   * the approved summary.
   *
   * @param sources - Fetched source contents (mutated in place)
   * @param silent - Whether to suppress interactive output
   * @param onProgress - Optional callback for real-time progress lines from agent backends
   */
  private async summariseOversizedSources(
    sources: SourceContent[], silent: boolean, onProgress?: (line: string) => void
  ): Promise<string | undefined> {
    let lastSessionId: string | undefined;
    for (let i = 0; i < sources.length; i += 1) {
      const raw = typeof sources[i].content === 'string' ? sources[i].content : JSON.stringify(sources[i].content);
      if (raw.length <= MAX_SOURCE_CONTENT_LENGTH) continue;

      this.warnOversizedSource(i, sources[i].source, raw.length, silent);
      const { summary, sessionId } = await this.summariseOversizedSource(sources[i], onProgress, lastSessionId);
      lastSessionId = sessionId;
      sources[i].content = (!silent && this.isInteractiveSession())
        ? await this.reviewSummaryBullets(summary, sources[i])
        : summary;
    }
    return lastSessionId;
  }

  private warnOversizedSource(index: number, source: string, lengthInChars: number, silent: boolean): void {
    if (silent) return;
    console.log(chalk.yellow(
      '\n    Warning: Source ' + (index + 1) + ' (' + source + ') exceeds '
      + MAX_SOURCE_CONTENT_LENGTH + ' characters (' + lengthInChars + '). Summarising...\n'
    ));
  }

  /**
   * Summarize a source whose content exceeds MAX_SOURCE_CONTENT_LENGTH.
   * Returns a bullet-point summary produced by the AI.
   *
   * @param source - The oversized source
   * @param onProgress - Optional callback for real-time progress lines from agent backends
   * @returns Bullet-point summary string
   */
  private async summariseOversizedSource(
    source: SourceContent, onProgress?: (line: string) => void, resumeSessionId?: string
  ): Promise<{ summary: string; sessionId?: string }> {
    const prompt = this.buildOversizedSourcePrompt(source);
    if (this.stageAgentService.isEnabledForStage('generate')) {
      const { content, sessionId } = await this.stageAgentService.generateFromPrompt(
        prompt, onProgress, resumeSessionId
      );
      return { summary: content.trim(), sessionId };
    }
    const response = await this.aiService.execute({ prompt, maxTokens: 2048, stage: 'generate' });
    return { summary: requireAiResponseContent(response, 'AI provider returned an empty summary response') };
  }

  private buildOversizedSourcePrompt(source: SourceContent): string {
    const raw = typeof source.content === 'string' ? source.content : JSON.stringify(source.content);
    return `Summarise the following source into concise bullet points. `
      + `Preserve technical precision — error messages, config values, identifiers, and commands `
      + `matter as much as narrative. Cover facts, decisions, root causes, timeline, and actions. `
      + `Return ONLY a Markdown bullet list (- item).\n\n`
      + `### Source: ${source.source} (${source.type})\n`
      + `\`\`\`\n${raw}\n\`\`\``;
  }

  /**
   * Present AI-generated summary bullets for interactive approval.
   * The user can accept (Y) or reject (n) each bullet, and can type
   * free-form messages to request re-summarization of specific content.
   *
   * @param summary - AI-generated bullet-point summary
   * @param source - Original source (for re-summarization context)
   * @returns Approved summary string
   */
  private async reviewSummaryBullets(summary: string, source: SourceContent): Promise<string> {
    const bullets = this.parseBullets(summary);
    const raw = typeof source.content === 'string' ? source.content : JSON.stringify(source.content);

    console.log(chalk.cyan('\n  Review the summarised key points:\n'));
    const approved = await this.promptBulletApproval(bullets);
    await this.collectFollowUpBullets(approved, raw);

    if (approved.length === 0) {
      console.log(chalk.yellow('  No bullets approved — using the full AI summary.\n'));
      return summary;
    }
    return approved.join('\n');
  }

  private parseBullets(text: string): string[] {
    return text.split('\n').map(line => line.trim()).filter(line => line.startsWith('- '));
  }

  private async promptBulletApproval(bullets: string[]): Promise<string[]> {
    const approved: string[] = [];
    for (const bullet of bullets) {
      console.log(chalk.cyan('  ' + bullet));
      const { accept } = await inquirer.prompt([
        { type: 'confirm', name: 'accept', message: 'Include this point?', prefix: ' ', default: true },
      ]);
      if (accept) approved.push(bullet);
    }
    return approved;
  }

  private async collectFollowUpBullets(approved: string[], raw: string): Promise<void> {
    console.log(chalk.yellow(
      '\n  Type a message to ask the AI to summarise specific content, or "done" to continue.\n'
    ));

    while (true) {
      const { input } = await inquirer.prompt([
        { type: 'input', name: 'input', message: chalk.cyan('message'), prefix: ' ' },
      ]);
      const trimmed = input.trim();
      if (!trimmed || trimmed.toLowerCase() === 'done') break;

      const extraBullets = await this.requestAdditionalBullets(trimmed, raw);
      const accepted = await this.promptBulletApproval(extraBullets);
      approved.push(...accepted);
      console.log(chalk.yellow('  💬 Type another message or "done" to continue.\n'));
    }
  }

  private async requestAdditionalBullets(userRequest: string, raw: string): Promise<string[]> {
    const prompt = 'The user reviewed a summary of a source and wants additional or different detail.\n\n'
      + 'User\'s request: "' + userRequest + '"\n\n'
      + 'Original source:\n```\n' + raw + '\n```\n\n'
      + 'Return ONLY new Markdown bullet points (- item) addressing the user\'s request. '
      + 'Do not repeat bullets already approved.';

    if (this.stageAgentService.isEnabledForStage('generate')) {
      const { content } = await this.stageAgentService.generateFromPrompt(prompt);
      return this.parseBullets(content);
    }
    const response = await this.aiService.execute({ prompt, maxTokens: 1024, stage: 'generate' });
    return this.parseBullets(requireAiResponseContent(response, 'AI provider returned an empty summary response'));
  }

  /**
   * Ask the AI to identify 0-5 clarification questions from the fetched sources.
   * Returns an empty array when nothing needs clarification or on parse failure.
   *
   * @param sources - Fetched source contents
   * @param onProgress - Optional callback for real-time progress lines from agent backends
   * @returns Clarification questions as plain strings
   */
  private async identifyClarifications(
    sources: SourceContent[], onProgress?: (line: string) => void, resumeSessionId?: string
  ): Promise<{ questions: string[]; sessionId?: string }> {
    try {
      const { content, sessionId } = await this.generateStageContent(
        this.buildClarificationPrompt(sources), 1024, 'empty clarification response', onProgress, resumeSessionId
      );
      return { questions: this.parseStringArray(content), sessionId };
    } catch (error) {
      if (isAiProviderErrorLike(error)) throw error;
      appendToLogFile(
        'WARN',
        `identifyClarifications: parse failure — ${error instanceof Error ? error.message : String(error)}`,
        'generate'
      );
      return { questions: [] };
    }
  }

  private async generateStageContent(
    prompt: string, maxTokens: number, emptyMessage: string,
    onProgress?: (line: string) => void, resumeSessionId?: string
  ): Promise<{ content: string; sessionId?: string }> {
    if (this.stageAgentService.isEnabledForStage('generate')) {
      return this.stageAgentService.generateFromPrompt(prompt, onProgress, resumeSessionId);
    }
    const response = await this.aiService.execute({ prompt, maxTokens, stage: 'generate' });
    return { content: requireAiResponseContent(response, 'AI provider returned an ' + emptyMessage) };
  }

  private parseStringArray(content: string): string[] {
    const parsed = JSON.parse(content.trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item: unknown) => typeof item === 'string' && (item).trim().length > 0);
  }

  /**
   * Build the AI prompt that requests clarification questions.
   *
   * @param sources - Fetched source contents
   * @returns Prompt string
   */
  private buildClarificationPrompt(sources: SourceContent[]): string {
    let prompt
      = 'Analyze these sources and identify 0-5 key ambiguities, assumptions, or risks that should be clarified before generating a ticket.\n\n'
        + 'IMPORTANT: Do NOT raise issues that the sources already acknowledge, discuss, or mitigate. '
        + 'Only surface gaps - things the sources leave unaddressed or contradict without resolution. '
        + 'If the sources already cover risks, assumptions, and scope adequately, return [].\n\n'
        + 'Return ONLY a JSON array of question strings. Return [] if everything is clear.\n\n';

    for (const [index, source] of sources.entries()) {
      prompt += `### Source ${index + 1}: ${source.source} (${source.type})\n`;
      prompt += `\`\`\`\n${typeof source.content === 'string' ? source.content.substring(0, MAX_SOURCE_CONTENT_LENGTH) : JSON.stringify(source.content).substring(0, MAX_SOURCE_CONTENT_LENGTH)}\n\`\`\`\n\n`;
    }

    return prompt;
  }

  /**
   * Present each clarification question to the user via inquirer and collect
   * answers. Returns a formatted Q&A string for injection into synthesis.
   *
   * @param questions - AI-generated clarification questions
   * @returns Concatenated Q&A pairs
   */
  private async promptClarifications(questions: string[]): Promise<string> {
    const pairs: string[] = [];

    for (const question of questions) {
      const { answer } = await inquirer.prompt([
        {
          type: 'input',
          name: 'answer',
          message: question,
          prefix: ' ',
        },
      ]);
      pairs.push(`Q: ${question}\nA: ${answer}`);
    }

    return pairs.join('\n\n');
  }

  /**
   * Use AI to synthesize and collate data from multiple sources
   */
  private async synthesizeWithAI(
    sources: SourceContent[], silent = false,
    repoContext?: RepoDiscoveryContext, onProgress?: (line: string) => void, resumeSessionId?: string
  ): Promise<UniversalTicket> {
    if (!silent) console.log(chalk.cyan('\n🤖 Using AI to synthesize content...\n'));
    const prompt = this.buildSynthesisPrompt(sources, repoContext);
    const { content } = await this.generateStageContent(prompt, 4096, 'empty ticket synthesis response', onProgress, resumeSessionId);
    appendToLogFile('DEBUG', content, 'generate');
    const ticket = new UniversalTicket(this.parseTicketJson(content));
    this.normalizeTicketTextFields(ticket);
    return ticket;
  }

  private parseTicketJson(
    content: string
  ): { title: string; type: TicketType; priority: TicketPriority; description: string } {
    try {
      const parsed = generateTicketSchema.parse(JSON.parse(content.trim()));
      return {
        title: parsed.title,
        type: parsed.type as TicketType,
        priority: parsed.priority as TicketPriority,
        description: parsed.description,
      };
    } catch (err) {
      throw new ValidationError(
        `generate: AI response is not a valid ticket JSON — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Gather repo discovery context for enriching synthesis prompts.
   *
   * @param repos - Optional repos from command options
   * @param sources - The fetched source contents (used for plan correlation)
   * @returns Repo discovery context object
   */
  private async gatherRepoContext(repos?: string[], sources?: SourceContent[]): Promise<RepoDiscoveryContext> {
    const context: RepoDiscoveryContext = {};
    const primaryRepoDir = resolveRepoBasePath(repos?.[0]);
    const repoName = path.basename(primaryRepoDir);

    context.conventions = this.safeCall(() => detectRepoConventions(primaryRepoDir));
    context.priorPlans = this.safeCall(() => detectPriorPlans(repoName));

    if (repos && repos.length > 1) {
      const secondaryDirs = repos.slice(1).map(r => resolveRepoBasePath(r));
      context.crossRepoPatterns = this.safeCall(() => detectCrossRepoPatterns(primaryRepoDir, secondaryDirs));
    }

    this.correlatePriorPlans(context, sources, primaryRepoDir);
    return context;
  }

  private correlatePriorPlans(context: RepoDiscoveryContext, sources?: SourceContent[], repoDir?: string): void {
    const plans = context.priorPlans;
    if (!plans || plans.plans.length === 0 || !sources || sources.length === 0 || !repoDir) return;
    const currentContent = sources
      .map(s => (typeof s.content === 'string' ? s.content : JSON.stringify(s.content)))
      .join('\n')
      .substring(0, 3000);
    context.planCorrelation = this.safeCall(() => correlatePlans(currentContent, plans, repoDir));
  }

  /**
   * Execute a callback and return its result, or undefined on failure.
   * Used for best-effort discovery steps that must not block the caller.
   */
  private safeCall<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      appendToLogFile(
        'WARN',
        `safeCall: ${fn.name || '(anonymous)'} threw — ${error instanceof Error ? error.message : String(error)}`,
        'generate'
      );
      return undefined;
    }
  }

  /**
   * Build prompt for AI synthesis
   */
  private buildSynthesisPrompt(sources: SourceContent[], repoContext?: RepoDiscoveryContext): string {
    return SYNTHESIS_PROMPT_TEMPLATE
      + this.buildRepoContextSection(repoContext)
      + this.formatSourcesForPrompt(sources);
  }

  private buildRepoContextSection(ctx?: RepoDiscoveryContext): string {
    if (!ctx) return '';
    const candidates: Array<string | undefined> = [
      ctx.conventions ? formatRepoConventionsPromptSection(ctx.conventions, ctx.priorPlans?.repoName ?? 'repo') : undefined,
      ctx.priorPlans ? formatPriorPlansPromptSection(ctx.priorPlans) : undefined,
      ctx.planCorrelation ? formatPlanCorrelationPromptSection(ctx.planCorrelation) : undefined,
      ctx.crossRepoPatterns ? formatCrossRepoPatternsPromptSection(ctx.crossRepoPatterns) : undefined,
    ];
    const parts = candidates.filter(Boolean) as string[];
    return parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
  }

  private formatSourcesForPrompt(sources: SourceContent[]): string {
    let result = 'Sources to synthesize:\n\n';
    for (const [i, s] of sources.entries()) {
      const content = typeof s.content === 'string' ? s.content : JSON.stringify(s.content);
      result += '### Source ' + (i + 1) + ': ' + s.source + ' (' + s.type + ')\n';
      result += '```\n' + content.substring(0, MAX_SOURCE_CONTENT_LENGTH) + '\n```\n\n';
    }
    return result;
  }

  /**
   * Normalize ticket string fields in place so downstream serializers only see
   * formal writing conventions for generated issue content.
   *
   * @param ticket - Ticket object to normalize
   * @returns Nothing
   */
  private normalizeTicketTextFields(ticket: UniversalTicket): void {
    this.normalizeNestedValue(ticket);
  }

  /**
   * Recursively normalize string values inside arrays and objects while
   * preserving non-plain objects such as Date instances.
   *
   * @param value - Arbitrary nested value to normalize
   * @returns The normalized value
   */
  private normalizeNestedValue<T>(value: T): T {
    if (typeof value === 'string') {
      return this.expandContractions(value) as T;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.normalizeNestedValue(item)) as T;
    }

    if (value instanceof Date) {
      return value;
    }

    if (value && typeof value === 'object') {
      for (const [key, nestedValue] of Object.entries(value)) {
        (value as Record<string, unknown>)[key] = this.normalizeNestedValue(nestedValue);
      }
    }

    return value;
  }

  /**
   * Expand contractions to their formal equivalents while preserving leading
   * capitalization of the original match.
   *
   * @param text - Text to normalize
   * @returns Text with contractions expanded
   */
  private expandContractions(text: string): string {
    return text.replace(CONTRACTION_PATTERN, match => {
      const key = match.replaceAll('\u2019', '\'').toLowerCase();
      const expansion = contractionMap.get(key) ?? match;
      const isCapitalized = match.startsWith(match[0].toUpperCase());
      return isCapitalized ? expansion[0].toUpperCase() + expansion.slice(1) : expansion;
    });
  }

  private buildSerializedOutput(ticket: UniversalTicket, format: string): string {
    const converter = this.formatConverterService.getConverter(format);
    return converter.serialize(ticket);
  }

  /**
   * Ensure generated serialized output contains no contractions before it is
   * emitted or persisted.
   *
   * @param output - Serialized ticket content
   * @param targetDescription - Human-readable serialization target for errors
   * @returns Nothing
   */
  private assertNoContractionsInSerializedOutput(output: string, targetDescription: string): void {
    const matches = new RegExp(CONTRACTION_PATTERN).exec(output);
    if (!matches) {
      return;
    }

    const examples = matches.slice(0, 3).join(', ');
    throw new ValidationError(
      `issue:generate produced contractions in ${targetDescription}: ${examples}. Use formal equivalents instead.`
    );
  }

  /**
   * Format repository string for Bitbucket operations
   * @param repo Repository in workspace/repo or repo-name format
   * @param configService NestJS ConfigService instance
   * @returns Formatted workspace/repo string
   */
  private formatBitbucketRepo(repo: string, configService: ConfigService): string {
    if (repo.includes('/')) {
      return repo;
    }

    const workspace = configService.get<string>('atlassian.bitbucket.workspace');
    if (!workspace) {
      throw new ConfigurationError(
        'Workspace required. Provide as workspace/repo or set atlassian.bitbucket.workspace in wf.config.*'
      );
    }

    return `${workspace}/${repo}`;
  }

  /**
   * Format Bitbucket issue reference
   * @param issueId Issue ID (number or string)
   * @param repo Repository (workspace/repo or repo-name)
   * @param configService NestJS ConfigService instance
   * @returns Formatted reference (workspace/repo#123)
   */
  private formatBitbucketReference(issueId: string, repo: string, configService: ConfigService): string {
    const formattedRepo = this.formatBitbucketRepo(repo, configService);
    return `${formattedRepo}#${issueId}`;
  }
}

/**
 * Source content interface
 */
interface SourceContent {
  type: 'url' | 'file' | 'tracker' | 'ticket' | 'slack';
  source: string;
  content: any;
  ticket?: UniversalTicket;
}
