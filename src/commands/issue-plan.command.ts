import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../integrations/ai/ai.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ErrorHandler } from '../shared/utils/error-handler';
import { getPlanArtifactExtension } from '../shared/utils/plan-artifact';
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
    comment: 'Create a custom feature plan from a markdown artifact',
    command: 'wf issue:plan --action feature --custom jira/bar.md',
  },
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
  custom?: string;
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
    flags: '-c, --custom <source.md>',
    description:
      'Custom markdown source artifact to synthesize into a canonical plan (mutually exclusive with <ticket-key>)',
  })
  parseCustom(val: string): string {
    return val;
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

      if (ticketKey && options?.custom) {
        console.error(
          chalk.red(
            'Error: --custom cannot be used together with <ticket-key>',
          ),
        );
        process.exit(1);
        return;
      }

      if (!ticketKey && !options?.custom) {
        console.error(
          chalk.red(
            'Error: Provide a <ticket-key> or use --custom <source.md> for a custom plan',
          ),
        );
        process.exit(1);
        return;
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
      const format = options?.format || 'json';
      const extension = getPlanArtifactExtension(format);

      // ── CUSTOM MODE ──────────────────────────────────────────────────────
      if (options?.custom) {
        const platformDir = resolveArtifactDir(artifactBaseDir, platformName);
        if (!options.custom.toLowerCase().endsWith('.md')) {
          console.error(
            chalk.red('Error: --custom only accepts Markdown (.md) sources'),
          );
          process.exit(1);
          return;
        }

        const customSourcePath = this.resolveCustomSourcePath(
          options.custom,
          options?.repos,
        );
        const planFilename = `${this.generateUniqueCustomPlanStem(
          platformDir,
          action,
        )}-${action}.${extension}`;
        const planPath = path.join(platformDir, planFilename);

        if (options.dryRun) {
          this.dryRunPreview.showHeader('issue:plan', `--custom (${action})`);
          this.dryRunPreview.previewFileRead({
            filePath: customSourcePath,
            exists: fs.existsSync(customSourcePath),
            sizeInKb: fs.existsSync(customSourcePath)
              ? (fs.statSync(customSourcePath).size / 1024).toFixed(2)
              : '0',
          });
          this.dryRunPreview.previewApiCall({
            method: 'POST',
            endpoint: '/v1/messages',
            platform: this.aiService.getProviderDisplayName(),
            description: `Generate ${action} plan from custom markdown source`,
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

        this.logger.info(`Generating custom ${action} plan from markdown...`);

        if (!fs.existsSync(platformDir)) {
          fs.mkdirSync(platformDir, { recursive: true });
        }

        const customSourceContent = fs.readFileSync(customSourcePath, 'utf-8');
        const plan = await this.planStageService.generatePlan(
          customSourceContent,
          {
            action,
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
      // Check for local artifact or fetch
      const platformDir = resolveArtifactDir(artifactBaseDir, platformName);
      const ticketPath = path.join(platformDir, `${ticketKey}.md`);
      const planPath = path.join(
        platformDir,
        `${ticketKey}-plan-${action}.${extension}`,
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

      this.deleteSiblingStandardPlans(platformDir, ticketKey, planPath);
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

    if (plan.repositoriesAffected && plan.repositoriesAffected.length > 0) {
      md += `## Repositories Affected\n\n`;
      plan.repositoriesAffected.forEach((repository: string) => {
        md += `- ${repository}\n`;
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
   * Remove stale standard plan siblings so a ticket keeps exactly one standard plan.
   *
   * @param platformDir - Artifact namespace for the active repo/platform
   * @param ticketKey - Ticket identifier
   * @param retainedPlanPath - Newly selected standard plan path
   * @returns void
   */
  private deleteSiblingStandardPlans(
    platformDir: string,
    ticketKey: string,
    retainedPlanPath: string,
  ): void {
    const actions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
    const extensions: Array<'json' | 'md' | 'yaml'> = ['json', 'md', 'yaml'];

    for (const siblingAction of actions) {
      for (const extension of extensions) {
        const siblingPath = path.join(
          platformDir,
          `${ticketKey}-plan-${siblingAction}.${extension}`,
        );
        if (siblingPath === retainedPlanPath || !fs.existsSync(siblingPath)) {
          continue;
        }

        this.logger.warn(`Deleting stale standard plan: ${siblingPath}`);
        fs.unlinkSync(siblingPath);
      }
    }
  }

  /**
   * Generate a collision-resistant custom plan stem under the active artifact namespace.
   *
   * @param platformDir - Artifact namespace for the active repo/platform
   * @param action - Resolution action suffix
   * @returns Unique mnemonic stem without the trailing action or extension
   */
  private generateUniqueCustomPlanStem(
    platformDir: string,
    action: ResolutionAction,
  ): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stem = generateMnemonic();
      const hasCollision = ['json', 'md', 'yaml'].some((extension) =>
        fs.existsSync(path.join(platformDir, `${stem}-${action}.${extension}`)),
      );
      if (!hasCollision) {
        return stem;
      }
    }

    throw new Error('Unable to generate a unique custom plan filename');
  }

  /**
   * Resolve a custom markdown source using repo-aware local file rules.
   *
   * @param source - Raw `--custom` CLI value
   * @param repos - Optional repo list supplied via `--repos`
   * @returns Absolute or cwd-relative source path
   */
  private resolveCustomSourcePath(source: string, repos?: string[]): string {
    if (path.isAbsolute(source)) {
      return source;
    }

    const matches = (repos ?? [])
      .map((repo) => path.join(resolveRepoBasePath(repo), source))
      .filter((candidate) => fs.existsSync(candidate));
    if (matches.length > 1) {
      throw new Error(
        `Custom source "${source}" matches multiple repositories: ${matches.join(', ')}`,
      );
    }
    if (matches.length === 1) {
      return matches[0];
    }

    const cwdCandidate = path.resolve(source);
    if (fs.existsSync(cwdCandidate)) {
      return cwdCandidate;
    }

    return path.resolve(artifactBasePathForSourceFallback(repos), source);
  }
}

const artifactBasePathForSourceFallback = (repos?: string[]): string =>
  resolveRepoBasePath(repos?.[0]);
