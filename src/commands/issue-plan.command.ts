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
import { parseReposOption } from './utils/repos-option';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import type { ResolutionAction } from '../agents/interfaces';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import { PlanStageService } from '../workflows/stages/plan-stage.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import chalk from 'chalk';

const ISSUE_PLAN_EXAMPLES: CliExample[] = [
  {
    comment: 'Plan a fix for a ticket',
    command: 'wf issue:plan WBP-2971 --action fix',
  },
  {
    comment: 'Force re-fetch before planning',
    command: 'wf issue:plan WBP-2971 --action fix --force --platform jira',
  },
];

type OutputFormat = 'json' | 'md' | 'yaml';

interface IssuePlanOptions {
  action: ResolutionAction;
  prompt?: string;
  platform?: string;
  force?: boolean;
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
    'Use --force to fetch and recreate artifacts.',
  arguments: '[ticket-key]',
})
export class IssuePlanCommand extends CommandRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly platformService: PlatformService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly fetchStageService: FetchStageService,
    private readonly planStageService: PlanStageService,
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
    flags: '--dry-run',
    description: 'Preview the plan operation without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '--force',
    description: 'Force fetch and recreate ticket artifact before planning',
  })
  parseForce(): boolean {
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
    flags: '--prompt <text>',
    description:
      'Freeform prompt text to use as ticket content (mutually exclusive with <ticket-key>)',
  })
  parsePrompt(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
    required: false,
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  async run([ticketKey]: string[], options?: IssuePlanOptions): Promise<void> {
    printExamples(ISSUE_PLAN_EXAMPLES);

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

        const plan = await this.planStageService.generatePlan(options.prompt, {
          action,
          affectedRepositories: options?.repos,
        });

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
      const needsFetch = options?.force || !ticketExists;

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
        if (options?.force) {
          this.logger.info('Forcing recreation of ticket artifact...');
        } else {
          this.logger.info(
            'Local artifact not found. Fetching from platform...',
          );
        }

        const artifact = await this.fetchStageService.fetchArtifact(ticketKey, {
          platformName,
          repo: options?.repos?.[0],
          baseDir: artifactBaseDir,
        });
        ticketContent = artifact.content;
        this.logger.success(`✓ Ticket saved to: ${artifact.path}`);
      } else {
        const artifact = this.fetchStageService.loadArtifact(
          ticketKey,
          platformName,
          artifactBaseDir,
        );
        this.logger.info(`Using local artifact: ${artifact.path}`);
        ticketContent = artifact.content;
      }

      // Generate plan using AI
      this.logger.info('Generating implementation plan...');

      const plan = await this.planStageService.generatePlan(ticketContent, {
        action,
        ticketKey,
      });

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
}
