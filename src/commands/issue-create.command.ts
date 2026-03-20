import { Command, CommandRunner, Option } from 'nest-commander';
import { PlatformService } from '../integrations/platforms/platform.service';
import { FormatConverterService } from '../common/converters/format-converter.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { TicketType } from '../common/dto/universal-ticket.dto';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

interface IssueCreateOptions {
  platform?: string;
  project?: string;
  type?: string;
  dryRun?: boolean;
}

/**
 * Command to create tickets on various platforms from standardized input
 * Supports multiple platforms and formats
 */
@Command({
  name: 'issue:create',
  description: 'Create tickets on various platforms from standardized input',
  arguments: '<input>',
  options: { isDefault: false },
})
export class IssueCreateCommand extends CommandRunner {
  constructor(
    private readonly platformService: PlatformService,
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
      // Read input file
      const inputFilePath = path.resolve(inputPath);
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
      if (options?.project) {
        ticket.project = options.project;
      }
      if (options?.type) {
        ticket.type = options.type as TicketType;
      }

      // Get platform adapter
      const platformName =
        options?.platform ||
        this.configService.get<string>('platforms.primary', 'jira');

      console.log(chalk.gray(`  Target platform: ${platformName}\n`));

      const adapter = this.platformService.getAdapter(platformName);

      // Dry run mode - just validate
      if (options?.dryRun) {
        this.dryRunPreview.showHeader(
          'issue:create',
          ticket.title?.substring(0, 40),
        );

        this.dryRunPreview.previewApiCall({
          method: 'POST',
          endpoint: `/${platformName}/issues`,
          platform: platformName,
          description: `Create ticket on ${platformName}`,
          estimatedResponse: '201 Created — ticket key and URL returned',
          payload: {
            title: ticket.title,
            type: ticket.type || 'task',
            priority: ticket.priority || 'medium',
            project: ticket.project || '<from config>',
          },
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
      console.log(chalk.cyan('🚀 Creating ticket on platform...\n'));
      const reference = await adapter.createTicket(ticket);

      console.log(chalk.green('✅ Ticket created successfully!\n'));
      console.log(chalk.bold('Platform:'), chalk.white(reference.platform));
      console.log(chalk.bold('Key:'), chalk.white(reference.key));
      console.log(chalk.bold('ID:'), chalk.white(reference.id));
      if (reference.url) {
        console.log(chalk.bold('URL:'), chalk.cyan(reference.url));
      }
      console.log();
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  @Option({
    flags: '-p, --platform <platform>',
    description: 'Target platform (jira|github|bitbucket) - default from env',
  })
  parsePlatform(val: string): string {
    return val;
  }

  @Option({
    flags: '--project <project>',
    description:
      'Project key (Jira) or repository (Bitbucket: workspace/repo) - overrides input file',
  })
  parseProject(val: string): string {
    return val;
  }

  @Option({
    flags: '-t, --type <type>',
    description: 'Issue type (task|bug|story|todo) - overrides input file',
  })
  parseType(val: string): string {
    return val;
  }

  @Option({
    flags: '--dry-run',
    description: 'Validate without creating - preview only',
  })
  parseDryRun(): boolean {
    return true;
  }
}
