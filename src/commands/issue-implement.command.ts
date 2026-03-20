import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeService } from '../integrations/ai/claude.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ErrorHandler } from '../shared/utils/error-handler';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

type OutputFormat = 'json' | 'md' | 'yaml';

interface IssueImplementOptions {
  platform?: string;
  forceRecreate?: boolean;
  format?: OutputFormat;
  repo?: string;
  dryRun?: boolean;
  affectedRepositories?: string[];
}

@Injectable()
@Command({
  name: 'issue:implement',
  description:
    'Generate an implementation plan for a ticket from a local artifact. ' +
    'If a local artifact is not found, the command will attempt to fetch it from the primary platform. ' +
    'Use --force-recreate to fetch and recreate artifacts.',
  arguments: '<ticket-key>',
})
export class IssueImplementCommand extends CommandRunner {
  constructor(
    private readonly claudeService: ClaudeService,
    private readonly platformService: PlatformService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
  ) {
    super();
  }

  @Option({
    flags: '-p, --platform <platform>',
    description: 'Platform to fetch from if local artifact not found',
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
    flags: '--force-recreate',
    description: 'Force fetch and recreate ticket artifact before planning',
  })
  parseForceRecreate(): boolean {
    return true;
  }

  @Option({
    flags: '-f, --format <format>',
    description: 'Output format for the implementation plan (json|md|yaml)',
  })
  parseFormat(format: string): OutputFormat {
    const validFormats: OutputFormat[] = ['json', 'md', 'yaml'];
    if (!validFormats.includes(format as OutputFormat)) {
      throw new Error(
        `Invalid format: ${format}. Valid formats: ${validFormats.join(', ')}`,
      );
    }
    return format as OutputFormat;
  }

  @Option({
    flags: '--repo <repo>',
    description: 'Repository for Bitbucket (workspace/repo or repo-name)',
  })
  parseRepo(val: string): string {
    return val;
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the implement operation without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '--affected-repositories <repos>',
    description: 'Comma-separated list of repositories affected by this ticket',
  })
  parseAffectedRepositories(val: string): string[] {
    return val.split(',').map((s) => s.trim());
  }

  async run(
    [ticketKey]: [string],
    options?: IssueImplementOptions,
  ): Promise<void> {
    try {
      const platformName =
        options?.platform ||
        this.configService.get<string>('platforms.primary', 'jira');

      const action = 'implement';
      const format = options?.format || 'json';

      const platformDir = path.join(process.cwd(), platformName);
      const ticketPath = path.join(platformDir, `${ticketKey}.md`);
      const planPath = path.join(
        platformDir,
        `${ticketKey}-plan-${action}.${format}`,
      );
      const ticketExists = fs.existsSync(ticketPath);
      const needsFetch = options?.forceRecreate || !ticketExists;

      if (options?.dryRun) {
        this.dryRunPreview.showHeader('issue:implement', ticketKey);

        if (needsFetch) {
          this.dryRunPreview.previewApiCall({
            method: 'GET',
            endpoint: `/${platformName}/issues/${ticketKey}`,
            platform: platformName,
            description: `Fetch ticket ${ticketKey} from ${platformName}`,
            estimatedResponse: '200 OK — ticket data returned',
          });
          this.dryRunPreview.previewFileWrite({
            filePath: ticketPath,
            operation: ticketExists ? 'overwrite' : 'create',
            sizeEstimate: '1–5 KB',
            format: 'markdown',
            contentPreview: buildTicketMarkdownPreview(ticketKey),
          });
        } else {
          this.dryRunPreview.previewFileRead({
            filePath: ticketPath,
            exists: true,
            sizeInKb: (fs.statSync(ticketPath).size / 1024).toFixed(2),
          });
        }

        this.dryRunPreview.previewApiCall({
          method: 'POST',
          endpoint: '/v1/messages',
          platform: 'Anthropic Claude',
          description: `Generate ${action} implementation plan`,
          estimatedResponse: [
            '{',
            `  "action": "${action}",`,
            '  "estimatedComplexity": "medium",',
            '  "steps": ["<step 1>", "..."],',
            '  "filesAffected": ["<file>", "..."]',
            '}',
          ].join('\n'),
        });

        this.dryRunPreview.previewFileWrite({
          filePath: planPath,
          operation: fs.existsSync(planPath) ? 'overwrite' : 'create',
          sizeEstimate: '2–8 KB',
          format,
          contentPreview:
            format === 'json'
              ? [
                  '{',
                  `  "action": "${action}",`,
                  '  "estimatedComplexity": "medium",',
                  '  "summary": "<summary>",',
                  '  "steps": [',
                  '    "<step 1>",',
                  '    "<step 2>",',
                  '    ...',
                  '  ]',
                  '}',
                ].join('\n')
              : [
                  '# Implementation Plan',
                  '',
                  `**Action:** ${action}`,
                  '**Complexity:** medium',
                  '',
                  '## Summary',
                  '<summary>',
                  '',
                  '## Steps',
                  '1. <step>',
                ].join('\n'),
        });

        this.dryRunPreview.showSummary({
          apiCallCount: needsFetch ? 2 : 1,
          fileCreatedCount: needsFetch ? 2 : 1,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          terminalOutputLines: [
            ...(needsFetch ? [`✓ Ticket saved to: ${ticketPath}`] : []),
            `✓ Plan saved to: ${planPath}`,
            '',
            'Plan Summary:',
            '  Action: implement',
            '  Complexity: <medium|high|low>',
            '  Steps: <n>',
            '  Files affected: <n>',
            '  Repositories affected: <n>',
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      this.logger.info(`Implementing ticket ${ticketKey}...`);

      let ticketContent: string;

      if (needsFetch) {
        if (options?.forceRecreate) {
          this.logger.info('Forcing recreation of ticket artifact...');
        } else {
          this.logger.info(
            'Local artifact not found. Fetching from platform...',
          );
        }

        const ticketReference =
          platformName === 'bitbucket' && options?.repo
            ? this.formatBitbucketReference(
                ticketKey,
                options.repo,
                this.configService,
              )
            : ticketKey;

        const adapter = this.platformService.getAdapter(platformName);
        const ticket = await adapter.getTicket(ticketReference);

        if (!fs.existsSync(platformDir)) {
          fs.mkdirSync(platformDir, { recursive: true });
        }

        ticketContent = this.formatTicketAsMarkdown(ticket);
        await fs.promises.writeFile(ticketPath, ticketContent, 'utf-8');
        this.logger.success(`✓ Ticket saved to: ${ticketPath}`);
      } else {
        this.logger.info(`Using local artifact: ${ticketPath}`);
        ticketContent = await fs.promises.readFile(ticketPath, 'utf-8');
      }

      this.logger.info('Generating implementation plan...');

      const summary = this.extractSummary(ticketContent);

      const plan = await this.claudeService.generatePlan(
        action,
        ticketContent,
        {
          ticketKey,
          summary,
          affectedRepositories: options?.affectedRepositories,
        },
      );

      let planContent: string;
      if (format === 'json') {
        planContent = JSON.stringify(plan, null, 2);
      } else if (format === 'yaml') {
        planContent = YAML.stringify(plan);
      } else {
        planContent = this.formatPlanAsMarkdown(plan);
      }

      await fs.promises.writeFile(planPath, planContent, 'utf-8');

      this.logger.success(`✓ Plan saved to: ${planPath}`);
      this.logger.info(`\nPlan Summary:`);
      this.logger.info(`  Action: ${plan.action}`);
      this.logger.info(`  Complexity: ${plan.estimatedComplexity}`);
      this.logger.info(`  Steps: ${plan.steps?.length || 0}`);
      this.logger.info(`  Files affected: ${plan.filesAffected?.length || 0}`);
      this.logger.info(
        `  Repositories affected: ${plan.repositoriesAffected?.length || 0}`,
      );
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  private extractSummary(content: string): string {
    const match = content.match(/^#\s+[A-Z]+-\d+:\s+(.+)$/m);
    return match ? match[1] : 'Implementation';
  }

  private formatTicketAsMarkdown(ticket: any): string {
    let md = `# ${ticket.title}\n\n`;
    md += `**Ticket:** ${ticket.key}\n`;
    md += `**Type:** ${ticket.type || 'N/A'}\n`;
    md += `**Status:** ${ticket.status}\n`;
    md += `**Priority:** ${ticket.priority || 'N/A'}\n\n`;
    md += `## Description\n\n${ticket.description || 'No description provided'}\n`;
    return md;
  }

  private formatPlanAsMarkdown(plan: any): string {
    let md = `# Implementation Plan\n\n`;
    md += `**Action:** ${plan.action}\n`;
    md += `**Complexity:** ${plan.estimatedComplexity}\n\n`;
    md += `## Summary\n\n${plan.summary}\n\n`;

    if (plan.steps && plan.steps.length > 0) {
      md += `## Steps\n\n`;
      plan.steps.forEach((step: string, i: number) => {
        md += `${i + 1}. ${step}\n`;
      });
      md += '\n';
    }

    if (plan.filesAffected && plan.filesAffected.length > 0) {
      md += `## Files Affected\n\n`;
      plan.filesAffected.forEach((file: string) => {
        md += `- ${file}\n`;
      });
      md += '\n';
    }

    if (plan.risks && plan.risks.length > 0) {
      md += `## Risks\n\n`;
      plan.risks.forEach((risk: string) => {
        md += `- ${risk}\n`;
      });
    }

    return md;
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
    if (repo.includes('/')) {
      return repo;
    }

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
   * Format Bitbucket issue reference with optional repo override
   * @param issueId Issue ID (number or string)
   * @param repo Optional repository override
   * @param configService NestJS ConfigService instance
   * @returns Formatted reference (workspace/repo#123 or 123)
   */
  private formatBitbucketReference(
    issueId: string,
    repo: string | undefined,
    configService: ConfigService,
  ): string {
    if (!repo) {
      return issueId;
    }

    const formattedRepo = this.formatBitbucketRepo(repo, configService);
    return `${formattedRepo}#${issueId}`;
  }
}
