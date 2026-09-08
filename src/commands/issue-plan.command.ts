import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService, normalizeFileEntries } from '../integrations/ai/ai.service';
import { LoggerService } from '../shared/logger/logger.service';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ValidationError } from '../shared/utils/errors';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import type { planVerificationConfigSchema } from '../shared/schemas/verification.schema';
import type { z } from 'zod';
import { getPlanArtifactExtension,
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../shared/utils/plan-artifact';
import { extractFigmaLinks, resolvePostParseFigmaLinks } from '../shared/utils/extract-figma-links';
import { resolveArtifactDir, resolveCustomArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { resolveCustomSourcePath } from '../shared/utils/custom-source';
import { parseReposOption } from './utils/repos-option';
import { printCommandHeader } from '../shared/utils/command-header.helper';
import type { ResolutionAction } from '../agents/interfaces';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';
import { PlanStageService } from '../workflows/stages/plan-stage.service';
import { ensureWfHome } from '../shared/utils/ensure-wf-home';
import { detectTestInfra } from '../shared/utils/detect-test-infra';
import type { TestInfraContext, NodeInfra } from '../shared/types/detection.types';
import { validatePlanQuality } from '../shared/utils/plan-quality';
import { detectRepoConventions } from '../shared/utils/detect-repo-conventions';
import { detectPriorPlans, correlatePlans } from '../shared/utils/detect-prior-plans';
import { detectCrossRepoPatterns } from '../shared/utils/detect-cross-repo-patterns';
import { detectReuseCandidates } from '../shared/utils/detect-reuse-candidates';
import type { PlanArtifactFormat as OutputFormat } from '../shared/types/plan-artifact.types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';
import chalk from 'chalk';

interface IssuePlanOptions {
  action: ResolutionAction;
  customPlan?: string;
  ticketKey?: string;
  tracker?: string;
  force?: boolean;
  format?: OutputFormat;
  repos?: string[];
  dryRun?: boolean;
  silent?: boolean;
  sessionId?: string;
  figmaLinks?: string[];
  figma?: boolean;
}

interface RepoAwarePlan {
  affectedFiles?: (string | import('../integrations/ai/ai.service').FileEntry)[];
  affectedFilesContext?: (string | import('../integrations/ai/ai.service').FileEntry)[];
  affectedRepositories?: string[];
  verification?: {
    targeted?: Array<{
      id?: string;
      run?: string;
      reason?: string;
      policy?: string;
    }>;
  };
}

/**
 * Build a formatted plan validation error.
 *
 * @param message - Validation failure detail
 * @returns Error with consistent command-facing wording
 */
const createPlanValidationError = (message: string): ValidationError =>
  new ValidationError(`Generated plan is invalid: ${message}`);

/**
 * Detect whether a verification reason describes an expected failure case.
 *
 * @param value - Free-form verification reason or identifier text
 * @returns True when the text describes an expected failing command
 */
const describesExpectedFailure = (value?: string): boolean =>
  /expected failure|expect(?:ed)? .*fail|should fail|must fail|non-markdown|reject(?:ed|ion)?|invalid input|exit code 1/i.test(
    value ?? ''
  );

/**
 * Detect whether a verification command contains an assertion wrapper that can
 * turn an expected failure into an overall success exit code.
 *
 * @param command - Verification command text
 * @returns True when the command appears to assert on failure conditions
 */
const ASSERTION_WRAPPER_PATTERNS: string[] = [
  String.raw`(?:^|[ (])!`,
  String.raw`\|\|`,
  '&&',
  String.raw`\bif\b`,
  String.raw`\bthen\b`,
  String.raw`\belse\b`,
  String.raw`\bfi\b`,
  String.raw`\bexit\s+0\b`,
  String.raw`\btest\b`,
  String.raw`\$\?`,
  String.raw`\bsh\s+-c\b`,
  String.raw`\bbash\s+-c\b`,
  String.raw`\bzsh\s+-c\b`,
];

const ASSERTION_WRAPPER_REGEX = new RegExp(ASSERTION_WRAPPER_PATTERNS.join('|'));

const usesAssertionWrapper = (command?: string): boolean =>
  ASSERTION_WRAPPER_REGEX.test(command ?? '');

const normalizeVerificationRunCommand = (command: string, selectedRepoDir: string): string => {
  const trimmed = command.trim();
  const cdPrefixMatch = new RegExp(/^(cd)\s+(.+?)\s*(&&)\s*(.+)$/).exec(trimmed);
  if (!cdPrefixMatch) {
    return trimmed;
  }

  const [, , rawTarget, , remainder] = cdPrefixMatch;
  const target = rawTarget.trim().replaceAll(/(^['"])|(['"]$)/g, '');
  const normalizedRepoDir = path.resolve(selectedRepoDir);
  const repoName = path.basename(normalizedRepoDir);
  const normalizedRelativeTarget
    = target === repoName || target === `./${repoName}` ? normalizedRepoDir : path.resolve(selectedRepoDir, target);
  const normalizedAbsoluteTarget = path.resolve(target);

  if (normalizedRelativeTarget === normalizedRepoDir || normalizedAbsoluteTarget === normalizedRepoDir) {
    return remainder.trim();
  }

  return trimmed;
};

const escapesSelectedRepo = (command: string, selectedRepoDir: string): boolean => {
  const trimmed = command.trim();
  const cdPrefixMatch = new RegExp(/^cd\s+(.+?)\s*&&\s*(.+)$/).exec(trimmed);
  if (!cdPrefixMatch) {
    return false;
  }

  const normalized = normalizeVerificationRunCommand(trimmed, selectedRepoDir);
  return normalized === trimmed;
};

/**
 * Extract the script name from a package-manager-style verification command.
 *
 * @param command - Verification run command
 * @returns Script name when the command uses a package manager runner, undefined otherwise
 */
const extractScriptName = (command: string): string | undefined => {
  const match = new RegExp(/^(?:yarn|npm run|pnpm|pnpm run|npx|nr)\s+(\S+)/).exec(command);
  return match?.[1];
};

@Injectable()
@Command({
  name: 'issue:plan',
  description:
    'Plan ticket implementation from a local artifact or repo-scoped custom artifact. '
    + 'If a local artifact is not found, the command will attempt to fetch it from the primary tracker. '
    + 'Use --force to fetch and recreate artifacts. '
    + 'Repo-scoped planning inspects prior plan artifacts anywhere under ~/.wf/<repo>/**/* and correlates them by keyword similarity so planning prompts can reuse earlier implementation context. '
    + 'Planning prompts include detected repository test conventions and ecosystem-specific verification guidance so generated steps match local test patterns and only reference allowed command forms. '
    + 'When a design system is detected, observed element class conventions (e.g. h1–h6 heading classes, grid-gap token choices, responsive grid-cols breakpoint tiers mined from real .vue/.tsx files) are included in the plan prompt; the design-system block is omitted for non-UI tickets so the prompt stays focused. '
    + 'Existing components and composables whose names share significant vocabulary with the ticket are surfaced in the plan prompt as reuse candidates so the planner can reference them before creating new files; repos that place UI files outside `app/components` or `app/composables` receive no candidates. '
    + 'Generated plans are semantically validated before they are saved: wf retries once with explicit repair feedback when a draft omits rename targets, uses a non-allowlisted verification command, or contradicts detected test conventions. '
    + 'Targeted verification commands are interpreted as repo-root-relative: redundant '
    + '`cd <repo>` prefixes are normalized away, while commands that change directories '
    + 'outside the selected repository are rejected. '
    + 'When `--figma` is passed or `stages.plan.figma` is `true`, Figma frame links found in the ticket description or acceptance criteria are extracted with their full query strings (including `?node-id=` parameters) and stored in the plan manifest, enabling Figma REST API design context injection during a later `issue:implement --figma` run and `issue:review --figma` run. '
    + 'When no inline Figma links are found but a design system is detected in the repo, an interactive prompt asks for frame links in TTY sessions; links supplied this way are stored in the manifest but are not threaded into the AI generation context.',
  arguments: '',
})
export class IssuePlanCommand extends CommandRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly presenter: CliPresenter,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly fetchStageService: FetchStageService,
    private readonly planStageService: PlanStageService
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
      throw new ValidationError(`Invalid action: ${action}. Valid actions: ${validActions.join(', ')}`);
    }
    return action as ResolutionAction;
  }

  @Option({
    flags: '-c, --custom-plan <source.md>',
    description:
      'Custom markdown source artifact to synthesize into a canonical plan (mutually exclusive with --ticket-key)',
  })
  parseCustomPlan(val: string): string {
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
      throw new ValidationError(`Invalid format: ${format}. Valid formats: ${validFormats.join(', ')}`);
    }
    return format as OutputFormat;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description: 'Space-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
    required: false,
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '--session-id <id>',
    description: 'Resume an AI provider session (e.g. Anthropic sess_*, Claude CLI, or Codex CLI session ID)',
  })
  parseSessionId(val: string): string {
    return val;
  }

  @Option({
    flags: '-s, --silent',
    description: 'Suppress decorative output and interactive prompts. Emits only the plan path for piping',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '--figma',
    description: 'Enable Figma link extraction; inline Figma links in the ticket are stored in the plan manifest for use by `issue:implement --figma` and `issue:review --figma`. Overrides `stages.plan.figma` config.',
  })
  parseFigma(): boolean {
    return true;
  }

  @Option({
    flags: '-k, --ticket-key <key>',
    description: 'Ticket key to fetch and plan (e.g. WBP-2971)',
  })
  parseTicketKey(val: string): string {
    return val;
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description: 'Tracker to fetch from if local artifact not found',
  })
  parseTracker(tracker: string): string {
    const validTrackers = ['jira', 'github', 'bitbucket'];
    if (!validTrackers.includes(tracker)) {
      throw new ValidationError(`Invalid tracker: ${tracker}. Valid trackers: ${validTrackers.join(', ')}`);
    }
    return tracker;
  }

  async run(_: string[], options?: IssuePlanOptions): Promise<void> {
    if (!options?.silent) {
      printCommandHeader('issue:plan');
    }

    await executeAsyncWithCatch({ fn: async () => {
      await ensureWfHome();
      this.validatePlanInputs(options);

      if (options?.customPlan) return this.executeCustomPlan(options);

      if (!options?.ticketKey) throw new ValidationError('Provide --ticket-key <key> or --custom-plan <source.md> for a custom plan');
      await this.executeTicketPlan(options.ticketKey, options);
    } });
  }

  private validatePlanInputs(options?: IssuePlanOptions): void {
    if (options?.ticketKey && options?.customPlan) {
      throw new ValidationError('--custom-plan cannot be used together with --ticket-key');
    }
    if (!options?.ticketKey && !options?.customPlan) {
      throw new ValidationError('Provide --ticket-key <key> or --custom-plan <source.md> for a custom plan');
    }
    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    if (options?.ticketKey && trackerName === 'bitbucket' && !options?.repos?.length) {
      throw new ValidationError('--repos is required for Bitbucket ticket fetching');
    }
  }

  private resolvePlanFormat(options?: IssuePlanOptions): OutputFormat {
    return (
      options?.format
      || (this.configService.get<string>('stages.plan.outputFormat') as OutputFormat | undefined)
      || 'json'
    );
  }

  private async executeCustomPlan(options: IssuePlanOptions): Promise<void> {
    if (!options.customPlan?.toLowerCase().endsWith('.md')) {
      throw new ValidationError('--custom-plan only accepts Markdown (.md) sources');
    }

    const ctx = this.resolveCustomPlanContext(options);

    if (options.dryRun) {
      return this.previewCustomPlanDryRun(
        ctx.sourcePath, ctx.planFilename, ctx.artifactDir, options.action, ctx.format
      );
    }

    if (!options?.silent) this.logger.info('Planning custom source ' + ctx.stem + ' (action: ' + options.action + ')...');
    if (!fs.existsSync(ctx.artifactDir)) fs.mkdirSync(ctx.artifactDir, { recursive: true });

    if (!this.returnCachedPlanIfExists(ctx.planPath, options)) await this.generateAndSaveCustomPlan(ctx, options);
  }

  private isFigmaEnabled(options: IssuePlanOptions): boolean {
    return options.figma === true || this.configService.get<boolean>('stages.plan.figma') === true;
  }

  private async generateAndSaveCustomPlan(
    ctx: ReturnType<IssuePlanCommand['resolveCustomPlanContext']>, options: IssuePlanOptions
  ): Promise<void> {
    const sourceContent = fs.readFileSync(ctx.sourcePath, 'utf-8');
    const autoLinks = this.isFigmaEnabled(options) ? extractFigmaLinks(sourceContent) : [];
    const { plan, figmaLinks } = await this.generatePlan(
      sourceContent, ctx.baseDir, { ...options, figmaLinks: autoLinks }
    );
    await this.savePlan({
      plan, planPath: ctx.planPath, format: ctx.format, action: options.action,
      hash: ctx.hash, sourceName: ctx.stem, sourceKind: 'custom', artifactDir: ctx.artifactDir, options,
      figmaLinks,
    });
  }

  private resolveCustomPlanContext(options: IssuePlanOptions) {
    const baseDir = resolveRepoBasePath(options?.repos?.[0]);
    const format = this.resolvePlanFormat(options);
    const customPlan = options.customPlan ?? '';
    const stem = path.basename(customPlan, '.md');
    const hash = hashPlanArtifactSources([stem]);
    const artifactDir = resolveCustomArtifactDir(baseDir);
    const extension = getPlanArtifactExtension(format);
    const planFilename = buildPlanArtifactFilename({ hash, action: options.action, format: extension });
    const planPath = path.join(artifactDir, planFilename);
    const sourcePath = resolveCustomSourcePath(customPlan, baseDir, options?.repos);
    return { baseDir, format, stem, hash, artifactDir, planFilename, planPath, sourcePath };
  }

  private returnCachedPlanIfExists(planPath: string, options: IssuePlanOptions): boolean {
    if (!fs.existsSync(planPath) || options?.force) {
      if (!options?.silent && options?.force && fs.existsSync(planPath)) this.logger.info('Forcing recreation of plan artifact...');
      if (!options?.silent) this.logger.info('Generating implementation plan...');
      return false;
    }
    if (options?.silent) {
      console.log(planPath);
      return true;
    }
    this.logger.info('Using existing plan: ' + planPath);
    return true;
  }

  private async executeTicketPlan(ticketKey: string, options: IssuePlanOptions): Promise<void> {
    const ctx = this.resolveTicketPlanContext(ticketKey, options);

    if (options?.dryRun) {
      return this.previewTicketPlanDryRun({
        ticketKey, trackerName: ctx.trackerName, ticketPath: ctx.ticketPath, planPath: ctx.planPath,
        format: ctx.format, action: options.action, needsFetch: ctx.needsFetch, ticketExists: ctx.ticketExists,
      });
    }

    if (!options?.silent) this.logger.info('Planning ticket ' + ticketKey + ' (action: ' + options.action + ')...');
    const ticketContent = await this.resolveTicketContent(
      ticketKey, ctx.trackerName, ctx.baseDir, ctx.needsFetch, options
    );

    if (!this.returnCachedPlanIfExists(ctx.planPath, options)) {
      await this.generateAndSaveTicketPlan(ticketKey, ticketContent, ctx, options);
    }
  }

  private async generateAndSaveTicketPlan(
    ticketKey: string, ticketContent: string,
    ctx: ReturnType<IssuePlanCommand['resolveTicketPlanContext']>, options: IssuePlanOptions
  ): Promise<void> {
    const autoLinks = this.isFigmaEnabled(options) ? extractFigmaLinks(ticketContent) : [];
    const { plan, figmaLinks } = await this.generatePlan(
      ticketContent, ctx.baseDir, { ...options, ticketKey, figmaLinks: autoLinks }
    );
    await this.savePlan({
      plan, planPath: ctx.planPath, format: ctx.format, action: options.action,
      hash: ctx.hash, sourceName: ticketKey, sourceKind: 'ticket',
      artifactDir: ctx.trackerDir, options, trackerName: ctx.trackerName,
      figmaLinks,
    });
  }

  private resolveTicketPlanContext(ticketKey: string, options: IssuePlanOptions) {
    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    const baseDir = resolveRepoBasePath(options?.repos?.[0]);
    const format = this.resolvePlanFormat(options);
    const trackerDir = resolveArtifactDir(baseDir, trackerName);
    const ticketPath = path.join(trackerDir, ticketKey + '.md');
    const hash = hashPlanArtifactSources([ticketKey]);
    const extension = getPlanArtifactExtension(format);
    const filename = buildPlanArtifactFilename({ hash, action: options.action, format: extension });
    const planPath = path.join(trackerDir, filename);
    const ticketExists = fs.existsSync(ticketPath);
    const needsFetch = options?.force || !ticketExists;
    return { trackerName, baseDir, format, trackerDir, ticketPath, hash, planPath, ticketExists, needsFetch };
  }

  private async resolveTicketContent(
    ticketKey: string, trackerName: string, artifactBaseDir: string, needsFetch: boolean, options: IssuePlanOptions
  ): Promise<string> {
    if (needsFetch) {
      if (!options?.silent) {
        this.logger.info(options?.force ? 'Forcing recreation of ticket artifact...' : 'Local artifact not found. Fetching from tracker...');
      }
      const artifact = await this.fetchStageService.fetchArtifact(ticketKey, {
        trackerName, repo: options?.repos?.[0], baseDir: artifactBaseDir,
      });
      if (!options?.silent) this.logger.success(`✔ Ticket saved to: ${artifact.path}`);
      return artifact.content;
    }

    const artifact = this.fetchStageService.loadArtifact(ticketKey, trackerName, artifactBaseDir);
    if (!options?.silent) this.logger.info(`Using local artifact: ${artifact.path}`);
    return artifact.content;
  }

  private async generatePlan(
    content: string, baseDir: string, options: IssuePlanOptions
  ): Promise<{ plan: any; figmaLinks: string[] }> {
    const discovery = this.gatherPlanDiscoveryContext(content, baseDir, options);
    const onProgress = options?.silent ? undefined : (line: string) => this.presenter.progress(line);

    const { plan } = await this.planStageService.generatePlan(content, {
      action: options.action, ticketKey: options.ticketKey,
      affectedRepositories: options?.repos ?? [path.basename(baseDir)],
      repoDir: baseDir, ...discovery, figmaLinks: options.figmaLinks, onProgress,
      resumeProviderSessionId: options?.sessionId,
    });

    const figmaResolveOpts = { allowPrompt: !options.silent, conventions: discovery.conventions };
    const figmaLinks = this.isFigmaEnabled(options)
      ? await resolvePostParseFigmaLinks(content, options.figmaLinks ?? [], figmaResolveOpts)
      : [];
    const expectedRepos = this.resolveExpectedRepositories(baseDir, options?.repos);
    this.validateGeneratedPlan(plan, baseDir, expectedRepos, detectTestInfra(baseDir));
    this.planStageService.enrichPlanWithDirectoryConfigs(plan, baseDir);
    return { plan, figmaLinks };
  }

  private gatherPlanDiscoveryContext(content: string, baseDir: string, options: IssuePlanOptions) {
    const conventions = detectRepoConventions(baseDir);
    const priorPlans = detectPriorPlans(path.basename(baseDir));
    const planCorrelation = correlatePlans(content, priorPlans, baseDir);
    const repos = options?.repos ?? [];
    const crossRepoPatterns = repos.length > 1
      ? detectCrossRepoPatterns(baseDir, repos.slice(1).map(r => resolveRepoBasePath(r)))
      : undefined;
    const reuseCandidates = detectReuseCandidates(baseDir, content);
    return { conventions, priorPlans, planCorrelation, crossRepoPatterns, reuseCandidates };
  }

  private async savePlan(
    opts: {
      plan: any; planPath: string; format: string; action: ResolutionAction;
      hash: string; sourceName: string; sourceKind: 'ticket' | 'custom';
      artifactDir: string; options?: IssuePlanOptions; trackerName?: string;
      figmaLinks?: string[];
    }
  ): Promise<void> {
    const { plan, planPath, format, action, hash, sourceName, sourceKind,
      artifactDir, options, trackerName, figmaLinks } = opts;
    await fs.promises.writeFile(planPath, this.serializePlan(plan, format as OutputFormat), 'utf-8');
    writePlanArtifactManifest(buildPlanArtifactManifest({
      artifactPath: planPath, action, format: format as OutputFormat, hash, sourceName, sourceKind,
      createdAt: new Date(), trackerName, figmaLinks: figmaLinks?.length ? figmaLinks : undefined,
    }));
    this.deleteSiblingPlanArtifacts(artifactDir, sourceName, sourceKind, action, planPath);
    this.printPlanSummary(planPath, plan, options?.silent);
  }

  private previewCustomPlanDryRun(
    sourcePath: string, planFilename: string, artifactDir: string,
    action: ResolutionAction, format: string
  ): void {
    const exists = fs.existsSync(sourcePath);
    this.dryRunPreview.showHeader('issue:plan', '--custom (' + action + ')');
    this.dryRunPreview.previewFileRead({
      filePath: sourcePath, exists,
      sizeInKb: exists ? (fs.statSync(sourcePath).size / 1024).toFixed(2) : '0',
    });
    this.previewPlanGeneration(action);
    this.dryRunPreview.previewFileWrite({
      filePath: path.join(artifactDir, planFilename), operation: 'create', sizeEstimate: '2–8 KB',
      format, contentPreview: '{ "action": "' + action + '", "estimatedComplexity": "medium", ... }',
    });
    this.showPlanDryRunSummary(action, planFilename);
  }

  private previewPlanGeneration(action: ResolutionAction): void {
    this.dryRunPreview.previewApiCall({
      method: 'POST', endpoint: this.aiService.getProviderEndpoint('plan'), platform: this.aiService.getProviderDisplayName('plan'),
      description: 'Generate ' + action + ' plan',
      estimatedResponse: '{\n  "action": "' + action + '",\n  "estimatedComplexity": "medium",'
        + '\n  "steps": ["<step 1>", "..."],\n  "affectedFiles": ["<file>", "..."]\n}',
    });
  }

  private showPlanDryRunSummary(action: ResolutionAction, planFilename: string): void {
    this.dryRunPreview.showSummary({
      apiCallCount: 1, fileCreatedCount: 1, fileModifiedCount: 0, gitOperationCount: 0,
      terminalOutputLines: [
        '✔ Plan saved to: <artifact-dir>/' + planFilename, '',
        '  Action: ' + action, '  Complexity: <medium|high|low>',
      ],
    });
    this.dryRunPreview.showValidationResult();
  }

  private previewTicketPlanDryRun(
    opts: {
      ticketKey: string; trackerName: string; ticketPath: string; planPath: string;
      format: string; action: ResolutionAction; needsFetch: boolean; ticketExists: boolean;
    }
  ): void {
    const { ticketKey, trackerName, ticketPath, planPath, format, action, needsFetch, ticketExists } = opts;
    this.dryRunPreview.showHeader('issue:plan', ticketKey);

    if (needsFetch) {
      this.previewTicketFetch(ticketKey, trackerName, ticketPath, ticketExists);
    }
    if (!needsFetch) {
      this.dryRunPreview.previewFileRead({
        filePath: ticketPath, exists: true, sizeInKb: (fs.statSync(ticketPath).size / 1024).toFixed(2),
      });
    }

    this.previewPlanGeneration(action);
    this.previewPlanFileWrite(planPath, format, action);
    this.showTicketPlanDryRunSummary(needsFetch, ticketPath, planPath, action);
  }

  private previewTicketFetch(
    ticketKey: string, trackerName: string, ticketPath: string, ticketExists: boolean
  ): void {
    this.dryRunPreview.previewApiCall({
      method: 'GET', endpoint: '/' + trackerName + '/issues/' + ticketKey, platform: trackerName,
      description: 'Fetch ticket ' + ticketKey + ' from ' + trackerName,
      estimatedResponse: '200 OK — ticket data returned',
    });
    this.dryRunPreview.previewFileWrite({
      filePath: ticketPath, operation: ticketExists ? 'overwrite' : 'create',
      sizeEstimate: '1–5 KB', format: 'markdown', contentPreview: buildTicketMarkdownPreview(ticketKey),
    });
  }

  private previewPlanFileWrite(planPath: string, format: string, action: ResolutionAction): void {
    const jsonPreview = '{\n  "action": "' + action + '",\n  "estimatedComplexity": "medium",'
      + '\n  "summary": "<summary>",\n  "steps": ["<step 1>", "..."]\n}';
    const mdPreview = '# Implementation Plan\n\n**Action:** ' + action
      + '\n**Complexity:** medium\n\n## Summary\n<summary>\n\n## Steps\n1. <step>';
    this.dryRunPreview.previewFileWrite({
      filePath: planPath, operation: fs.existsSync(planPath) ? 'overwrite' : 'create',
      sizeEstimate: '2–8 KB', format, contentPreview: format === 'json' ? jsonPreview : mdPreview,
    });
  }

  private showTicketPlanDryRunSummary(
    needsFetch: boolean, ticketPath: string, planPath: string, action: ResolutionAction
  ): void {
    this.dryRunPreview.showSummary({
      apiCallCount: needsFetch ? 2 : 1, fileCreatedCount: needsFetch ? 2 : 1,
      fileModifiedCount: 0, gitOperationCount: 0,
      terminalOutputLines: [
        ...(needsFetch ? ['✔ Ticket saved to: ' + ticketPath] : []),
        '✔ Plan saved to: ' + planPath, '', 'Plan Summary:',
        '  Action: ' + action, '  Complexity: <medium|high|low>', '  Steps: <n>', '  Files affected: <n>',
      ],
    });
    this.dryRunPreview.showValidationResult();
  }

  private formatPlanAsMarkdown(plan: any): string {
    const resolveFileLabel = (f: any): string => typeof f === 'string' ? f : f.filePath;
    let md = '# Implementation Plan\n\n'
      + '**Action:** ' + plan.action + '\n'
      + '**Complexity:** ' + plan.estimatedComplexity + '\n\n'
      + '## Summary\n\n' + plan.summary + '\n\n';

    md += this.formatNumberedSection('## Steps', plan.steps);
    md += this.formatBulletSection('## Files Affected', plan.affectedFiles?.map(resolveFileLabel));
    md += this.formatBulletSection('## Files for Context (Read-Only)', plan.affectedFilesContext?.map(resolveFileLabel));
    md += this.formatBulletSection('## Affected Repositories', plan.affectedRepositories);
    md += this.formatVerificationSection(plan.verification);
    md += this.formatBulletSection('## Risks', plan.risks);
    return md;
  }

  private formatNumberedSection(heading: string, items?: string[]): string {
    if (!items?.length) return '';
    return heading + '\n\n' + items.map((item, i) => (i + 1) + '. ' + item).join('\n') + '\n\n';
  }

  private formatBulletSection(heading: string, items?: string[]): string {
    if (!items?.length) return '';
    return heading + '\n\n' + items.map(item => '- ' + item).join('\n') + '\n\n';
  }

  private formatVerificationSection(verification?: z.infer<typeof planVerificationConfigSchema>): string {
    if (!verification?.targeted?.length && !verification?.waivers?.length) return '';
    let md = '## Verification\n\n';
    if (verification.targeted?.length) {
      md += this.formatTargetedChecks(verification.targeted);
    }
    if (verification.waivers?.length) {
      md += '### Waivers\n\n';
      md += verification.waivers.map(w => '- `' + w.id + '` — ' + w.reason).join('\n') + '\n\n';
    }
    return md;
  }

  private formatTargetedChecks(checks: NonNullable<z.infer<typeof planVerificationConfigSchema>['targeted']>): string {
    let md = '### Targeted Checks\n\n';
    for (const check of checks) {
      const parts = [
        '- `' + check.id + '`',
        check.policy ? 'policy: `' + check.policy + '`' : '',
        check.run ? 'run: `' + check.run + '`' : '',
        check.reason ? 'reason: ' + check.reason : '',
      ].filter(Boolean);
      md += parts.join(' | ') + '\n';
    }
    return md + '\n';
  }

  /**
   * Serialize a plan object to the requested output format.
   *
   * @param plan - Parsed plan content
   * @param format - Target output format
   * @returns Serialized plan string
   */
  private serializePlan(plan: any, format: OutputFormat): string {
    switch (format) {
      case 'json':
        return JSON.stringify(plan, null, 2);
      case 'yaml':
        return YAML.stringify(plan);
      default:
        return this.formatPlanAsMarkdown(plan);
    }
  }

  /**
   * Print the plan path (silent) or a formatted summary (verbose).
   *
   * @param planPath - Absolute path to the saved plan artifact
   * @param plan - Parsed plan content
   * @param silent - Whether to suppress decorative output
   */
  private printPlanSummary(planPath: string, plan: any, silent?: boolean): void {
    if (silent) {
      console.log(planPath);
      return;
    }
    this.logger.success(`✔ Plan saved to: ${planPath}`);
    this.logger.info(`\nPlan Summary:`);
    this.logger.info(`  Action: ${plan.action}`);
    this.logger.info(`  Complexity: ${plan.estimatedComplexity}`);
    this.logger.info(`  Steps: ${plan.steps?.length || 0}`);
    this.logger.info(`  Files affected: ${plan.affectedFiles?.length || 0}`);
  }

  /**
   * Remove stale standard plan siblings so a ticket keeps exactly one standard plan.
   *
   * @param trackerDir - Artifact namespace for the active repo/tracker
   * @param sourceName
   * @param sourceKind
   * @param currentAction
   * @param retainedPlanPath - Newly selected standard plan path
   * @returns void
   */
  private deleteSiblingPlanArtifacts(
    trackerDir: string, sourceName: string, sourceKind: 'ticket' | 'custom',
    currentAction: ResolutionAction, retainedPlanPath: string
  ): void {
    const candidates = this.buildSiblingCandidates(trackerDir, sourceName, sourceKind);
    for (const candidate of candidates) {
      if (candidate === retainedPlanPath || !fs.existsSync(candidate)) continue;
      const action = this.extractActionFromPath(candidate);
      if (action === currentAction) continue;
      this.deleteArtifactWithManifest(candidate, trackerDir);
    }
  }

  private buildSiblingCandidates(
    dir: string, sourceName: string, sourceKind: 'ticket' | 'custom'
  ): string[] {
    const actions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
    const extensions: Array<'json' | 'md' | 'yaml' | 'yml'> = ['json', 'md', 'yaml', 'yml'];
    const hash = hashPlanArtifactSources([sourceName]);
    const candidates: string[] = [];
    for (const action of actions) {
      for (const ext of extensions) {
        candidates.push(path.join(dir, buildPlanArtifactFilename({ hash, action, format: ext })));
        const legacyName = sourceKind === 'ticket'
          ? sourceName + '-plan-' + action + '.' + ext
          : sourceName + '-' + action + '.' + ext;
        candidates.push(path.join(dir, legacyName));
      }
    }
    return candidates;
  }

  private extractActionFromPath(filePath: string): string {
    const match = /-(feature|fix|investigate)[-.]/.exec(path.basename(filePath));
    return match?.[1] ?? '';
  }

  private deleteArtifactWithManifest(artifactPath: string, dir: string): void {
    this.logger.warn('Deleting stale plan artifact: ' + artifactPath);
    fs.unlinkSync(artifactPath);
    const manifestPath = path.join(dir, path.basename(artifactPath).replace(/\.[^.]+$/, '') + '.sources.json');
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
  }

  /**
   * Resolve the set of repository names that are valid for the current plan.
   *
   * @param baseDir - Repo-aware base directory
   * @param repos - Optional repos argument from the CLI
   * @returns Normalized repository names accepted in plan metadata
   */
  private resolveExpectedRepositories(baseDir: string, repos?: string[]): string[] {
    const normalizedRepos = (repos ?? []).map(repo => path.basename(resolveRepoBasePath(repo))).filter(Boolean);

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
   * @param testInfra
   * @returns Nothing; throws when the plan metadata is incompatible
   */
  private validateGeneratedPlan(
    plan: RepoAwarePlan, selectedRepoDir: string,
    expectedRepositories: string[], testInfra?: TestInfraContext
  ): void {
    const repos = plan.affectedRepositories ?? [];
    const affected = normalizeFileEntries(plan.affectedFiles ?? []);
    const context = normalizeFileEntries(plan.affectedFilesContext ?? []);

    this.validatePlanMetadata(repos, affected, context, expectedRepositories);
    this.verifyFileStatuses(affected, context, selectedRepoDir);
    this.stripUnresolvableEntries(plan, affected, context);
    this.normalizeVerificationCommands(plan, selectedRepoDir);
    this.validateVerificationEcosystems(plan, testInfra);
    this.validateVerificationSemantics(plan, selectedRepoDir);
    this.validatePlanQualityRules(plan, repos, testInfra);
  }

  private validatePlanMetadata(
    repos: string[], affected: any[], context: any[], expected: string[]
  ): void {
    if (repos.includes('repo-name')) throw createPlanValidationError('placeholder repository metadata found in affectedRepositories.');
    if (affected.some(e => e.filePath.startsWith('repo-name/'))) throw createPlanValidationError('placeholder repository metadata found in affectedFiles.');
    if (context.some(e => e.filePath.startsWith('repo-name/'))) throw createPlanValidationError('placeholder repository metadata found in affectedFilesContext.');
    if (expected.length > 0 && repos.length === 0) throw createPlanValidationError(`affectedRepositories must be present and limited to: ${expected.join(', ')}.`);

    const unexpected = repos.filter(r => !expected.includes(r));
    if (unexpected.length > 0) throw createPlanValidationError(`affectedRepositories contains out-of-scope repositories: ${unexpected.join(', ')}.`);

    this.assertRepoPrefixes(affected, repos, 'affectedFiles');
    this.assertRepoPrefixes(context, repos, 'affectedFilesContext');

    const badStatus = context.filter(e => e.status === 'to-create');
    if (badStatus.length > 0) throw createPlanValidationError(`affectedFilesContext entries cannot have status "to-create" — context files must already exist. Invalid: ${badStatus.map(e => e.filePath).join(', ')}.`);
  }

  private assertRepoPrefixes(entries: any[], repos: string[], label: string): void {
    const invalid = entries.filter(e => {
      const [prefix] = e.filePath.split('/');
      return !prefix || !repos.includes(prefix);
    });
    if (invalid.length > 0) {
      throw createPlanValidationError(`${label} must use explicit repository prefixes from affectedRepositories. Invalid entries: ${invalid.map(e => e.filePath).join(', ')}.`);
    }
  }

  private verifyFileStatuses(affected: any[], context: any[], selectedRepoDir: string): void {
    const repoBaseDir = path.dirname(selectedRepoDir);
    const all = [...affected, ...context];
    for (const entry of all) {
      this.correctFileStatus(entry, repoBaseDir);
    }
    this.warnIfManyUnresolvable(all);
  }

  private correctFileStatus(entry: any, repoBaseDir: string): void {
    const [repoPrefix, ...rest] = entry.filePath.split('/');
    const fullPath = path.join(repoBaseDir, repoPrefix, ...rest);
    const exists = fs.existsSync(fullPath);
    if (exists && entry.status === 'to-create') {
      console.log(chalk.yellow(`  ⚠ ${entry.filePath}: status "to-create" but file already exists — correcting to "found"`));
      entry.status = 'found';
    }
    if (!exists && entry.status === 'found') {
      console.log(chalk.yellow(`  ⚠ ${entry.filePath}: status "found" but file does not exist — correcting to "not-found"`));
      entry.status = 'not-found';
    }
  }

  private warnIfManyUnresolvable(entries: any[]): void {
    const notFound = entries.filter(e => e.status === 'not-found').length;
    if (entries.length > 0 && notFound / entries.length > 0.5) {
      console.log(chalk.yellow(`  ⚠ More than 50% of file entries are unresolvable (${notFound}/${entries.length}) — the plan may contain hallucinated paths.`));
    }
  }

  private stripUnresolvableEntries(plan: RepoAwarePlan, affected: any[], context: any[]): void {
    const cleanAffected = affected.filter(e => e.status !== 'not-found');
    const cleanContext = context.filter(e => e.status !== 'not-found');
    if (cleanAffected.length < affected.length) {
      console.log(chalk.yellow(`  ⚠ Removed ${affected.length - cleanAffected.length} unresolvable path(s) from affectedFiles`));
    }
    if (cleanContext.length < context.length) {
      console.log(chalk.yellow(`  ⚠ Removed ${context.length - cleanContext.length} unresolvable path(s) from affectedFilesContext`));
    }
    plan.affectedFiles = cleanAffected;
    plan.affectedFilesContext = cleanContext;
  }

  private normalizeVerificationCommands(plan: RepoAwarePlan, selectedRepoDir: string): void {
    if (!plan.verification?.targeted?.length) return;
    plan.verification.targeted = plan.verification.targeted.map(check => ({
      ...check,
      run: typeof check.run === 'string' ? normalizeVerificationRunCommand(check.run, selectedRepoDir) : check.run,
    }));
  }

  private validateVerificationEcosystems(plan: RepoAwarePlan, testInfra?: TestInfraContext): void {
    if (!plan.verification?.targeted?.length || !testInfra) return;

    const eco = {
      node: testInfra.ecosystems.find((e): e is NodeInfra => e.ecosystem === 'node'),
      terraform: testInfra.ecosystems.some(e => e.ecosystem === 'terraform'),
      python: testInfra.ecosystems.some(e => e.ecosystem === 'python'),
      go: testInfra.ecosystems.some(e => e.ecosystem === 'go'),
    };

    for (const check of plan.verification.targeted) {
      const cmd = typeof check.run === 'string' ? check.run : '';
      if (!cmd) continue;
      if (/^(node -e|sh -c|bash -c|grep |test |npx )/.test(cmd) || cmd.startsWith('!')) continue;
      this.validateSingleVerificationCommand(cmd, check, eco);
    }
  }

  private validateSingleVerificationCommand(
    cmd: string, check: { policy?: string }, eco: { node?: NodeInfra; terraform: boolean; python: boolean; go: boolean }
  ): void {
    const scriptName = extractScriptName(cmd);
    const rules: Array<{ match: boolean; label: string; ecosystem: boolean }> = [
      { match: Boolean(scriptName && eco.node), label: `references script "${scriptName}" which does not exist in package.json`, ecosystem: Boolean(eco.node && scriptName && !eco.node.allScriptNames.includes(scriptName)) },
      { match: /^terraform\s/.test(cmd), label: 'uses terraform but no .tf files were detected in the repository', ecosystem: !eco.terraform },
      { match: /^(pytest|python -m pytest)\s/.test(cmd), label: 'uses pytest but no Python project files were detected in the repository', ecosystem: !eco.python },
      { match: /^go (test|vet)\s/.test(cmd), label: 'uses go but no go.mod was detected in the repository', ecosystem: !eco.go },
      { match: Boolean(scriptName && !eco.node), label: 'references a package manager script but no package.json was detected', ecosystem: true },
    ];

    for (const rule of rules) {
      if (!rule.match || !rule.ecosystem) continue;
      if (check.policy === 'enforced') throw createPlanValidationError(`verification command "${cmd}" ${rule.label}.`);
      console.log(chalk.yellow(`  ⚠ verification command "${cmd}" ${rule.label}`));
      return;
    }
  }

  private validateVerificationSemantics(plan: RepoAwarePlan, selectedRepoDir: string): void {
    const badFailure = plan.verification?.targeted?.find(check => {
      const text = [check.reason, check.id].filter(Boolean).join(' ');
      return describesExpectedFailure(text) && !usesAssertionWrapper(check.run);
    });
    if (badFailure) {
      throw createPlanValidationError(`verification command "${badFailure.run}" must assert expected failure inside the command so it exits 0 on success.`);
    }

    const escaped = plan.verification?.targeted?.find(
      check => typeof check.run === 'string' && escapesSelectedRepo(check.run, selectedRepoDir)
    );
    if (escaped) {
      throw createPlanValidationError(`verification command "${escaped.run}" must not change directories outside the selected repository; commands run from the repo root already.`);
    }
  }

  private validatePlanQualityRules(plan: RepoAwarePlan, repos: string[], testInfra?: TestInfraContext): void {
    const violations = validatePlanQuality({ plan: plan as any, affectedRepositories: repos, testInfra });
    if (violations.length === 0) return;

    const formatted = violations.map(v => `[${v.ruleId}] ${v.message}`);
    const violationLines = formatted.map(v => `    • ${v}`).join('\n');
    console.log(chalk.yellow(`  ⚠ Plan quality violations:\n${violationLines}`));
    const existingRisks = (plan as RepoAwarePlan & { risks?: string[] }).risks ?? [];
    (plan as RepoAwarePlan & { risks?: string[] }).risks = [...existingRisks, ...formatted.map(v => `[plan-quality] ${v}`)];
  }
}
