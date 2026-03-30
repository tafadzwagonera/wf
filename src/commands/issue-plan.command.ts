import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../integrations/ai/ai.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ErrorHandler } from '../shared/utils/error-handler';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import type { ResolutionAction } from '../agents/interfaces';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import chalk from 'chalk';

type OutputFormat = 'json' | 'md' | 'yaml';

interface IssuePlanOptions {
  action: ResolutionAction;
  prompt?: string;
  platform?: string;
  forceRecreate?: boolean;
  format?: OutputFormat;
  repos?: string[];
  dryRun?: boolean;
}

const ADJECTIVES = [
  'bold',
  'calm',
  'dark',
  'fast',
  'hard',
  'keen',
  'late',
  'loud',
  'merry',
  'neat',
  'pale',
  'pure',
  'rare',
  'rich',
  'safe',
  'slim',
  'soft',
  'tall',
  'warm',
  'wise',
];
const VERBS = [
  'building',
  'chasing',
  'diving',
  'driving',
  'flying',
  'forging',
  'jumping',
  'lifting',
  'moving',
  'paving',
  'rolling',
  'running',
  'shifting',
  'tinkering',
  'tracing',
  'turning',
  'walking',
  'weaving',
  'wiring',
  'writing',
];
const NOUNS = [
  'axe',
  'bridge',
  'cloud',
  'coast',
  'creek',
  'dune',
  'flame',
  'forge',
  'grove',
  'hill',
  'lake',
  'lane',
  'leaf',
  'peak',
  'pine',
  'reef',
  'ridge',
  'river',
  'stone',
  'wave',
];

const generateMnemonic = (): string => {
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(ADJECTIVES)}-${pick(VERBS)}-${pick(NOUNS)}`;
};

@Injectable()
@Command({
  name: 'issue:plan',
  description:
    'Plan ticket implementation from a local artifact. ' +
    'If a local artifact is not found, the command will attempt to fetch it from the primary platform. ' +
    'Use --force-recreate to fetch and recreate artifacts.',
  arguments: '[ticket-key]',
})
export class IssuePlanCommand extends CommandRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly platformService: PlatformService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
  ) {
    super();
  }

  @Option({
    flags: '-a, --action <action>',
    description: 'Resolution action (feature|fix|investigate)',
    required: true,
  })
  parseAction(action: string): ResolutionAction {
    const validActions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
    if (!validActions.includes(action as ResolutionAction)) {
      throw new Error(
        `Invalid action: ${action}. Valid actions: ${validActions.join(', ')}`,
      );
    }
    return action as ResolutionAction;
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
    description: 'Output format for plan (json|md|yaml)',
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
    flags: '-r, --repos <repos>',
    description:
      'Comma-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
    required: false,
  })
  parseRepos(val: string): string[] {
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the plan operation without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '--prompt <text>',
    description:
      'Freeform prompt text to use as ticket content (mutually exclusive with <ticket-key>)',
  })
  parsePrompt(val: string): string {
    return val;
  }

  async run([ticketKey]: string[], options?: IssuePlanOptions): Promise<void> {
    try {
      fs.mkdirSync(path.join(os.homedir(), '.wf'), { recursive: true });

      // Mutual exclusion guard
      if (ticketKey && options?.prompt) {
        console.error(
          chalk.red(
            'Error: --prompt cannot be used together with <ticket-key>',
          ),
        );
        process.exit(1);
      }

      if (!ticketKey && !options?.prompt) {
        console.error(
          chalk.red(
            'Error: Provide a <ticket-key> or use --prompt <text> for a freeform plan',
          ),
        );
        process.exit(1);
      }

      const platformName =
        options?.platform ||
        this.configService.get<string>('platforms.primary', 'jira');

      // Bitbucket + ticket-key requires --repos
      if (
        ticketKey &&
        platformName === 'bitbucket' &&
        !options?.repos?.length
      ) {
        console.error(
          chalk.red('Error: --repos is required for Bitbucket ticket fetching'),
        );
        process.exit(1);
      }

      const action = options!.action;
      const artifactBaseDir = resolveRepoBasePath(options?.repos?.[0]);

      // ── PROMPT MODE ──────────────────────────────────────────────────────
      if (options?.prompt) {
        const platformDir = resolveArtifactDir(artifactBaseDir, platformName);
        const planFilename = `${generateMnemonic()}-${action}.json`;
        const planPath = path.join(platformDir, planFilename);
        const format = options?.format ?? 'json';

        if (options.dryRun) {
          this.dryRunPreview.showHeader('issue:plan', `--prompt (${action})`);
          this.dryRunPreview.previewApiCall({
            method: 'POST',
            endpoint: '/v1/messages',
            platform: this.aiService.getProviderDisplayName(),
            description: `Generate ${action} plan from prompt`,
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
            filePath: path.join(platformDir, planFilename),
            operation: 'create',
            sizeEstimate: '2–8 KB',
            format,
            contentPreview: `{ "action": "${action}", "estimatedComplexity": "medium", ... }`,
          });
          this.dryRunPreview.showSummary({
            apiCallCount: 1,
            fileCreatedCount: 1,
            fileModifiedCount: 0,
            gitOperationCount: 0,
            terminalOutputLines: [
              `✓ Plan saved to: <artifact-dir>/${planFilename}`,
              '',
              `  Action: ${action}`,
              '  Complexity: <medium|high|low>',
            ],
          });
          this.dryRunPreview.showValidationResult();
          return;
        }

        this.logger.info(`Generating freeform ${action} plan from prompt...`);

        if (!fs.existsSync(platformDir)) {
          fs.mkdirSync(platformDir, { recursive: true });
        }

        const plan = await this.aiService.generatePlan(
          action as any,
          options.prompt,
          {
            summary: options.prompt.slice(0, 80),
            affectedRepositories: options?.repos,
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
        this.logger.info(
          `  Files affected: ${plan.filesAffected?.length || 0}`,
        );
        return;
      }

      // ── TICKET-KEY MODE (existing behaviour) ─────────────────────────────
      // Get format
      const format = options?.format || 'json';

      // Check for local artifact or fetch
      const platformDir = resolveArtifactDir(artifactBaseDir, platformName);
      const ticketPath = path.join(platformDir, `${ticketKey}.md`);
      const planPath = path.join(
        platformDir,
        `${ticketKey}-plan-${action}.${format}`,
      );
      const ticketExists = fs.existsSync(ticketPath);
      const needsFetch = options?.forceRecreate || !ticketExists;

      if (options?.dryRun) {
        this.dryRunPreview.showHeader('issue:plan', ticketKey);

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
          platform: this.aiService.getProviderDisplayName(),
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
            `  Action: ${action}`,
            '  Complexity: <medium|high|low>',
            '  Steps: <n>',
            '  Files affected: <n>',
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      this.logger.info(`Planning ticket ${ticketKey} (action: ${action})...`);

      let ticketContent: string;

      if (needsFetch) {
        if (options?.forceRecreate) {
          this.logger.info('Forcing recreation of ticket artifact...');
        } else {
          this.logger.info(
            'Local artifact not found. Fetching from platform...',
          );
        }

        // Format reference for Bitbucket
        const ticketReference =
          platformName === 'bitbucket'
            ? this.formatBitbucketReference(
                ticketKey,
                options?.repos?.[0] ?? '',
                this.configService,
              )
            : ticketKey;

        // Fetch from platform
        const adapter = this.platformService.getAdapter(platformName);
        const ticket = await adapter.getTicket(ticketReference);

        // Save to file
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

      // Generate plan using AI
      this.logger.info('Generating implementation plan...');

      // Extract summary for context
      const summary = this.extractSummary(ticketContent);

      const plan = await this.aiService.generatePlan(
        action as any,
        ticketContent,
        {
          ticketKey,
          summary,
        },
      );

      // Save plan to file

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
