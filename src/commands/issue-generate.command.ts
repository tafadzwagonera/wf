import { Command, CommandRunner, Option } from 'nest-commander';
import { PlatformService } from '../integrations/platforms/platform.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { ClaudeService } from '../integrations/ai/claude.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import {
  UniversalTicket,
  TicketType,
} from '../common/dto/universal-ticket.dto';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

interface IssueGenerateOptions {
  format?: string;
  output?: string;
  save?: boolean;
  platform?: string;
  title?: string;
  type?: string;
  priority?: string;
  repos: string[];
  dryRun?: boolean;
}

/**
 * Command to generate ticket descriptions from multiple sources
 * Supports local files, URLs, Jira keys, and AI synthesis
 */
@Command({
  name: 'issue:generate',
  description:
    'Generate ticket descriptions from multiple sources (local files, URLs, Jira keys)',
  arguments: '<sources...>',
  options: { isDefault: false },
})
export class IssueGenerateCommand extends CommandRunner {
  constructor(
    private readonly platformService: PlatformService,
    private readonly formatConverterService: FormatConverterService,
    private readonly claudeService: ClaudeService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
  ) {
    super();
  }

  async run(
    passedParams: string[],
    options?: IssueGenerateOptions,
  ): Promise<void> {
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

        this.dryRunPreview.showHeader(
          'issue:generate',
          `${passedParams.length} source(s)`,
        );

        let apiCallCount = 0;

        for (const source of passedParams) {
          if (source.startsWith('http://') || source.startsWith('https://')) {
            this.dryRunPreview.previewApiCall({
              method: 'GET',
              endpoint: source,
              platform: 'Web',
              description: 'Fetch content from URL',
              estimatedResponse: '200 OK — HTML / text content',
            });
            apiCallCount++;
          } else if (/^[A-Z]+-\d+$/i.test(source)) {
            this.dryRunPreview.previewApiCall({
              method: 'GET',
              endpoint: `/${platformName}/issues/${source}`,
              platform: platformName,
              description: `Fetch ticket ${source}`,
              estimatedResponse: '200 OK — ticket data',
            });
            apiCallCount++;
          } else if (fs.existsSync(source)) {
            this.dryRunPreview.previewFileRead({
              filePath: path.resolve(source),
              exists: true,
              sizeInKb: (fs.statSync(source).size / 1024).toFixed(2),
            });
          }
        }

        this.dryRunPreview.previewApiCall({
          method: 'POST',
          endpoint: '/v1/messages',
          platform: 'Anthropic Claude',
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
          const timestamp = new Date().toISOString().split('T')[0];
          const filePath = path.join(
            process.cwd(),
            platformName,
            `GENERATED-${timestamp}-preview.${format}`,
          );
          this.dryRunPreview.previewFileWrite({
            filePath,
            operation: 'create',
            sizeEstimate: '2–10 KB',
            format,
            contentPreview: generatedPreview,
          });
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
                  '✓ Ticket saved to: <platform-dir>/GENERATED-<date>-<title>.<format>',
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

      console.log(
        chalk.bold.cyan(
          `\n📝 Generating Ticket from ${passedParams.length} source(s)\n`,
        ),
      );

      // Fetch content from all sources
      const sourceContents = await this.fetchAllSources(
        passedParams,
        options?.platform,
        options!.repos[0],
      );

      // Use AI to synthesize and collate data
      const synthesizedTicket = await this.synthesizeWithAI(sourceContents);

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

      // Get output format
      const format =
        options?.format ||
        this.configService.get<string>('output.defaultFormat', 'md');

      // Get converter for the format
      const converter = this.formatConverterService.getConverter(format);

      // Serialize ticket to desired format
      const output = converter.serialize(synthesizedTicket);

      // Save to platform directory if --save option is provided
      if (options?.save) {
        const platformName =
          options?.platform ||
          this.configService.get<string>('platforms.primary', 'jira');
        const savedPath = await this.saveTicketLocally(
          synthesizedTicket,
          platformName,
          format,
        );
        console.log(chalk.green('\n✓ Ticket saved to:'), chalk.cyan(savedPath));
      }

      // Output to file or stdout
      if (options?.output) {
        const outputPath = path.resolve(options.output);
        fs.writeFileSync(outputPath, output);
        console.log(
          chalk.green('\n✓ Ticket also saved to:'),
          chalk.cyan(outputPath),
        );
      } else if (!options?.save) {
        // Only output to stdout if not saving
        console.log(chalk.green('\n✓ Generated Ticket:\n'));
        console.log(output);
      }

      console.log(
        chalk.gray(
          `\n💡 Tip: Use --save to save to platform directory, --output to save to file, or --format to change output format\n`,
        ),
      );
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  @Option({
    flags: '-f, --format <format>',
    description: 'Output format (json|md|yaml|xml) - default from env',
  })
  parseFormat(val: string): string {
    return val;
  }

  @Option({
    flags: '-o, --output <path>',
    description: 'Output file path - default: stdout',
  })
  parseOutput(val: string): string {
    return val;
  }

  @Option({
    flags: '--save',
    description: 'Save generated ticket to platform directory',
  })
  parseSave(): boolean {
    return true;
  }

  @Option({
    flags: '-p, --platform <platform>',
    description: 'Platform for ticket sources (jira|github|bitbucket)',
  })
  parsePlatform(val: string): string {
    return val;
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

  @Option({
    flags: '--priority <priority>',
    description: 'Override ticket priority (highest|high|medium|low|lowest)',
  })
  parsePriority(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --repos <repos>',
    description:
      'Comma-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
    required: true,
  })
  parseRepos(val: string): string[] {
    return val.split(',').map((s) => s.trim()).filter(Boolean);
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the generate operation without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  /**
   * Fetch content from all sources
   */
  private async fetchAllSources(
    sources: string[],
    platform?: string,
    repo?: string,
  ): Promise<SourceContent[]> {
    const contents: SourceContent[] = [];

    for (const source of sources) {
      console.log(chalk.gray(`  Fetching: ${source}`));

      try {
        const content = await this.fetchSource(source, platform, repo);
        contents.push(content);
        console.log(chalk.green(`    ✓ Fetched (${content.type})`));
      } catch (error) {
        console.log(chalk.yellow(`    ⚠ Failed: ${error.message}`));
      }
    }

    return contents;
  }

  /**
   * Fetch content from a single source
   */
  private async fetchSource(
    source: string,
    platform?: string,
    repo?: string,
  ): Promise<SourceContent> {
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

    throw new Error(`Unknown source type: ${source}`);
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

    // Try to parse as ticket if it's a supported format
    if (['.json', '.yaml', '.yml', '.md', '.xml'].includes(ext)) {
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
        // If parsing fails, treat as plain text
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
   * Save ticket to platform directory with generated filename
   */
  private async saveTicketLocally(
    ticket: UniversalTicket,
    platformName: string,
    format: string,
  ): Promise<string> {
    const platformDir = path.join(process.cwd(), platformName);
    if (!fs.existsSync(platformDir)) {
      fs.mkdirSync(platformDir, { recursive: true });
    }

    // Generate filename with timestamp and sanitized title
    const timestamp = new Date().toISOString().split('T')[0];
    const sanitizedTitle = ticket.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 30);
    const extension = format === 'md' ? 'md' : format;
    const filename = `GENERATED-${timestamp}-${sanitizedTitle}.${extension}`;
    const ticketPath = path.join(platformDir, filename);

    // Get converter and serialize
    const converter = this.formatConverterService.getConverter(format);
    const content = converter.serialize(ticket);

    // Write to file
    await fs.promises.writeFile(ticketPath, content, 'utf-8');

    return ticketPath;
  }

  /**
   * Use AI to synthesize and collate data from multiple sources
   */
  private async synthesizeWithAI(
    sources: SourceContent[],
  ): Promise<UniversalTicket> {
    console.log(chalk.cyan('\n🤖 Using AI to synthesize content...\n'));

    // If only one source and it's already a ticket, return it
    if (sources.length === 1 && sources[0].ticket) {
      return sources[0].ticket;
    }

    // Build prompt for AI
    const prompt = this.buildSynthesisPrompt(sources);

    // Call AI to synthesize
    const response = await this.claudeService.execute({
      prompt: prompt,
      maxTokens: 4096,
    });

    // Parse AI response as markdown (default) and convert to UniversalTicket
    const mdConverter = this.formatConverterService.getConverter('md');
    const ticket = mdConverter.parse(response.content);

    return ticket;
  }

  /**
   * Build prompt for AI synthesis
   */
  private buildSynthesisPrompt(sources: SourceContent[]): string {
    let prompt = `Synthesize and collate the following sources into a single, comprehensive ticket description.\n\n`;
    prompt += `Generate a well-structured ticket with:\n`;
    prompt += `- A clear, concise title\n`;
    prompt += `- A detailed description that combines information from all sources\n`;
    prompt += `- Proper organization with sections if needed\n\n`;
    prompt += `Output the ticket in Markdown format with:\n`;
    prompt += `# Title\n\n`;
    prompt += `**Type:** (task|bug|story|etc)\n`;
    prompt += `**Priority:** (high|medium|low)\n\n`;
    prompt += `## Description\n`;
    prompt += `[Synthesized description here]\n\n`;
    prompt += `---\n\n`;
    prompt += `Sources to synthesize:\n\n`;

    sources.forEach((source, index) => {
      prompt += `### Source ${index + 1}: ${source.source} (${source.type})\n`;
      prompt += `\`\`\`\n${typeof source.content === 'string' ? source.content.substring(0, 2000) : JSON.stringify(source.content).substring(0, 2000)}\n\`\`\`\n\n`;
    });

    return prompt;
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
        'Workspace required. Provide as workspace/repo or set ATLASSIAN_BITBUCKET_WORKSPACE',
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
  type: 'url' | 'file' | 'platform' | 'ticket';
  source: string;
  content: any;
  ticket?: UniversalTicket;
}
