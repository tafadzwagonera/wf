import { Command, CommandRunner, Option } from 'nest-commander';
import { PlatformService } from '../integrations/platforms/platform.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { AiService } from '../integrations/ai/ai.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { SlackService } from '../integrations/slack/slack.service';
import { StageAgentService } from '../integrations/ai/stage-agent.service';
import {
  resolveArtifactDir,
  resolveCustomArtifactDir,
  resolveRepoBasePath,
} from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import {
  buildGeneratedTicketArtifactFilename,
  buildGeneratedTicketManifestFilename,
  buildGeneratedTicketManifestPath,
  buildGeneratedTicketSourceManifest,
  hashGeneratedTicketSources,
} from '../shared/utils/generated-ticket-artifact';
import {
  UniversalTicket,
  TicketType,
} from '../common/dto/universal-ticket.dto';
import inquirer from 'inquirer';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { getWfHomeDir } from '../shared/utils/wf-paths';

/** Minimum description length (chars) for a ticket to bypass AI synthesis. */
const MIN_DESCRIPTION_LENGTH = 100;
const SLACK_CHANNEL_HISTORY_LIMIT = 50;
const SLACK_THREAD_PATH = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/i;
const SLACK_CHANNEL_PATH = /^\/archives\/([A-Z0-9]+)\/?$/i;
const EM_DASH = '—';
const ASCII_EM_DASH_REPLACEMENT = ' - ';

const ISSUE_GENERATE_EXAMPLES: CliExample[] = [
  {
    comment: 'Generate ticket from a URL',
    command: 'wf issue:generate https://example.com/spec',
  },
  {
    comment: 'Generate from a Slack thread permalink with query params',
    command:
      'wf issue:generate "https://workspace.slack.com/archives/C0AP5MMCP53/p1775650646860809?thread_ts=1775650646.860809&cid=C0AP5MMCP53"',
  },
  {
    comment: 'Generate from a repo-scoped artifact (requires -r, --repos)',
    command: 'wf issue:generate itinerary-pdf-generation.md -r service-tourv3',
  },
  {
    comment: 'Save with overridden title',
    command: 'wf issue:generate ./requirements.md --title "Add OAuth2" --save',
  },
  {
    comment: 'Silent mode: pipe generated ticket directly into issue:create',
    command: 'wf issue:generate ./spec.md -s | wf issue:create',
  },
  {
    comment: 'Silent mode: pipe saved artifact path to issue:create',
    command:
      'wf issue:generate ./spec.md --save --silent | xargs wf issue:create',
  },
];

interface IssueGenerateOptions {
  format?: OutputFormat;
  output?: string;
  save?: boolean;
  silent?: boolean;
  platform?: string;
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

class UnresolvedSourceError extends Error {}

/**
 * Command to generate ticket descriptions from multiple sources
 * Supports local files, repo-scoped artifacts via `--repos`, URLs, Jira keys,
 * and AI synthesis. Local `.md`, `.json`, `.yaml`, and `.yml` files that parse
 * as tickets are imported as tickets; files that are not recognized as
 * ticket-formatted content remain plain file sources. When `--repos` resolves
 * to a local checkout, bootstrap config is loaded from that repository before
 * command execution. Generated serialized output is normalized to ASCII
 * punctuation before display or save.
 */
@Command({
  name: 'issue:generate',
  description:
    'Generate ticket descriptions from local files, repo-scoped artifacts via --repos, URLs, or Jira keys. Local .md, .json, .yaml, and .yml files that parse as tickets are imported as tickets; files that are not recognized as ticket-formatted content remain plain file sources. When --repos points to a local checkout, wf bootstraps config from that repo and accepts either module.exports or export default in wf.config.js, including ESM repos. Generated output normalizes em dashes to ASCII " - " before display or save. Can use an agent backend when stages.generate.agent: true is configured',
  arguments: '<sources...>',
  options: { isDefault: false },
})
export class IssueGenerateCommand extends CommandRunner {
  constructor(
    private readonly platformService: PlatformService,
    private readonly formatConverterService: FormatConverterService,
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly slackService: SlackService,
    private readonly stageAgentService: StageAgentService,
  ) {
    super();
  }

  async run(
    passedParams: string[],
    options?: IssueGenerateOptions,
  ): Promise<void> {
    if (!options?.silent) {
      printExamples(ISSUE_GENERATE_EXAMPLES);
    }

    fs.mkdirSync(getWfHomeDir(), { recursive: true });

    if (!passedParams || passedParams.length === 0) {
      console.error(chalk.red('Error: At least one source is required'));
      console.log(
        chalk.gray('Usage: wf issue:generate <sources...> [options]'),
      );
      console.log(
        chalk.gray(
          'Example: wf issue:generate https://example.com/spec ./notes.md WBP-2971',
        ),
      );
      process.exit(1);
    }

    try {
      if (options?.dryRun) {
        const format =
          options?.format ||
          this.configService.get<string>('output.defaultFormat', 'md');
        const platformName =
          options?.platform ||
          this.configService.get<string>('platforms.primary', 'jira');
        const artifactBaseDir = resolveRepoBasePath(options?.repos?.[0]);

        this.dryRunPreview.showHeader(
          'issue:generate',
          `${passedParams.length} source(s)`,
        );

        let apiCallCount = 0;

        for (const source of passedParams) {
          const resolvedSources = await this.resolveSourceInputs(
            source,
            options?.repos,
            options?.silent ?? false,
          );
          this.assertResolvableSourceSelection(
            source,
            resolvedSources,
            options?.repos,
          );

          for (const resolvedSource of resolvedSources) {
            const slackSourceMatch = this.parseSlackSource(resolvedSource);

            if (slackSourceMatch?.kind === 'thread') {
              const [seconds, micros] = slackSourceMatch.threadTs.split('.');
              this.dryRunPreview.previewApiCall({
                method: 'GET',
                endpoint: 'https://slack.com/api/conversations.replies',
                platform: 'Slack',
                description: `Fetch thread ${resolvedSource}`,
                estimatedResponse: '200 OK — thread messages JSON',
              });
              this.dryRunPreview.previewFileWrite({
                filePath: path.join(
                  resolveArtifactDir(artifactBaseDir, 'slack'),
                  `slack-thread-${slackSourceMatch.channelId}-${seconds}-${micros}.md`,
                ),
                operation: 'create',
                sizeEstimate: '1–20 KB',
                format: 'md',
                contentPreview:
                  '[<ts>] <user>: <message>\n[<ts>] <user>: <reply>',
              });
              apiCallCount++;
            } else if (slackSourceMatch?.kind === 'channel') {
              this.dryRunPreview.previewApiCall({
                method: 'GET',
                endpoint: 'https://slack.com/api/conversations.history',
                platform: 'Slack',
                description: `Fetch recent channel history ${resolvedSource}`,
                estimatedResponse: '200 OK — channel messages JSON',
              });
              this.dryRunPreview.previewFileWrite({
                filePath: path.join(
                  resolveArtifactDir(artifactBaseDir, 'slack'),
                  `slack-thread-${slackSourceMatch.channelId}-<oldest-message-ts>.md`,
                ),
                operation: 'create',
                sizeEstimate: '1–20 KB',
                format: 'md',
                contentPreview:
                  '[<ts>] <user>: <message>\n[<ts>] <user>: <message>',
              });
              apiCallCount++;
            } else if (
              resolvedSource.startsWith('http://') ||
              resolvedSource.startsWith('https://')
            ) {
              this.dryRunPreview.previewApiCall({
                method: 'GET',
                endpoint: resolvedSource,
                platform: 'Web',
                description: 'Fetch content from URL',
                estimatedResponse: '200 OK — HTML / text content',
              });
              apiCallCount++;
            } else if (/^[A-Z]+-\d+$/i.test(resolvedSource)) {
              this.dryRunPreview.previewApiCall({
                method: 'GET',
                endpoint: `/${platformName}/issues/${resolvedSource}`,
                platform: platformName,
                description: `Fetch ticket ${resolvedSource}`,
                estimatedResponse: '200 OK — ticket data',
              });
              apiCallCount++;
            } else if (fs.existsSync(resolvedSource)) {
              this.dryRunPreview.previewFileRead({
                filePath: path.resolve(resolvedSource),
                exists: true,
                sizeInKb: (fs.statSync(resolvedSource).size / 1024).toFixed(2),
              });
            }
          }
        }

        this.dryRunPreview.previewApiCall({
          method: 'POST',
          endpoint: '/v1/messages',
          platform: this.aiService.getProviderDisplayName(),
          description: `Synthesise ${passedParams.length} source(s) into a unified ticket`,
          estimatedResponse: [
            '{',
            '  "title": "<synthesized title>",',
            '  "type": "task",',
            '  "priority": "medium",',
            '  "description": "<synthesized from sources>"',
            '}',
          ].join('\n'),
        });
        apiCallCount++;

        const generatedPreview = [
          '# <synthesized title>',
          '',
          '**Type:** task',
          '**Priority:** medium',
          '',
          '## Description',
          '',
          '<synthesized from sources>',
        ].join('\n');

        let fileCreatedCount = 0;

        if (options?.save) {
          const timestamp = new Date();
          const artifactFilename = buildGeneratedTicketArtifactFilename(
            timestamp,
            passedParams,
            format,
          );
          const manifestFilename =
            buildGeneratedTicketManifestFilename(artifactFilename);
          const filePath = path.join(
            resolveArtifactDir(artifactBaseDir, platformName),
            artifactFilename,
          );
          this.dryRunPreview.previewFileWrite({
            filePath,
            operation: 'create',
            sizeEstimate: '2–10 KB',
            format,
            contentPreview: generatedPreview,
          });
          this.dryRunPreview.previewFileWrite({
            filePath: path.join(
              resolveArtifactDir(artifactBaseDir, platformName),
              manifestFilename,
            ),
            operation: 'create',
            sizeEstimate: '1–2 KB',
            format: 'json',
            contentPreview: JSON.stringify(
              buildGeneratedTicketSourceManifest(
                filePath,
                platformName,
                format,
                passedParams,
                timestamp,
              ),
              null,
              2,
            ),
          });
          fileCreatedCount++;
          fileCreatedCount++;
        }

        if (options?.output) {
          this.dryRunPreview.previewFileWrite({
            filePath: path.resolve(options.output),
            operation: 'create',
            sizeEstimate: '2–10 KB',
            format,
            contentPreview: generatedPreview,
          });
          fileCreatedCount++;
        }

        this.dryRunPreview.showSummary({
          apiCallCount,
          fileCreatedCount,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          terminalOutputLines: [
            ...(options?.save
              ? [
                  '✓ Ticket saved to: <platform-dir>/YYYY-MM-DD-<hash>-ticket-description.<format>',
                ]
              : []),
            ...(options?.output
              ? [`✓ Ticket also saved to: ${path.resolve(options.output)}`]
              : []),
            ...(!options?.save && !options?.output
              ? [
                  '✓ Generated Ticket:',
                  '',
                  '  <ticket content printed to stdout>',
                ]
              : []),
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      const silent = options?.silent ?? false;

      if (!silent) {
        console.log(
          chalk.bold.cyan(
            `\n📝 Generating Ticket from ${passedParams.length} source(s)\n`,
          ),
        );
      }

      // Fetch content from all sources
      const sourceContents = await this.fetchAllSources(
        passedParams,
        options?.platform,
        options?.repos,
        silent,
      );
      this.assertSourcesAvailable(sourceContents, passedParams);

      // Interactive clarification pass (non-silent, TTY only)
      if (!silent && this.isInteractiveSession()) {
        const clarifications =
          await this.identifyClarifications(sourceContents);
        if (clarifications.length > 0) {
          const userResponses = await this.promptClarifications(clarifications);
          sourceContents.push({
            type: 'file',
            source: 'user-clarifications',
            content: userResponses,
          });
        }
      }

      // Use AI to synthesize and collate data
      const synthesizedTicket = await this.synthesizeWithAI(
        sourceContents,
        silent,
      );

      // Apply metadata overrides if provided
      if (options?.title) {
        synthesizedTicket.title = options.title;
      }
      if (options?.type) {
        synthesizedTicket.type = options.type as TicketType;
      }
      if (options?.priority) {
        synthesizedTicket.priority = options.priority as any;
      }
      this.normalizeTicketTextFields(synthesizedTicket);

      // Get output format
      const format =
        options?.format ||
        this.configService.get<string>('output.defaultFormat', 'md');

      // Serialize ticket to desired format
      const output = this.serializeTicketOutput(
        synthesizedTicket,
        format,
        'stdout/file output',
      );

      // Save to platform directory if --save option is provided
      if (options?.save) {
        const platformName =
          options?.platform ||
          this.configService.get<string>('platforms.primary', 'jira');
        const saveTargets = await this.resolveSaveTargets(
          options?.repos,
          silent,
        );
        const targetRepos = saveTargets.length > 0 ? saveTargets : [undefined];

        for (const targetRepo of targetRepos) {
          const savedPath = await this.saveTicketLocally(
            synthesizedTicket,
            platformName,
            format,
            passedParams,
            targetRepo,
          );
          if (silent) {
            console.log(savedPath);
          } else {
            console.log(
              chalk.green('\n✓ Ticket saved to:'),
              chalk.cyan(savedPath),
            );
          }
        }
      }

      // Output to file or stdout
      if (options?.output) {
        const outputPath = path.resolve(options.output);
        fs.writeFileSync(outputPath, output);
        if (silent) {
          console.log(outputPath);
        } else {
          console.log(
            chalk.green('\n✓ Ticket also saved to:'),
            chalk.cyan(outputPath),
          );
        }
      } else if (!options?.save) {
        // Output to stdout
        if (!silent) {
          console.log(chalk.green('\n✓ Generated Ticket:\n'));
        }
        console.log(output);
      }

      if (!silent) {
        console.log(
          chalk.gray(
            `\n💡 Tip: Use --save to save to platform directory, --output to save to file, or --format to change output format\n`,
          ),
        );
      }
    } catch (error) {
      ErrorHandler.handle(error as Error);
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
    description: 'Output format (json|md|yaml|yml) - default from config',
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
    flags: '-o, --output <path>',
    description: 'Output file path - default: stdout',
  })
  parseOutput(val: string): string {
    return val;
  }

  @Option({
    flags: '-p, --platform <platform>',
    description: 'Platform for ticket sources (jira|github|bitbucket)',
  })
  parsePlatform(val: string): string {
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
      'Space-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '--save',
    description: 'Save generated ticket to platform directory',
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
    platform?: string,
    repos?: string[],
    silent = false,
  ): Promise<SourceContent[]> {
    const contents: SourceContent[] = [];

    for (const source of sources) {
      if (!silent) {
        console.log(chalk.gray(`  Fetching: ${source}`));
      }

      try {
        const resolvedSources = await this.resolveSourceInputs(
          source,
          repos,
          silent,
        );
        this.assertResolvableSourceSelection(source, resolvedSources, repos);

        if (resolvedSources.length === 0) {
          if (!silent) {
            console.log(chalk.yellow('    ⚠ Skipped: no sources selected'));
          }
          continue;
        }

        for (const resolvedSource of resolvedSources) {
          const content = await this.fetchSource(
            resolvedSource,
            platform,
            repos?.[0],
          );
          contents.push(content);
          if (!silent) {
            console.log(chalk.green(`    ✓ Fetched (${content.type})`));
          }
        }
      } catch (error) {
        if (error instanceof UnresolvedSourceError) {
          throw error;
        }

        if (!silent) {
          console.log(chalk.yellow(`    ⚠ Failed: ${error.message}`));
        }
      }
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
  private assertSourcesAvailable(
    contents: SourceContent[],
    sources: string[],
  ): void {
    if (contents.length > 0) {
      return;
    }

    throw new Error(
      `Failed to fetch usable content from ${sources.length} source(s). ` +
        'Resolve the source access issue and retry.',
    );
  }

  /**
   * Fetch content from a single source
   */
  private async fetchSource(
    source: string,
    platform?: string,
    repo?: string,
  ): Promise<SourceContent> {
    // Check if it's a Slack thread permalink (must come before generic URL check)
    const slackSourceMatch = this.parseSlackSource(source);
    if (slackSourceMatch?.kind === 'thread') {
      return await this.fetchFromSlack(
        source,
        slackSourceMatch.channelId,
        slackSourceMatch.threadTs,
        repo,
      );
    }

    if (slackSourceMatch?.kind === 'channel') {
      return await this.fetchFromSlackChannel(
        source,
        slackSourceMatch.channelId,
        repo,
      );
    }

    // Check if it's a URL
    if (source.startsWith('http://') || source.startsWith('https://')) {
      return await this.fetchFromUrl(source);
    }

    // Check if it's a local file path
    if (fs.existsSync(source)) {
      return await this.fetchFromFile(source);
    }

    // Check if it's a ticket key (contains letters and numbers with dash/hyphen)
    if (/^[A-Z]+-\d+$/i.test(source)) {
      return await this.fetchFromPlatform(source, platform, repo);
    }

    throw new Error(
      `Unknown source type: ${source}. Supported: URL, local file path, ticket key (ABC-123), Slack thread URL`,
    );
  }

  /**
   * Fetch content from a Slack thread permalink
   */
  private async fetchFromSlack(
    source: string,
    channelId: string,
    threadTs: string,
    repo?: string,
  ): Promise<SourceContent> {
    const result = await this.slackService.fetchThread(channelId, threadTs);
    const threadId = this.normalizeSlackTimestamp(threadTs);
    const formattedText = this.formatSlackMessages(result.messages);
    await this.writeSlackArtifact(
      repo,
      `slack-thread-${channelId}-${threadId}.md`,
      formattedText,
    );
    return { type: 'slack', source, content: formattedText };
  }

  /**
   * Fetch content from a Slack channel archive URL.
   */
  private async fetchFromSlackChannel(
    source: string,
    channelId: string,
    repo?: string,
  ): Promise<SourceContent> {
    const result = await this.slackService.fetchChannelHistory(
      channelId,
      SLACK_CHANNEL_HISTORY_LIMIT,
    );
    const formattedText = this.formatSlackMessages(result.messages);
    const conversationTs = this.getSlackConversationArtifactTs(result.messages);
    await this.writeSlackArtifact(
      repo,
      `slack-thread-${channelId}-${conversationTs}.md`,
      formattedText,
    );
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

    // Structured local files keep their current fallback: parse as a ticket
    // when recognized, otherwise continue as a plain file source.
    if (['.json', '.yaml', '.yml', '.md'].includes(ext)) {
      try {
        const format = this.formatConverterService.detectFormat(filePath);
        if (format) {
          const converter = this.formatConverterService.getConverter(format);
          const ticket = converter.parse(content);
          return {
            type: 'ticket',
            source: filePath,
            content: content,
            ticket: ticket,
          };
        }
      } catch {
        // Files that do not parse as tickets remain valid plain file sources.
      }
    }

    return {
      type: 'file',
      source: filePath,
      content: content,
    };
  }

  /**
   * Fetch ticket from platform (Jira, GitHub, BitBucket)
   */
  private async fetchFromPlatform(
    ticketKey: string,
    platform?: string,
    repo?: string,
  ): Promise<SourceContent> {
    try {
      const adapter = platform
        ? this.platformService.getAdapter(platform)
        : this.platformService.getDefaultAdapter();

      // Format reference for Bitbucket
      const ticketReference =
        platform === 'bitbucket'
          ? this.formatBitbucketReference(ticketKey, repo!, this.configService)
          : ticketKey;

      const ticket = await adapter.getTicket(ticketReference);

      return {
        type: 'platform',
        source: ticketKey,
        content: `${ticket.title}\n\n${ticket.description}`,
        ticket: ticket,
      };
    } catch (error) {
      throw new Error(
        `Failed to fetch ticket ${ticketKey} from platform: ${error.message}`,
      );
    }
  }

  /**
   * Convert Slack messages into the text format used for synthesis artifacts.
   *
   * @param messages - Slack messages to serialize
   * @returns Readable plain-text conversation content
   */
  private formatSlackMessages(
    messages: Array<{ user: string; ts: string; text: string }>,
  ): string {
    return [...messages]
      .sort((left, right) => this.compareSlackTimestamps(left.ts, right.ts))
      .map((message) => `[${message.ts}] ${message.user}: ${message.text}`)
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
  private getSlackConversationArtifactTs(
    messages: Array<{ ts: string }>,
  ): string {
    if (messages.length === 0) {
      return 'no-messages';
    }

    const earliestMessage = [...messages].sort((left, right) =>
      this.compareSlackTimestamps(left.ts, right.ts),
    )[0];

    return this.normalizeSlackTimestamp(earliestMessage.ts);
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
  private async writeSlackArtifact(
    repo: string | undefined,
    fileName: string,
    content: string,
  ): Promise<void> {
    const artifactDir = resolveArtifactDir(resolveRepoBasePath(repo), 'slack');
    await fs.promises.mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, fileName);
    await fs.promises.writeFile(artifactPath, content, 'utf-8');
    console.log(chalk.gray(`  Artifact: ${artifactPath}`));
  }

  /**
   * Save ticket to platform directory with generated filename
   */
  private async saveTicketLocally(
    ticket: UniversalTicket,
    platformName: string,
    format: string,
    sources: string[],
    repo?: string,
  ): Promise<string> {
    const platformDir = resolveArtifactDir(
      resolveRepoBasePath(repo),
      platformName,
    );
    await fs.promises.mkdir(platformDir, { recursive: true });

    const hash8 = hashGeneratedTicketSources(sources);
    const extension = format === 'md' ? 'md' : format;
    const timestamp = new Date();

    // Find an existing artifact with the same source hash and overwrite it,
    // avoiding duplicate files when the command is retried with identical inputs.
    const existingFilename = fs
      .readdirSync(platformDir)
      .find((name) =>
        new RegExp(
          `^\\d{4}-\\d{2}-\\d{2}-${hash8}-ticket-description\\.${extension}$`,
        ).test(name),
      );

    let artifactPath: string;
    if (existingFilename) {
      artifactPath = path.join(platformDir, existingFilename);
    } else {
      artifactPath = path.join(
        platformDir,
        buildGeneratedTicketArtifactFilename(timestamp, sources, format),
      );
    }

    this.normalizeTicketTextFields(ticket);
    const content = this.serializeTicketOutput(
      ticket,
      format,
      `saved artifact for ${platformName}`,
    );
    await fs.promises.writeFile(artifactPath, content, 'utf-8');
    const manifestPath = buildGeneratedTicketManifestPath(artifactPath);
    const manifest = buildGeneratedTicketSourceManifest(
      artifactPath,
      platformName,
      format,
      sources,
      timestamp,
    );
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    return artifactPath;
  }

  /**
   * Resolve a raw source argument into concrete sources for fetching.
   *
   * Filename-only sources are checked against repo-scoped `~/.wf/<repo>/`
   * artifacts only when `--repos` is supplied, before the live checkout path
   * and cwd-relative fallback.
   *
   * @param source - Raw CLI source argument
   * @param repos - Optional repos supplied via `--repos`
   * @param silent - When true, fail instead of prompting on ambiguity
   * @returns Resolved source paths or original non-file source
   */
  private async resolveSourceInputs(
    source: string,
    repos?: string[],
    silent = false,
  ): Promise<string[]> {
    if (
      this.parseSlackSource(source) !== null ||
      source.startsWith('http://') ||
      source.startsWith('https://') ||
      /^[A-Z]+-\d+$/i.test(source)
    ) {
      return [source];
    }

    if (path.isAbsolute(source) && fs.existsSync(source)) {
      return [source];
    }

    const resolvedRepoSources = await this.resolveRepoRelativeSources(
      source,
      repos,
      silent,
    );
    if (resolvedRepoSources.concreteSources.length > 0) {
      return resolvedRepoSources.concreteSources;
    }

    if (fs.existsSync(source)) {
      return [source];
    }

    return [];
  }

  /**
   * Raise a specific error when a local-looking source cannot be resolved.
   *
   * @param source - Raw CLI source argument
   * @param resolvedSources - Concrete paths or identifiers derived from the source
   * @param repos - Optional repos supplied via `--repos`
   * @returns Nothing; throws when the source should surface actionable guidance
   */
  private assertResolvableSourceSelection(
    source: string,
    resolvedSources: string[],
    repos?: string[],
  ): void {
    if (resolvedSources.length > 0) {
      return;
    }

    if (!this.isUnresolvedLocalSourceCandidate(source, repos)) {
      return;
    }

    throw new UnresolvedSourceError(
      this.buildUnresolvedSourceMessage(source, repos),
    );
  }

  /**
   * Check whether a source token should receive local artifact guidance.
   *
   * @param source - Raw CLI source argument
   * @param repos - Optional repos supplied via `--repos`
   * @returns True when the unresolved source looks like a local artifact/file
   */
  private isUnresolvedLocalSourceCandidate(
    source: string,
    repos?: string[],
  ): boolean {
    if (repos?.length) {
      return false;
    }

    if (
      path.isAbsolute(source) ||
      this.parseSlackSource(source) !== null ||
      source.startsWith('http://') ||
      source.startsWith('https://') ||
      /^[A-Z]+-\d+$/i.test(source)
    ) {
      return false;
    }

    return true;
  }

  /**
   * Build the actionable error shown when a local artifact name cannot resolve.
   *
   * @param source - Raw CLI source argument
   * @param repos - Optional repos supplied via `--repos`
   * @returns User-facing error message
   */
  private buildUnresolvedSourceMessage(
    source: string,
    repos?: string[],
  ): string {
    const suggestedRepo =
      repos?.[0] ?? path.basename(resolveRepoBasePath(repos?.[0]));

    return (
      `Source "${source}" could not be resolved from the current directory. ` +
      'If this is a repo-scoped artifact under ~/.wf/<repo>/, re-run with ' +
      `--repos <repo> (for example: wf issue:generate ${source} -r ${suggestedRepo}).`
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
    source: string,
    repos?: string[],
    silent = false,
  ): Promise<LocalSourceResolution> {
    if (!repos?.length || path.isAbsolute(source)) {
      return { concreteSources: [], matchedRepoInputs: [] };
    }

    const resolvedRepos = this.resolveRepos(repos);
    const matches = resolvedRepos
      .map((repo) => {
        const artifactCandidate = path.join(
          resolveCustomArtifactDir(repo.basePath),
          source,
        );
        if (fs.existsSync(artifactCandidate)) {
          return {
            repoInput: repo.input,
            filePath: artifactCandidate,
          };
        }

        const repoCandidate = path.join(repo.basePath, source);
        if (fs.existsSync(repoCandidate)) {
          return {
            repoInput: repo.input,
            filePath: repoCandidate,
          };
        }

        return null;
      })
      .filter(
        (
          match,
        ): match is {
          repoInput: string;
          filePath: string;
        } => match !== null,
      );

    if (matches.length === 0) {
      return { concreteSources: [], matchedRepoInputs: [] };
    }

    if (matches.length === 1) {
      return {
        concreteSources: [matches[0].filePath],
        matchedRepoInputs: [matches[0].repoInput],
      };
    }

    if (!this.isInteractiveSession()) {
      throw new Error(
        `Source "${source}" matches multiple repositories: ${matches
          .map(({ repoInput }) => repoInput)
          .join(
            ', ',
          )}. Re-run in an interactive terminal or pass a single unambiguous --repos value.`,
      );
    }

    if (silent) {
      throw new Error(
        `Source "${source}" matches multiple repositories: ${matches
          .map(({ repoInput }) => repoInput)
          .join(
            ', ',
          )}. Pass a single unambiguous --repos value in silent mode.`,
      );
    }

    const answers = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedSources',
        message: `Select matching files for ${source}`,
        choices: matches.map(({ filePath, repoInput }) => ({
          name: `${repoInput}: ${filePath}`,
          value: filePath,
        })),
      },
    ]);

    const selectedSources = (answers.selectedSources ?? []) as string[];
    const selectedRepoInputs = matches
      .filter(({ filePath }) => selectedSources.includes(filePath))
      .map(({ repoInput }) => repoInput);

    return {
      concreteSources: selectedSources,
      matchedRepoInputs: selectedRepoInputs,
    };
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
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(source);
    } catch {
      return null;
    }

    if (!parsedUrl.hostname.endsWith('.slack.com')) {
      return null;
    }

    const slackThreadMatch = parsedUrl.pathname.match(SLACK_THREAD_PATH);
    if (slackThreadMatch) {
      return {
        kind: 'thread',
        channelId: slackThreadMatch[1],
        threadTs: `${slackThreadMatch[2]}.${slackThreadMatch[3]}`,
      };
    }

    const slackChannelMatch = parsedUrl.pathname.match(SLACK_CHANNEL_PATH);
    if (slackChannelMatch) {
      return {
        kind: 'channel',
        channelId: slackChannelMatch[1],
      };
    }

    return null;
  }

  /**
   * Resolve save targets for `--save`.
   *
   * @param repos - Optional repos supplied via `--repos`
   * @param silent - When true, fail instead of prompting on ambiguity
   * @returns Repo identifiers to use as artifact namespaces
   */
  private async resolveSaveTargets(
    repos?: string[],
    silent = false,
  ): Promise<string[]> {
    if (!repos?.length) {
      return [];
    }

    const resolvedRepos = this.resolveRepos(repos);
    if (resolvedRepos.length <= 1) {
      return resolvedRepos.map(({ input }) => input);
    }

    if (!this.isInteractiveSession()) {
      throw new Error(
        `Cannot save to multiple repositories in a non-interactive session. Matching repositories: ${resolvedRepos
          .map(({ input }) => input)
          .join(', ')}.`,
      );
    }

    if (silent) {
      throw new Error(
        `Cannot save to multiple repositories in silent mode. Matching repositories: ${resolvedRepos
          .map(({ input }) => input)
          .join(', ')}.`,
      );
    }

    const answers = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedRepos',
        message: 'Select repositories to save the generated artifact into',
        choices: resolvedRepos.map(({ input, basePath }) => ({
          name: `${input}: ${basePath}`,
          value: input,
        })),
        validate: (selectedRepos: string[]) =>
          selectedRepos.length > 0 ||
          'Select at least one repository to save the generated artifact.',
      },
    ]);

    return answers.selectedRepos as string[];
  }

  /**
   * Resolve each repo identifier to a real local directory.
   *
   * @param repos - Raw repo identifiers from `--repos`
   * @returns Resolved repo directories in input order
   */
  private resolveRepos(repos: string[]): ResolvedRepo[] {
    return repos.flatMap((repo) => {
      const resolvedRepo = this.resolveRepoDirectory(repo);
      if (!resolvedRepo) {
        console.log(
          chalk.yellow(
            `⚠ Repository '${repo}' not found as a path or sibling directory.`,
          ),
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
    if (path.isAbsolute(repo) && fs.existsSync(repo)) {
      return repo;
    }

    const relativeRepoPath = path.resolve(process.cwd(), repo);
    if (fs.existsSync(relativeRepoPath)) {
      return relativeRepoPath;
    }

    const siblingRepoPath = path.resolve(process.cwd(), '..', repo);
    if (fs.existsSync(siblingRepoPath)) {
      return siblingRepoPath;
    }

    return undefined;
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
   * Ask the AI to identify 0-5 clarification questions from the fetched sources.
   * Returns an empty array when nothing needs clarification or on parse failure.
   *
   * @param sources - Fetched source contents
   * @returns Clarification questions as plain strings
   */
  private async identifyClarifications(
    sources: SourceContent[],
  ): Promise<string[]> {
    const prompt = this.buildClarificationPrompt(sources);

    try {
      const responseContent = this.stageAgentService.isEnabledForStage(
        'generate',
      )
        ? await this.stageAgentService.generateFromPrompt(prompt)
        : (
            await this.aiService.execute({
              prompt,
              maxTokens: 1024,
              stage: 'generate',
            })
          ).content;

      const parsed = JSON.parse(responseContent.trim());
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(
        (item: unknown) => typeof item === 'string' && item.trim().length > 0,
      );
    } catch {
      return [];
    }
  }

  /**
   * Build the AI prompt that requests clarification questions.
   *
   * @param sources - Fetched source contents
   * @returns Prompt string
   */
  private buildClarificationPrompt(sources: SourceContent[]): string {
    let prompt =
      'Analyze these sources and identify 0-5 key ambiguities, assumptions, or risks that should be clarified before generating a ticket.\n\n' +
      'IMPORTANT: Do NOT raise issues that the sources already acknowledge, discuss, or mitigate. ' +
      'Only surface gaps - things the sources leave unaddressed or contradict without resolution. ' +
      'If the sources already cover risks, assumptions, and scope adequately, return [].\n\n' +
      'Return ONLY a JSON array of question strings. Return [] if everything is clear.\n\n';

    sources.forEach((source, index) => {
      prompt += `### Source ${index + 1}: ${source.source} (${source.type})\n`;
      prompt += `\`\`\`\n${typeof source.content === 'string' ? source.content.substring(0, 2000) : JSON.stringify(source.content).substring(0, 2000)}\n\`\`\`\n\n`;
    });

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
    sources: SourceContent[],
    silent = false,
  ): Promise<UniversalTicket> {
    if (!silent) {
      console.log(chalk.cyan('\n🤖 Using AI to synthesize content...\n'));
    }

    // If only one source and its description is long enough, skip AI synthesis
    if (
      sources.length === 1 &&
      (sources[0].ticket?.description?.trim().length ?? 0) >=
        MIN_DESCRIPTION_LENGTH
    ) {
      this.normalizeTicketTextFields(sources[0].ticket!);
      return sources[0].ticket!;
    }

    // Build prompt for AI
    const prompt = this.buildSynthesisPrompt(sources);

    // Call AI to synthesize
    const responseContent = this.stageAgentService.isEnabledForStage('generate')
      ? await this.stageAgentService.generateFromPrompt(prompt)
      : (
          await this.aiService.execute({
            prompt: prompt,
            maxTokens: 4096,
            stage: 'generate',
          })
        ).content;

    // Parse AI response as markdown (default) and convert to UniversalTicket
    const mdConverter = this.formatConverterService.getConverter('md');
    const ticket = mdConverter.parse(responseContent);
    this.normalizeTicketTextFields(ticket);

    return ticket;
  }

  /**
   * Build prompt for AI synthesis
   */
  private buildSynthesisPrompt(sources: SourceContent[]): string {
    let prompt = `Synthesize the following sources into a single, comprehensive Jira ticket.\n\n`;
    prompt += `Output ONLY valid Markdown using this exact structure. Every heading MUST appear even when source material is sparse; use "None" for sections with no relevant information:\n\n`;
    prompt += `# Heading: <concise title>\n\n`;
    prompt += `**Type:** <task|bug|story|epic|subtask>\n`;
    prompt += `**Priority:** <high|medium|low>\n\n`;
    prompt += `## Description\n\n`;
    prompt += `### Summary\n`;
    prompt += `<concise issue description with code excerpts where applicable>\n\n`;
    prompt += `#### Technical Details\n`;
    prompt += `<implementation suggestions, backward compatibility concerns, required migrations, architectural alignment>\n\n`;
    prompt += `### Acceptance Criteria\n`;
    prompt += `- <criterion 1>\n\n`;
    prompt += `### Unit Test Scope\n`;
    prompt += `- <unit test scope item 1>\n\n`;
    prompt += `#### Dependencies\n`;
    prompt += `- <dependency or "None">\n\n`;
    prompt += `### Risks & Assumptions\n`;
    prompt += `- <risk or assumption or "None">\n\n`;
    prompt += `### Affected Repositories\n`;
    prompt += `- <repository or "None">\n\n`;
    prompt += `#### References\n`;
    prompt += `- <reference or "None">\n\n`;
    prompt += `#### Out of Scope\n`;
    prompt += `- <out of scope item or "None">\n\n`;
    prompt += `Rules:\n`;
    prompt += `- Do not add, remove, or rename any heading.\n`;
    prompt += `- Do not wrap the output in a code fence.\n`;
    prompt += `- Use fenced Markdown code blocks (\`\`\`lang) for code samples; never use Jira wiki {code} syntax.\n`;
    prompt += `- Use \`- \` for every unordered bullet item; never use \`* \` bullets.\n`;
    prompt += `- Do not use em dashes; use ASCII \` - \` instead.\n`;
    prompt += `- The line "## Description" MUST appear exactly once.\n\n`;
    prompt += `Sources to synthesize:\n\n`;

    sources.forEach((source, index) => {
      prompt += `### Source ${index + 1}: ${source.source} (${source.type})\n`;
      prompt += `\`\`\`\n${typeof source.content === 'string' ? source.content.substring(0, 2000) : JSON.stringify(source.content).substring(0, 2000)}\n\`\`\`\n\n`;
    });

    return prompt;
  }

  /**
   * Normalize ticket string fields in place so downstream serializers only see
   * ASCII punctuation for generated issue content.
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
      return this.normalizeEmDashText(value) as T;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeNestedValue(item)) as T;
    }

    if (value instanceof Date) {
      return value;
    }

    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, nestedValue]) => {
        (value as Record<string, unknown>)[key] =
          this.normalizeNestedValue(nestedValue);
      });
    }

    return value;
  }

  /**
   * Replace em dashes with readable ASCII punctuation while keeping line
   * structure intact.
   *
   * @param text - Text to normalize
   * @returns Normalized text
   */
  private normalizeEmDashText(text: string): string {
    return text.replace(/[ \t]*—[ \t]*/g, ASCII_EM_DASH_REPLACEMENT);
  }

  /**
   * Serialize a generated ticket and reject any serialized form that still
   * contains em dashes.
   *
   * @param ticket - Ticket to serialize
   * @param format - Output format requested by the caller
   * @param targetDescription - Human-readable serialization target for errors
   * @returns Serialized ticket content
   */
  private serializeTicketOutput(
    ticket: UniversalTicket,
    format: string,
    targetDescription: string,
  ): string {
    const converter = this.formatConverterService.getConverter(format);
    const output = converter.serialize(ticket);
    this.assertNoEmDashInSerializedOutput(output, targetDescription);
    return output;
  }

  /**
   * Ensure generated serialized output is ASCII-normalized before it is
   * emitted or persisted.
   *
   * @param output - Serialized ticket content
   * @param targetDescription - Human-readable serialization target for errors
   * @returns Nothing
   */
  private assertNoEmDashInSerializedOutput(
    output: string,
    targetDescription: string,
  ): void {
    if (!output.includes(EM_DASH)) {
      return;
    }

    throw new Error(
      `issue:generate produced an em dash in ${targetDescription}. Use ASCII " - " instead.`,
    );
  }

  /**
   * Format repository string for Bitbucket operations
   * @param repo Repository in workspace/repo or repo-name format
   * @param configService NestJS ConfigService instance
   * @returns Formatted workspace/repo string
   */
  private formatBitbucketRepo(
    repo: string,
    configService: ConfigService,
  ): string {
    // Already in workspace/repo format
    if (repo.includes('/')) {
      return repo;
    }

    // Get workspace from config and combine
    const workspace = configService.get<string>(
      'atlassian.bitbucket.workspace',
    );
    if (!workspace) {
      throw new Error(
        'Workspace required. Provide as workspace/repo or set atlassian.bitbucket.workspace in wf.config.*',
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
  private formatBitbucketReference(
    issueId: string,
    repo: string,
    configService: ConfigService,
  ): string {
    const formattedRepo = this.formatBitbucketRepo(repo, configService);
    return `${formattedRepo}#${issueId}`;
  }
}

/**
 * Source content interface
 */
interface SourceContent {
  type: 'url' | 'file' | 'platform' | 'ticket' | 'slack';
  source: string;
  content: any;
  ticket?: UniversalTicket;
}
