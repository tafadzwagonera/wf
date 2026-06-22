import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../integrations/ai/ai.service';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ErrorHandler } from '../shared/utils/error-handler';
import { getPlanArtifactExtension } from '../shared/utils/plan-artifact';
import {
  resolveArtifactDir,
  resolveCustomArtifactDir,
  resolveRepoBasePath,
} from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import type { ResolutionAction } from '../agents/interfaces';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import { PlanStageService } from '../workflows/stages/plan-stage.service';
import { ensureWfHome } from '../shared/utils/ensure-wf-home';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import chalk from 'chalk';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../shared/utils/plan-artifact';

const ISSUE_PLAN_EXAMPLES: CliExample[] = [
  {
    comment: 'Create a custom feature plan from a markdown artifact',
    command: 'wf issue:plan --action feature --custom bar.md',
  },
  {
    comment: 'Prefer the repo-scoped custom artifact when a repo is supplied',
    command: 'wf issue:plan --action feature --custom bar.md --repos repo-a',
  },
  {
    comment: 'Plan a fix for a ticket',
    command: 'wf issue:plan WBP-2971 --action fix',
  },
  {
    comment: 'Force re-fetch before planning',
    command: 'wf issue:plan WBP-2971 --action fix --force --tracker jira',
  },
];

type OutputFormat = 'json' | 'md' | 'yaml' | 'yml';

interface IssuePlanOptions {
  action: ResolutionAction;
  custom?: string;
  tracker?: string;
  force?: boolean;
  format?: OutputFormat;
  repos?: string[];
  dryRun?: boolean;
  silent?: boolean;
}

interface RepoAwarePlan {
  filesAffected?: string[];
  repositoriesAffected?: string[];
  verification?: {
    targeted?: Array<{
      id?: string;
      run?: string;
      reason?: string;
    }>;
  };
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

/**
 * Build a formatted plan validation error.
 *
 * @param message - Validation failure detail
 * @returns Error with consistent command-facing wording
 */
const createPlanValidationError = (message: string): Error =>
  new Error(`Generated plan is invalid: ${message}`);

/**
 * Detect whether a verification reason describes an expected failure case.
 *
 * @param value - Free-form verification reason or identifier text
 * @returns True when the text describes an expected failing command
 */
const describesExpectedFailure = (value?: string): boolean =>
  /expected failure|expect(?:ed)? .*fail|should fail|must fail|non-markdown|reject(?:ed|ion)?|invalid input|exit code 1/i.test(
    value ?? '',
  );

/**
 * Detect whether a verification command contains an assertion wrapper that can
 * turn an expected failure into an overall success exit code.
 *
 * @param command - Verification command text
 * @returns True when the command appears to assert on failure conditions
 */
const usesAssertionWrapper = (command?: string): boolean =>
  /(?:^|[ (])!|(?:\|\|)|(?:&&)|\bif\b|\bthen\b|\belse\b|\bfi\b|\bexit\s+0\b|\btest\b|\$\?|\bsh\s+-c\b|\bbash\s+-c\b|\bzsh\s+-c\b/.test(
    command ?? '',
  );

const normalizeVerificationRunCommand = (
  command: string,
  selectedRepoDir: string,
): string => {
  const trimmed = command.trim();
  const cdPrefixMatch = trimmed.match(/^cd\s+(.+?)\s*&&\s*(.+)$/);
  if (!cdPrefixMatch) {
    return trimmed;
  }

  const [, rawTarget, remainder] = cdPrefixMatch;
  const target = rawTarget.trim().replace(/^['"]|['"]$/g, '');
  const normalizedRepoDir = path.resolve(selectedRepoDir);
  const repoName = path.basename(normalizedRepoDir);
  const normalizedRelativeTarget =
    target === repoName || target === `./${repoName}`
      ? normalizedRepoDir
      : path.resolve(selectedRepoDir, target);
  const normalizedAbsoluteTarget = path.resolve(target);

  if (
    normalizedRelativeTarget === normalizedRepoDir ||
    normalizedAbsoluteTarget === normalizedRepoDir
  ) {
    return remainder.trim();
  }

  return trimmed;
};

const escapesSelectedRepo = (
  command: string,
  selectedRepoDir: string,
): boolean => {
  const trimmed = command.trim();
  const cdPrefixMatch = trimmed.match(/^cd\s+(.+?)\s*&&\s*(.+)$/);
  if (!cdPrefixMatch) {
    return false;
  }

  const normalized = normalizeVerificationRunCommand(trimmed, selectedRepoDir);
  if (normalized !== trimmed) {
    return false;
  }

  return true;
};

@Injectable()
@Command({
  name: 'issue:plan',
  description:
    'Plan ticket implementation from a local artifact or repo-scoped custom artifact. ' +
    'If a local artifact is not found, the command will attempt to fetch it from the primary tracker. ' +
    'Use --force to fetch and recreate artifacts. ' +
    'Targeted verification commands are interpreted as repo-root-relative: redundant ' +
    '`cd <repo>` prefixes are normalized away, while commands that change directories ' +
    'outside the selected repository are rejected.',
  arguments: '[ticket-key]',
})
export class IssuePlanCommand extends CommandRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly issueTrackerService: IssueTrackerService,
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
    description: 'Output format for plan (json|md|yaml|yml) - default: json',
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
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
    required: false,
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '-s, --silent',
    description:
      'Suppress decorative output and interactive prompts. Emits only the plan path for piping',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description: 'Tracker to fetch from if local artifact not found',
  })
  parseTracker(tracker: string): string {
    const validTrackers = ['jira', 'github', 'bitbucket'];
    if (!validTrackers.includes(tracker)) {
      throw new Error(
        `Invalid tracker: ${tracker}. Valid trackers: ${validTrackers.join(', ')}`,
      );
    }
    return tracker;
  }

  async run([ticketKey]: string[], options?: IssuePlanOptions): Promise<void> {
    if (!options?.silent) {
      printExamples(ISSUE_PLAN_EXAMPLES);
    }

    try {
      await ensureWfHome();

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

      const trackerName =
        options?.tracker || this.configService.get<string>('tracker', 'jira');

      // Bitbucket + ticket-key requires --repos
      if (ticketKey && trackerName === 'bitbucket' && !options?.repos?.length) {
        console.error(
          chalk.red('Error: --repos is required for Bitbucket ticket fetching'),
        );
        process.exit(1);
      }

      const action = options!.action;
      const artifactBaseDir = resolveRepoBasePath(options?.repos?.[0]);
      // Output format: CLI flag > per-stage config > hardcoded default
      const format =
        options?.format ||
        (this.configService.get<string>('stages.plan.outputFormat') as
          | OutputFormat
          | undefined) ||
        'json';
      const extension = getPlanArtifactExtension(format);

      // ── CUSTOM MODE ──────────────────────────────────────────────────────
      if (options?.custom) {
        const customArtifactDir = resolveCustomArtifactDir(artifactBaseDir);
        if (!options.custom.toLowerCase().endsWith('.md')) {
          console.error(
            chalk.red('Error: --custom only accepts Markdown (.md) sources'),
          );
          process.exit(1);
          return;
        }

        const customSourcePath = this.resolveCustomSourcePath(
          options.custom,
          artifactBaseDir,
          options?.repos,
        );
        const customSourceName = this.generateUniqueCustomPlanStem(
          customArtifactDir,
          action,
        );
        const planFilename = buildPlanArtifactFilename({
          hash: hashPlanArtifactSources([customSourceName]),
          action,
          format: extension,
        });
        const planPath = path.join(customArtifactDir, planFilename);

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
            filePath: path.join(customArtifactDir, planFilename),
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

        if (!options?.silent) {
          this.logger.info(`Generating custom ${action} plan from markdown...`);
        }

        if (!fs.existsSync(customArtifactDir)) {
          fs.mkdirSync(customArtifactDir, { recursive: true });
        }

        const customSourceContent = fs.readFileSync(customSourcePath, 'utf-8');
        const plan = await this.planStageService.generatePlan(
          customSourceContent,
          {
            action,
            affectedRepositories: options?.repos ?? [
              path.basename(artifactBaseDir),
            ],
          },
        );
        this.validateGeneratedPlan(
          plan,
          artifactBaseDir,
          this.resolveExpectedRepositories(artifactBaseDir, options?.repos),
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
        writePlanArtifactManifest(
          buildPlanArtifactManifest(
            planPath,
            action,
            format,
            hashPlanArtifactSources([customSourceName]),
            customSourceName,
            'custom',
            new Date(),
          ),
        );
        this.deleteSiblingPlanArtifacts(
          customArtifactDir,
          customSourceName,
          'custom',
          action,
          planPath,
        );
        if (options?.silent) {
          console.log(planPath);
        } else {
          this.logger.success(`✓ Plan saved to: ${planPath}`);
          this.logger.info(`\nPlan Summary:`);
          this.logger.info(`  Action: ${plan.action}`);
          this.logger.info(`  Complexity: ${plan.estimatedComplexity}`);
          this.logger.info(`  Steps: ${plan.steps?.length || 0}`);
          this.logger.info(
            `  Files affected: ${plan.filesAffected?.length || 0}`,
          );
        }
        return;
      }

      // ── TICKET-KEY MODE (existing behaviour) ─────────────────────────────
      // Check for local artifact or fetch
      const trackerDir = resolveArtifactDir(artifactBaseDir, trackerName);
      const ticketPath = path.join(trackerDir, `${ticketKey}.md`);
      const planSourceName = ticketKey;
      const planPath = path.join(
        trackerDir,
        buildPlanArtifactFilename({
          hash: hashPlanArtifactSources([planSourceName]),
          action,
          format: extension,
        }),
      );
      const ticketExists = fs.existsSync(ticketPath);
      const needsFetch = options?.force || !ticketExists;

      if (options?.dryRun) {
        this.dryRunPreview.showHeader('issue:plan', ticketKey);

        if (needsFetch) {
          this.dryRunPreview.previewApiCall({
            method: 'GET',
            endpoint: `/${trackerName}/issues/${ticketKey}`,
            platform: trackerName,
            description: `Fetch ticket ${ticketKey} from ${trackerName}`,
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

      if (!options?.silent) {
        this.logger.info(`Planning ticket ${ticketKey} (action: ${action})...`);
      }

      let ticketContent: string;

      if (needsFetch) {
        if (!options?.silent) {
          if (options?.force) {
            this.logger.info('Forcing recreation of ticket artifact...');
          } else {
            this.logger.info(
              'Local artifact not found. Fetching from tracker...',
            );
          }
        }

        const artifact = await this.fetchStageService.fetchArtifact(ticketKey, {
          trackerName,
          repo: options?.repos?.[0],
          baseDir: artifactBaseDir,
        });
        ticketContent = artifact.content;
        if (!options?.silent) {
          this.logger.success(`✓ Ticket saved to: ${artifact.path}`);
        }
      } else {
        const artifact = this.fetchStageService.loadArtifact(
          ticketKey,
          trackerName,
          artifactBaseDir,
        );
        if (!options?.silent) {
          this.logger.info(`Using local artifact: ${artifact.path}`);
        }
        ticketContent = artifact.content;
      }

      // Generate plan using AI
      if (!options?.silent) {
        this.logger.info('Generating implementation plan...');
      }

      const plan = await this.planStageService.generatePlan(ticketContent, {
        action,
        ticketKey,
        affectedRepositories: options?.repos ?? [
          path.basename(artifactBaseDir),
        ],
      });
      this.validateGeneratedPlan(
        plan,
        artifactBaseDir,
        this.resolveExpectedRepositories(artifactBaseDir, options?.repos),
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
      writePlanArtifactManifest(
        buildPlanArtifactManifest(
          planPath,
          action,
          format,
          hashPlanArtifactSources([planSourceName]),
          planSourceName,
          'ticket',
          new Date(),
          trackerName,
        ),
      );
      this.deleteSiblingPlanArtifacts(
        trackerDir,
        planSourceName,
        'ticket',
        action,
        planPath,
      );

      if (options?.silent) {
        console.log(planPath);
      } else {
        this.logger.success(`✓ Plan saved to: ${planPath}`);
        this.logger.info(`\nPlan Summary:`);
        this.logger.info(`  Action: ${plan.action}`);
        this.logger.info(`  Complexity: ${plan.estimatedComplexity}`);
        this.logger.info(`  Steps: ${plan.steps?.length || 0}`);
        this.logger.info(
          `  Files affected: ${plan.filesAffected?.length || 0}`,
        );
      }
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

    if (
      plan.verification?.targeted?.length ||
      plan.verification?.waivers?.length
    ) {
      md += `## Verification\n\n`;

      if (plan.verification.targeted?.length) {
        md += `### Targeted Checks\n\n`;
        plan.verification.targeted.forEach((check: any) => {
          const parts = [
            `- \`${check.id}\``,
            check.policy ? `policy: \`${check.policy}\`` : '',
            check.run ? `run: \`${check.run}\`` : '',
            check.reason ? `reason: ${check.reason}` : '',
          ].filter(Boolean);
          md += `${parts.join(' | ')}\n`;
        });
        md += '\n';
      }

      if (plan.verification.waivers?.length) {
        md += `### Waivers\n\n`;
        plan.verification.waivers.forEach((waiver: any) => {
          md += `- \`${waiver.id}\` — ${waiver.reason}\n`;
        });
        md += '\n';
      }
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
   * @param trackerDir - Artifact namespace for the active repo/tracker
   * @param ticketKey - Ticket identifier
   * @param retainedPlanPath - Newly selected standard plan path
   * @returns void
   */
  private deleteSiblingPlanArtifacts(
    trackerDir: string,
    sourceName: string,
    sourceKind: 'ticket' | 'custom',
    currentAction: ResolutionAction,
    retainedPlanPath: string,
  ): void {
    const actions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
    const extensions: Array<'json' | 'md' | 'yaml' | 'yml'> = [
      'json',
      'md',
      'yaml',
      'yml',
    ];
    const planHash = hashPlanArtifactSources([sourceName]);

    for (const siblingAction of actions) {
      for (const extension of extensions) {
        const hashedSiblingPath = path.join(
          trackerDir,
          buildPlanArtifactFilename({
            hash: planHash,
            action: siblingAction,
            format: extension,
          }),
        );
        const legacySiblingPath = path.join(
          trackerDir,
          sourceKind === 'ticket'
            ? `${sourceName}-plan-${siblingAction}.${extension}`
            : `${sourceName}-${siblingAction}.${extension}`,
        );

        for (const siblingPath of [hashedSiblingPath, legacySiblingPath]) {
          if (
            siblingPath === retainedPlanPath ||
            siblingAction === currentAction ||
            !fs.existsSync(siblingPath)
          ) {
            continue;
          }

          this.logger.warn(`Deleting stale plan artifact: ${siblingPath}`);
          fs.unlinkSync(siblingPath);
          const siblingManifestPath = path.join(
            trackerDir,
            `${path.basename(siblingPath).replace(/\.[^.]+$/, '')}.sources.json`,
          );
          if (fs.existsSync(siblingManifestPath)) {
            fs.unlinkSync(siblingManifestPath);
          }
        }
      }
    }
  }

  /**
   * Generate a collision-resistant custom plan stem under the active artifact namespace.
   *
   * @param trackerDir - Artifact namespace for the active repo/tracker
   * @param action - Resolution action suffix
   * @returns Unique mnemonic stem without the trailing action or extension
   */
  private generateUniqueCustomPlanStem(
    trackerDir: string,
    action: ResolutionAction,
  ): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stem = generateMnemonic();
      const hasCollision = ['json', 'md', 'yaml'].some((extension) =>
        fs.existsSync(path.join(trackerDir, `${stem}-${action}.${extension}`)),
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
   * Filename-only sources prefer the targeted repo's `~/.wf/<repo>/` custom
   * artifact namespace when `--repos` is supplied.
   *
   * @param source - Raw `--custom` CLI value
   * @param baseDir - Repo-aware base directory
   * @param repos - Optional repo list supplied via `--repos`
   * @returns Absolute or cwd-relative source path
   */
  private resolveCustomSourcePath(
    source: string,
    baseDir: string,
    repos?: string[],
  ): string {
    if (path.isAbsolute(source)) {
      return source;
    }

    if (repos?.length && path.dirname(source) === '.') {
      const matches = (repos ?? [])
        .map((repo) =>
          path.join(
            resolveCustomArtifactDir(resolveRepoBasePath(repo)),
            source,
          ),
        )
        .filter((candidate) => fs.existsSync(candidate));

      if (matches.length > 1) {
        throw new Error(
          `Custom source "${source}" matches multiple repositories: ${matches.join(', ')}`,
        );
      }

      if (matches.length === 1) {
        return matches[0];
      }
    }

    const cwdCandidate = path.resolve(source);
    if (fs.existsSync(cwdCandidate)) {
      return cwdCandidate;
    }

    if (path.dirname(source) === '.') {
      return path.join(resolveCustomArtifactDir(baseDir), source);
    }

    return path.resolve(artifactBasePathForSourceFallback(repos), source);
  }

  /**
   * Resolve the set of repository names that are valid for the current plan.
   *
   * @param baseDir - Repo-aware base directory
   * @param repos - Optional repos argument from the CLI
   * @returns Normalized repository names accepted in plan metadata
   */
  private resolveExpectedRepositories(
    baseDir: string,
    repos?: string[],
  ): string[] {
    const normalizedRepos = (repos ?? [])
      .map((repo) => path.basename(resolveRepoBasePath(repo)))
      .filter(Boolean);

    if (normalizedRepos.length > 0) {
      return [...new Set(normalizedRepos)];
    }

    return [path.basename(path.resolve(baseDir))];
  }

  /**
   * Validate generated plan metadata before persisting it to disk.
   * Also normalizes repo-root verification commands so downstream stages see a
   * portable artifact instead of a consumer-specific `cd <repo> && ...` wrapper.
   *
   * @param plan - Generated plan content
   * @param selectedRepoDir - Directory used as the repository root for plan execution
   * @param expectedRepositories - Repository names allowed for this plan
   * @returns Nothing; throws when the plan metadata is incompatible
   */
  private validateGeneratedPlan(
    plan: RepoAwarePlan,
    selectedRepoDir: string,
    expectedRepositories: string[],
  ): void {
    const repositoriesAffected = plan.repositoriesAffected ?? [];
    const filesAffected = plan.filesAffected ?? [];

    if (repositoriesAffected.some((repository) => repository === 'repo-name')) {
      throw createPlanValidationError(
        'placeholder repository metadata found in repositoriesAffected.',
      );
    }

    if (filesAffected.some((filePath) => filePath.startsWith('repo-name/'))) {
      throw createPlanValidationError(
        'placeholder repository metadata found in filesAffected.',
      );
    }

    if (expectedRepositories.length > 0 && repositoriesAffected.length === 0) {
      throw createPlanValidationError(
        `repositoriesAffected must be present and limited to: ${expectedRepositories.join(', ')}.`,
      );
    }

    const unexpectedRepositories = repositoriesAffected.filter(
      (repository) => !expectedRepositories.includes(repository),
    );
    if (unexpectedRepositories.length > 0) {
      throw createPlanValidationError(
        `repositoriesAffected contains out-of-scope repositories: ${unexpectedRepositories.join(', ')}.`,
      );
    }

    const invalidFiles = filesAffected.filter((filePath) => {
      const [prefix] = filePath.split('/');
      return !prefix || !repositoriesAffected.includes(prefix);
    });
    if (invalidFiles.length > 0) {
      throw createPlanValidationError(
        `filesAffected must use explicit repository prefixes from repositoriesAffected. Invalid entries: ${invalidFiles.join(', ')}.`,
      );
    }

    if (plan.verification?.targeted?.length) {
      plan.verification.targeted = plan.verification.targeted.map((check) => ({
        ...check,
        run:
          typeof check.run === 'string'
            ? normalizeVerificationRunCommand(check.run, selectedRepoDir)
            : check.run,
      }));
    }

    const invalidVerificationCommand = plan.verification?.targeted?.find(
      (check) => {
        const reasonText = [check.reason, check.id].filter(Boolean).join(' ');
        return (
          describesExpectedFailure(reasonText) &&
          !usesAssertionWrapper(check.run)
        );
      },
    );
    if (invalidVerificationCommand) {
      throw createPlanValidationError(
        `verification command "${invalidVerificationCommand.run}" must assert expected failure inside the command so it exits 0 on success.`,
      );
    }

    const escapedRepoVerificationCommand = plan.verification?.targeted?.find(
      (check) =>
        typeof check.run === 'string' &&
        escapesSelectedRepo(check.run, selectedRepoDir),
    );
    if (escapedRepoVerificationCommand) {
      throw createPlanValidationError(
        `verification command "${escapedRepoVerificationCommand.run}" must not change directories outside the selected repository; commands run from the repo root already.`,
      );
    }
  }
}

const artifactBasePathForSourceFallback = (repos?: string[]): string =>
  resolveRepoBasePath(repos?.[0]);
