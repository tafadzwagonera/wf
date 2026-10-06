import { Command, CommandRunner, Option } from 'nest-commander';
import type { PlanRisk } from '../shared/types/ai.types';
import { formatPlanRisk } from '../shared/utils/plan-risk';
import { ensureWfHome } from '../shared/utils/ensure-wf-home';
import { ConversationService } from '../integrations/ai/conversation/conversation.service';
import { ConversationContext, WorkflowStage as ConvWorkflowStage } from '../integrations/ai/conversation/interfaces';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ValidationError } from '../shared/utils/errors';
import { assertUsableBranchNamePattern } from '../integrations/git/branch-name';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import { isRepoResolvable, resolveArtifactDir, resolveCustomArtifactDir, resolveRepoBasePath, scaffoldNewRepo } from '../agents/utils';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifestPath,
  buildSyntheticTicketArtifact,
  hashPlanArtifactSources,
  isPlanToken,
  parsePlanArtifact,
  readPlanArtifactManifest,
  resolvePlanArtifactReference as resolvePlanArtifactReferenceInDir,
  resolvePlanToken,
} from '../shared/utils/plan-artifact';
import { resolveCustomSourcePath } from '../shared/utils/custom-source';
import { resolveCommitScopeSummary } from '../shared/utils/resolve-commit-scope-summary';
import { getLoadedWfConfig, initializeWfConfig } from '../config/wf-config-loader';
import { parseReposOption } from './utils/repos-option';
import { ConfigService } from '@nestjs/config';
import { AiService, REVIEW_VERDICT_APPROVED, REVIEW_VERDICT_CHANGES_REQUESTED } from '../integrations/ai/ai.service';
import { ReviewPresenter } from '../shared/presentation/review-presenter.service';
import { printCommandHeader } from '../shared/utils/command-header.helper';
import { withRepoLock } from '../shared/utils/repo-lock';
import chalk from 'chalk';
import inquirer from 'inquirer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import {
  TicketArtifact,
  PlanArtifact,
  ReviewArtifact,
  ResolutionAction,
  ImplementerOptions,
  ImplementerResult,
} from '../agents/interfaces';
import type { ModelRouting } from '../agents/interfaces';
import { isResumableBackend, SessionService } from '../shared/session/session.service';
import type { PlanTokenResolution } from '../shared/types/plan-artifact.types';
import type { ProviderSessionCandidate, SessionState, StageConfigFingerprint } from '../shared/types/session.types';
import { resolveDefaultStageBackend, type StageBackendDefaultStageName } from '../config/stage-backend-defaults';
import { resolveProviderModel } from '../integrations/ai/adapters/shared-routing';
import * as crypto from 'node:crypto';
import { resolveUiDesignScreenshots } from '../shared/utils/resolve-ui-design-screenshots';
import { selectProviderSession, type ProviderSessionSelection } from '../shared/utils/provider-session-prompt';

const wfConfigExtensions = ['.ts', '.mts', '.js', '.mjs', '.json', '.yaml', '.yml'];

type ReviewLoopContext = {
  resumeProviderSessionId?: string;
  priorStageSummary?: string;
  forkSession?: boolean;
  estimatedComplexity?: string;
  passCount?: number;
};

const validModelRouting: ModelRouting[] = ['auto', 'default', 'mechanical'];
enum WorkflowStage {
  FETCH = 'fetch',
  PLAN = 'plan',
  IMPLEMENT = 'implement',
  REVIEW = 'review',
  COMMIT = 'commit',
}

const stageOrder = [
  WorkflowStage.FETCH,
  WorkflowStage.PLAN,
  WorkflowStage.IMPLEMENT,
  WorkflowStage.REVIEW,
  WorkflowStage.COMMIT,
];

export const FORK_PASS_THRESHOLD = 5;

export const shouldForkReviewSession = (
  estimatedComplexity: string | undefined,
  passCount: number | undefined,
  resumeSessionId: string | undefined
): boolean => {
  if (!resumeSessionId) return false;
  if (estimatedComplexity === 'high') return true;
  return passCount !== undefined && passCount > FORK_PASS_THRESHOLD;
};

interface IssueOptions {
  action?: string;
  branch?: boolean;
  branchNamePattern?: string;
  customPlan?: string;
  dryRun?: boolean;
  force?: boolean;
  from?: string;
  modelRouting?: string;
  noBranch?: boolean;
  pr?: boolean;
  repos?: string[];
  sessionId?: string;
  silent?: boolean;
  sonar?: boolean;
  figma?: boolean;
  uiDesignScreenshots?: boolean | string[];
  skipInstall?: boolean;
  ticketKey?: string;
  to?: string;
  tracker?: string;
}

interface ResolvedWorkflowContext {
  action: ResolutionAction | undefined;
  customSourcePath?: string;
  fromStage: WorkflowStage;
  options: IssueOptions;
  preloadedSession?: SessionState;
  planTokenResolution?: PlanTokenResolution;
  repoBaseDir: string;
  repos: (string | undefined)[];
  skipExisting: boolean;
  stagesToRun: WorkflowStage[];
  ticketKey: string;
  toStage: WorkflowStage;
  trackerDir: string;
  trackerName: string;
}

interface StageSessionResult {
  providerSessionSelection?: ProviderSessionSelection;
  sessionContext: { resumeProviderSessionId?: string; priorStageSummary?: string };
  sessionState: SessionState | undefined;
}

interface DryRunStageCounters {
  terminalLines: string[];
  totalApiCalls: number;
  totalFilesCreated: number;
}

type ReviewRepoContext = {
  isMultiRepo: boolean;
  options: IssueOptions;
  planArtifact: PlanArtifact | undefined;
  primaryRepo?: string;
  repos: (string | undefined)[];
  sessionContext: ReviewLoopContext;
  ticketArtifact: TicketArtifact;
  ticketKey: string;
};

@Command({
  name: 'issue',
  description:
    'Complete workflow: fetch, plan, implement, review, and commit. Use --from and --to to control stage range. '
    + 'Pass --repos to specify repositories: the first repo anchors artifact storage; remaining repos expand execution context. '
    + 'Resuming from `--from implement` can accept a hashed plan token or a hashed plan filename; if `--action` is provided, it is validated against the resolved artifact. '
    + 'When `--session-id` is provided, the command resumes saved workflow metadata and rejects a redundant positional plan token.',
  arguments: '[plan-token]',
  options: { isDefault: false },
})
export class IssueCommand extends CommandRunner {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly configService: ConfigService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly agents: AgentOrchestrator,
    private readonly aiService: AiService,
    private readonly sessionService: SessionService,
    private readonly reviewPresenter: ReviewPresenter,
  ) {
    super();
  }

  @Option({
    flags: '-a, --action <action>',
    description:
      'Resolution action type (feature|fix|investigate) - required for PLAN stage, optional when resuming from a hashed plan artifact',
  })
  parseAction(val: string): string {
    return val;
  }

  @Option({
    flags: '--branch-name-pattern <pattern>',
    description: 'Override the enforced branch name validation regex from git.branchNamePattern config; must compile as a valid regex',
  })
  parseBranchNamePattern(val: string): string {
    return val;
  }

  @Option({
    flags: '-c, --custom-plan <source.md>',
    description: 'Path to a custom markdown plan source; skips the fetch stage',
  })
  parseCustomPlan(val: string): string {
    return val;
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the full workflow without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '--force',
    description: 'Force refetch and recreate all local artifacts, ignoring any cached files. Cannot be combined with --session-id.',
  })
  parseForce(): boolean {
    return true;
  }

  @Option({
    flags: '--from <stage>',
    description:
      'Start from stage (fetch|plan|implement|review|commit) — defaults to `plan` when `--custom-plan` is provided, `implement` when a plan token is provided, or the saved session stage when `--session-id` is used',
  })
  parseFrom(val: string): string {
    return val;
  }

  @Option({
    flags: '--model-routing <mode>',
    description:
      'Model selection strategy for implement stage: auto (complexity, targeted-write, step-count, and pattern routing), default (force default model), mechanical (force cheaper model). Defaults to auto.',
  })
  parseModelRouting(val: string): string {
    if (!validModelRouting.includes(val as ModelRouting)) {
      throw new ValidationError(
        `Invalid --model-routing value: ${val}. Must be one of: ${validModelRouting.join(', ')}`
      );
    }
    return val;
  }

  @Option({
    flags: '--no-branch',
    description: 'Suppress branch creation; work directly on the current branch',
  })
  parseNoBranch(): boolean {
    return false;
  }

  @Option({
    flags: '--pr',
    description: 'After the COMMIT stage, print a hint to run wf issue:pr',
  })
  parsePr(): boolean {
    return true;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; the first repository reference acts as both the artefact repository and execution context. The remaining repository references are strictly execution contexts for a multi-repository issue',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '--session-id <id>',
    description:
      'Resume a wf session by UUID (persisted to ~/.wf/state/sessions/); resumes saved workflow metadata and cannot be combined with a positional plan token',
  })
  parseSessionId(val: string): string {
    return val;
  }

  @Option({
    flags: '-s, --silent',
    description: 'Suppress decorative output and interactive prompts. Emits only artifact paths (per stage) for piping',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '--sonar',
    description: 'Enable the SonarQube CLI scan during the REVIEW stage, overriding stages.review.sonar config',
  })
  parseSonar(): boolean {
    return true;
  }

  @Option({
    flags: '--figma',
    description: 'Enable Figma link extraction during PLAN and design-conformance checks during IMPLEMENT and REVIEW, overriding stages.plan.figma, stages.implement.figma, and stages.review.figma config',
  })
  parseFigma(): boolean {
    return true;
  }

  @Option({
    flags: '--ui-design-screenshots [files...]',
    description: 'Local design screenshots (PNG/JPEG/WebP) injected during plan generation; paths stored in the plan artifact and re-read at review time. Mutually exclusive with --figma.',
  })
  parseUiDesignScreenshots(val: string, previous: string[] = []): string[] {
    return [...previous, val];
  }

  @Option({
    flags: '--skip-install',
    description: 'Skip automatic dependency install after branch pull',
  })
  parseSkipInstall(): boolean {
    return true;
  }

  @Option({
    flags: '-k, --ticket-key <key>',
    description: 'Ticket key to run the full workflow for (e.g. WBP-2971)',
  })
  parseTicketKey(val: string): string {
    return val;
  }

  @Option({
    flags: '--to <stage>',
    description: 'Stop at stage (fetch|plan|implement|review|commit) - defaults to commit',
  })
  parseTo(val: string): string {
    return val;
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description: 'Tracker to use (jira|github|bitbucket)',
  })
  parseTracker(val: string): string {
    return val;
  }

  async run(passedParams: string[], options?: IssueOptions): Promise<void> {
    await ensureWfHome();
    if (options?.branch === false) {
      options.noBranch = true;
    }

    await executeAsyncWithCatch({ fn: async () => {
      const ctx = await this.validateAndResolveInputs(passedParams, options);

      if (ctx.options?.dryRun) {
        return this.previewDryRun(ctx);
      }

      this.printWorkflowHeader(ctx);
      await withRepoLock(ctx.repoBaseDir, () => this.executeWorkflow(ctx));
    } });
  }

  private async validateAndResolveInputs(
    passedParams: string[], options?: IssueOptions
  ): Promise<ResolvedWorkflowContext> {
    if (!options?.silent) printCommandHeader('issue');

    const planToken = passedParams[0];
    if (planToken && options?.sessionId) {
      throw new ValidationError('Provide either --session-id or a plan token, not both');
    }
    if (options?.force && options?.sessionId) {
      throw new ValidationError(
        '--force and --session-id are mutually exclusive.\n'
        + '  Sessions are immutable — use --force without --session-id to start fresh,\n'
        + '  or use --session-id without --force to resume an existing session.'
      );
    }
    const { options: mergedOptions, preloadedSession } = await this.loadAndMergeSessionDefaults(options);
    const validatedOptions = this.validateInputExclusions(planToken, mergedOptions);
    return this.buildResolvedWorkflowContext(planToken, validatedOptions, preloadedSession);
  }

  private async loadAndMergeSessionDefaults(
    options?: IssueOptions
  ): Promise<{ options?: IssueOptions; preloadedSession?: SessionState }> {
    if (!options?.sessionId) return { options };

    const session = await this.sessionService.load(options.sessionId);
    if (!session) return this.resetMissingSessionOption(options);
    if (this.sessionService.isExpired(session)) return this.resetExpiredSessionOption(options);

    const mergedOptions = { ...options };
    this.applySessionSourceDefaults(mergedOptions, session);
    this.applySessionStageDefaults(mergedOptions, session);

    return { options: mergedOptions, preloadedSession: session };
  }

  private buildResolvedWorkflowContext(
    planToken: string | undefined,
    validatedOptions: IssueOptions,
    preloadedSession?: SessionState
  ): ResolvedWorkflowContext {
    const { fromStage, toStage, stagesToRun } = this.resolveStageRange(validatedOptions);
    const trackerName = validatedOptions?.tracker || getLoadedWfConfig().tracker;
    const repoBaseDir = resolveRepoBasePath(validatedOptions.repos?.[0]);
    const trackerDir = resolveArtifactDir(repoBaseDir, trackerName);
    const { ticketKey, customSourcePath, planTokenResolution } = this.resolveSourceInputs(
      planToken, validatedOptions, stagesToRun, repoBaseDir, trackerDir
    );

    return {
      ticketKey, action: this.resolveAction(validatedOptions?.action, stagesToRun),
      fromStage, toStage, stagesToRun, trackerName, repoBaseDir, trackerDir,
      repos: validatedOptions.repos?.length ? validatedOptions.repos : [undefined],
      skipExisting: !validatedOptions?.force, customSourcePath, planTokenResolution,
      options: validatedOptions, preloadedSession,
    };
  }

  private async resetMissingSessionOption(
    options: IssueOptions
  ): Promise<{ options: IssueOptions; preloadedSession?: SessionState }> {
    if (!options.sessionId) return { options };
    await this.handleMissingSession(options.sessionId);
    return { options: { ...options, sessionId: undefined } };
  }

  private resetExpiredSessionOption(
    options: IssueOptions
  ): { options: IssueOptions; preloadedSession?: SessionState } {
    console.log(chalk.yellow(`  Session ${options.sessionId} expired — starting fresh`));
    return { options: { ...options, sessionId: undefined } };
  }

  private applySessionSourceDefaults(options: IssueOptions, session: SessionState): void {
    const sourceType = session.sourceType ?? (session.customPlanRef ? 'custom' : 'ticket');
    if (sourceType === 'custom') {
      if (session.customPlanRef) options.customPlan ??= session.customPlanRef;
      else options.ticketKey ??= session.ticketKey;
      return;
    }

    options.ticketKey ??= session.ticketKey;
  }

  private applySessionStageDefaults(options: IssueOptions, session: SessionState): void {
    options.action ??= session.action ?? undefined;
    options.to ??= session.toStage ?? 'commit';
    options.from ??= this.sessionService.inferNextStage(session) ?? undefined;
  }

  private validateInputExclusions(planToken: string | undefined, options?: IssueOptions): IssueOptions {
    this.assertMutualExclusions(planToken, options);
    this.assertBranchNamePatternFlag(options?.branchNamePattern);
    return this.resolveFromStage(planToken, options);
  }

  private assertBranchNamePatternFlag(pattern?: string): void {
    assertUsableBranchNamePattern(pattern, '--branch-name-pattern');
  }

  // eslint-disable-next-line max-lines-per-function
  private assertMutualExclusions(planToken: string | undefined, options?: IssueOptions): void {
    if (options?.noBranch && options?.branchNamePattern) {
      throw new ValidationError(
        '--no-branch and --branch-name-pattern are mutually exclusive.\n'
        + '  Use --no-branch to stay on the current branch, or\n  Use --branch-name-pattern <pattern> to validate a generated branch name.'
      );
    }
    if (options?.figma && options?.uiDesignScreenshots !== undefined) {
      throw new ValidationError(
        '--figma and --ui-design-screenshots are mutually exclusive.\n'
        + '  Use --figma to pull design context from Figma links embedded in the ticket, or\n'
        + '  Use --ui-design-screenshots to supply local design screenshots.'
      );
    }
    if (options?.ticketKey && options?.customPlan) {
      throw new ValidationError('Provide either --ticket-key or --custom-plan, not both');
    }
    if (planToken && options?.customPlan) {
      throw new ValidationError('Provide either a plan token or --custom-plan, not both');
    }
    if (!options?.ticketKey && !options?.customPlan && !planToken) {
      throw new ValidationError(
        'Provide --ticket-key <key>, --custom-plan <source.md>, or a plan token\n'
        + 'Usage: wf issue [plan-token] --from <stage> [--to <stage>] [options]\n'
        + 'Example: wf issue -k WBP-2971 --from fetch --to review --action fix'
      );
    }
  }

  private resolveFromStage(planToken: string | undefined, options?: IssueOptions): IssueOptions {
    let resolved = options ?? {} as IssueOptions;
    if (planToken && isPlanToken(planToken) && !resolved.from) {
      resolved = { ...resolved, from: 'implement' };
    }
    if (resolved.customPlan && !resolved.from) {
      resolved = { ...resolved, from: 'plan' };
    }
    if (!resolved.from) {
      throw new ValidationError(
        '--from option is required\n'
        + 'Usage: wf issue [plan-token] --from <stage> [--to <stage>] [options]\n'
        + 'Stages: fetch|plan|implement|review|commit\n'
        + 'Example: wf issue -k WBP-2971 --from fetch --to review --action fix'
      );
    }
    return resolved;
  }

  private resolveStageRange(options: IssueOptions): {
    fromStage: WorkflowStage; toStage: WorkflowStage; stagesToRun: WorkflowStage[];
  } {
    let fromStage = this.parseStage(this.requireFromStage(options));
    const toStage = options.to ? this.parseStage(options.to) : WorkflowStage.COMMIT;

    if (options?.customPlan && fromStage === WorkflowStage.FETCH) {
      console.log(chalk.yellow('⚠  Custom plans skip the fetch stage; starting from plan.'));
      fromStage = WorkflowStage.PLAN;
    }

    if (stageOrder.indexOf(fromStage) > stageOrder.indexOf(toStage)) {
      throw new ValidationError(
        `Invalid stage range: --from ${fromStage} --to ${toStage}. `
        + `The --from stage must come before or equal the --to stage.`
      );
    }

    return { fromStage, toStage, stagesToRun: this.getStagesToRun(fromStage, toStage) };
  }

  private resolveSourceInputs(
    planToken: string | undefined, options: IssueOptions,
    stagesToRun: WorkflowStage[], repoBaseDir: string, trackerDir: string
  ): { ticketKey: string; customSourcePath?: string; planTokenResolution?: PlanTokenResolution } {
    let ticketKey = options?.ticketKey ?? planToken ?? '';

    let customSourcePath: string | undefined;
    if (options?.customPlan) {
      if (!options.customPlan.toLowerCase().endsWith('.md')) {
        throw new ValidationError('--custom-plan only accepts Markdown (.md) sources');
      }
      customSourcePath = resolveCustomSourcePath(options.customPlan, repoBaseDir, options?.repos);
      ticketKey = path.basename(options.customPlan, '.md');
    }

    const planTokenResolution = this.resolvePlanTokenIfNeeded(planToken, options, stagesToRun, trackerDir, repoBaseDir);
    if (planTokenResolution?.kind === 'ticket') ticketKey = planTokenResolution.ticketKey;
    if (planTokenResolution?.kind === 'custom') ticketKey = planTokenResolution.sourceName;

    return { ticketKey, customSourcePath, planTokenResolution };
  }

  private resolvePlanTokenIfNeeded(
    planToken: string | undefined, options: IssueOptions,
    stagesToRun: WorkflowStage[], trackerDir: string, repoBaseDir: string
  ): PlanTokenResolution | undefined {
    const laterStages = new Set([WorkflowStage.IMPLEMENT, WorkflowStage.REVIEW, WorkflowStage.COMMIT]);
    if (!planToken || options?.ticketKey || options?.customPlan) return undefined;
    if (!stagesToRun.some(s => laterStages.has(s))) return undefined;

    if (['fetch', 'plan'].includes(this.requireFromStage(options).toLowerCase())) {
      throw new ValidationError(
        'A plan token is only valid when resuming from --from implement or later.\n'
        + 'A plan token references a plan artifact that already exists.\n'
        + 'Use --ticket-key instead when running from the fetch or plan stage.'
      );
    }

    return resolvePlanToken(planToken, trackerDir, repoBaseDir);
  }

  private requireFromStage(options: IssueOptions): string {
    if (!options.from) {
      throw new ValidationError('Internal error: workflow stage resolution completed without a --from value.');
    }
    return options.from;
  }

  private resolveAction(raw?: string, stagesToRun?: WorkflowStage[]): ResolutionAction | undefined {
    if (!raw) {
      if (stagesToRun?.includes(WorkflowStage.PLAN)) {
        throw new ValidationError(
          'Error: --action is required when running PLAN stage.\n' + 'Specify: --action <feature|fix|investigate>'
        );
      }
      return undefined;
    }

    const validActions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
    if (!validActions.includes(raw as ResolutionAction)) {
      throw new ValidationError(`Invalid action: ${raw}. Must be one of: ${validActions.join(', ')}`);
    }
    return raw as ResolutionAction;
  }

  private printWorkflowHeader(ctx: ResolvedWorkflowContext): void {
    if (ctx.options?.silent) return;

    console.log(chalk.bold.cyan('\n🚀 Complete Issue Workflow'));
    console.log(chalk.gray('═'.repeat(70)));
    console.log(chalk.gray(`Ticket: ${ctx.ticketKey}`));
    console.log(chalk.gray(`Platform: ${ctx.trackerName}`));
    if (ctx.action) {
      console.log(chalk.gray(`Action: ${ctx.action}`));
    }
    console.log(chalk.gray(`Stages: ${ctx.fromStage} → ${ctx.toStage}\n`));
  }

  private async executeWorkflow(ctx: ResolvedWorkflowContext): Promise<void> {
    let sessionState = await this.initializeSession(ctx, ctx.preloadedSession);
    const artifacts = await this.resolveWorkflowArtifacts(ctx, sessionState);
    sessionState = artifacts.sessionState;

    const stageResult = await this.runWorkflowStages(ctx, artifacts, sessionState);

    if (stageResult.earlyReturn) return;
    if (stageResult.sessionState) await this.sessionService.markComplete(stageResult.sessionState);
    this.printWorkflowComplete(ctx);
  }

  private async resolveWorkflowArtifacts(
    ctx: ResolvedWorkflowContext, sessionState: SessionState | undefined
  ): Promise<{
    ticketArtifact: TicketArtifact; planArtifact: PlanArtifact | undefined;
    action: ResolutionAction | undefined; sessionState: SessionState | undefined;
  }> {
    const initial = await this.resolveInitialArtifacts(ctx, sessionState);
    const finalSession = await this.finalizePlanSession(initial.planArtifact, initial.sessionState);
    const loaded = await this.loadSkippedPlan(
      ctx, initial.ticketArtifact, initial.planArtifact, initial.action, finalSession
    );

    return { ...initial, planArtifact: loaded.planArtifact, sessionState: loaded.sessionState };
  }

  // eslint-disable-next-line max-lines-per-function
  private async resolveInitialArtifacts(
    ctx: ResolvedWorkflowContext, sessionState: SessionState | undefined
  ): Promise<{
    ticketArtifact: TicketArtifact; planArtifact: PlanArtifact | undefined;
    action: ResolutionAction | undefined; sessionState: SessionState | undefined;
  }> {
    let { action } = ctx;
    let ticketArtifact!: TicketArtifact;
    let planArtifact: PlanArtifact | undefined;

    const custom = await this.resolveCustomPlanToken(ctx.planTokenResolution, sessionState);
    if (custom) {
      ({ action, ticketArtifact, planArtifact, sessionState } = custom);
      sessionState = await this.persistResolvedSessionAction(sessionState, action);
    }

    if (!planArtifact) ticketArtifact = await this.resolveTicketArtifact(ctx);

    if (!planArtifact && action && ctx.stagesToRun.includes(WorkflowStage.PLAN)) {
      const result = await this.executePlanStage(ticketArtifact, action, ctx, sessionState);
      planArtifact = result.planArtifact;
      sessionState = result.sessionState;
      sessionState = await this.persistResolvedSessionAction(sessionState, action);
    }

    return { ticketArtifact, planArtifact, action, sessionState };
  }

  private async loadSkippedPlan(
    ctx: ResolvedWorkflowContext, ticketArtifact: TicketArtifact,
    planArtifact: PlanArtifact | undefined, action: ResolutionAction | undefined,
    sessionState: SessionState | undefined
  ): Promise<{ planArtifact: PlanArtifact | undefined; sessionState: SessionState | undefined }> {
    const planConsumers = new Set([WorkflowStage.IMPLEMENT, WorkflowStage.REVIEW]);
    const needsPlan = ctx.stagesToRun.some(s => planConsumers.has(s));
    if (planArtifact || !needsPlan) return { planArtifact, sessionState };

    const loaded = await this.agents.planner.loadFromDisk(
      ticketArtifact.path, action, ctx.options?.silent, ctx.repoBaseDir
    );
    return { planArtifact: loaded, sessionState };
  }

  private async finalizePlanSession(
    planArtifact: PlanArtifact | undefined, sessionState: SessionState | undefined
  ): Promise<SessionState | undefined> {
    if (sessionState?.stages['plan'] && !sessionState.stages['plan'].completedAt) {
      sessionState = await this.sessionService.recordStageComplete(
        sessionState, 'plan', planArtifact?.plan?.summary ?? null
      );
    }
    return sessionState;
  }

  // eslint-disable-next-line max-lines-per-function
  private async runWorkflowStages(
    ctx: ResolvedWorkflowContext,
    artifacts: { ticketArtifact: TicketArtifact; planArtifact: PlanArtifact | undefined },
    sessionState: SessionState | undefined
  ): Promise<{ sessionState: SessionState | undefined; earlyReturn: boolean }> {
    const { stagesToRun, options } = ctx;
    const { ticketArtifact, planArtifact } = artifacts;

    const primaryRepo = ctx.repos[0];
    let implementerResult: ImplementerResult | undefined;
    if (stagesToRun.includes(WorkflowStage.IMPLEMENT) && planArtifact) {
      const result = await this.executeImplementStage(
        ticketArtifact, planArtifact, ctx.repos, options, sessionState, primaryRepo
      );
      implementerResult = result.implementerResult;
      sessionState = result.sessionState;
      ctx.repos = result.expandedRepos;
      if (result.earlyReturn) return { sessionState, earlyReturn: true };
    }

    const skipReview = implementerResult?.type === 'implementation'
      && !implementerResult.hasChanges;

    if (stagesToRun.includes(WorkflowStage.REVIEW) && planArtifact?.action !== 'investigate' && !skipReview) {
      const result = await this.executeReviewStage(
        ticketArtifact, planArtifact, ctx.repos, options, sessionState,
        implementerResult, { ticketKey: ctx.ticketKey, primaryRepo }
      );
      sessionState = result.sessionState;
    } else if (skipReview && !options?.silent) {
      console.log(chalk.gray('\n  Skipping review -- no file changes from implementation'));
    }

    if (stagesToRun.includes(WorkflowStage.COMMIT) && planArtifact?.action !== 'investigate') {
      await this.executeCommitStage(ctx.ticketKey, planArtifact, ctx.repos, options, ctx.trackerName);
    }

    return { sessionState, earlyReturn: false };
  }

  private printWorkflowComplete(ctx: ResolvedWorkflowContext): void {
    if (ctx.options?.silent) return;
    console.log(chalk.bold.green('\n✔ Workflow Complete!'));
    console.log(chalk.gray('═'.repeat(70)));
    console.log(chalk.bold.cyan('\n🎯 Done!\n'));
    if (ctx.options?.pr) {
      console.log(chalk.cyan(`\n  ℹ  Run: wf issue:pr ${ctx.ticketKey} to create a pull request`));
    }
  }

  private previewDryRun(ctx: ResolvedWorkflowContext): void {
    this.dryRunPreview.showHeader('issue', ctx.ticketKey);
    console.log(chalk.gray(`   Stages : ${ctx.fromStage} → ${ctx.toStage}  |  Platform: ${ctx.trackerName}\n`));

    const counters: DryRunStageCounters = { totalApiCalls: 0, totalFilesCreated: 0, terminalLines: [] };
    const trackerDir = resolveArtifactDir(ctx.repoBaseDir, ctx.trackerName);

    for (const stage of ctx.stagesToRun) {
      const ai = this.resolveAiPreviewContext(stage);
      this.previewDryRunStage(stage, ctx, ai, trackerDir, counters);
    }

    this.showDryRunSummary(counters);
  }

  private resolveAiPreviewContext(stage: string): { endpoint: string; platform: string } {
    return {
      platform: this.aiService.getProviderDisplayName(stage),
      endpoint: this.aiService.getProviderEndpoint(stage),
    };
  }

  private previewDryRunStage(
    stage: WorkflowStage, ctx: ResolvedWorkflowContext,
    ai: { endpoint: string; platform: string }, trackerDir: string,
    counters: DryRunStageCounters
  ): void {
    this.dryRunPreview.showStageHeader(stage);

    if (this.isSkippedInvestigationStage(stage, ctx.action)) {
      this.dryRunPreview.showSkipped('investigation workflow ends at IMPLEMENT stage');
      return;
    }

    this.dispatchStageDryRun(stage, ctx, ai, trackerDir, counters);
  }

  private isSkippedInvestigationStage(stage: WorkflowStage, action?: ResolutionAction): boolean {
    const skippable = new Set([WorkflowStage.REVIEW, WorkflowStage.COMMIT]);
    return action === 'investigate' && skippable.has(stage);
  }

  // eslint-disable-next-line max-lines-per-function
  private dispatchStageDryRun(
    stage: WorkflowStage, ctx: ResolvedWorkflowContext,
    ai: { endpoint: string; platform: string }, trackerDir: string,
    counters: DryRunStageCounters
  ): void {
    switch (stage) {
      case WorkflowStage.FETCH:
        this.previewDryRunFetch(ctx.ticketKey, ctx.trackerName, trackerDir, ctx.skipExisting, counters);
        break;
      case WorkflowStage.PLAN:
        this.previewDryRunPlan(
          ctx.ticketKey, ctx.action, trackerDir, ai.endpoint, ai.platform, ctx.skipExisting, counters
        );
        break;
      case WorkflowStage.IMPLEMENT:
        this.previewDryRunImplement(
          ctx.ticketKey, ctx.action, trackerDir, ai.endpoint, ai.platform, ctx.repos, counters
        );
        break;
      case WorkflowStage.REVIEW:
        this.previewDryRunReview({
          ticketKey: ctx.ticketKey, trackerName: ctx.trackerName, trackerDir,
          aiEndpoint: ai.endpoint, aiPlatformName: ai.platform,
          repos: ctx.repos, skipExisting: ctx.skipExisting,
        }, counters);
        break;
      case WorkflowStage.COMMIT:
        this.previewDryRunCommit(ctx.ticketKey, ctx.repos, counters);
        break;
    }
  }

  private showDryRunSummary(counters: DryRunStageCounters): void {
    this.dryRunPreview.showSummary({
      apiCallCount: counters.totalApiCalls,
      fileCreatedCount: counters.totalFilesCreated,
      fileModifiedCount: 0,
      gitOperationCount: 0,
      terminalOutputLines: counters.terminalLines,
    });
    this.dryRunPreview.showValidationResult();
  }

  private previewDryRunFetch(
    ticketKey: string, trackerName: string, trackerDir: string,
    skipExisting: boolean, counters: DryRunStageCounters
  ): void {
    const ticketPath = path.join(trackerDir, `${ticketKey}.md`);
    const exists = fs.existsSync(ticketPath);

    if (skipExisting && exists) {
      this.dryRunPreview.showSkipped('artifact exists');
      return;
    }

    this.previewFetchApiAndFile(ticketKey, trackerName, ticketPath, exists);
    counters.totalApiCalls++;
    counters.totalFilesCreated++;
    counters.terminalLines.push(`✔ Ticket fetched and saved to: ${ticketPath}`);
  }

  private previewFetchApiAndFile(
    ticketKey: string, trackerName: string, ticketPath: string, exists: boolean
  ): void {
    this.dryRunPreview.previewApiCall({
      method: 'GET', endpoint: `/${trackerName}/issues/${ticketKey}`,
      platform: trackerName, description: `Fetch ticket ${ticketKey}`,
      estimatedResponse: '200 OK — ticket data',
    });
    this.dryRunPreview.previewFileWrite({
      filePath: ticketPath, operation: exists ? 'overwrite' : 'create',
      sizeEstimate: '1–5 KB', format: 'markdown',
      contentPreview: buildTicketMarkdownPreview(ticketKey),
    });
  }

  // eslint-disable-next-line max-lines-per-function
  private previewDryRunPlan(
    ticketKey: string,
    action: ResolutionAction | undefined,
    trackerDir: string,
    aiEndpoint: string,
    aiPlatformName: string,
    skipExisting: boolean,
    counters: DryRunStageCounters
  ): void {
    const defaultAction = action ?? 'feature';
    const resolvedPlan = this.safePlanResolve(ticketKey, trackerDir, defaultAction);
    const planPath = resolvedPlan?.artifactPath ?? this.buildDefaultPlanPath(ticketKey, trackerDir, defaultAction);

    if (skipExisting && resolvedPlan) {
      this.dryRunPreview.showSkipped('artifact exists');
      return;
    }

    this.previewPlanApiCall(aiEndpoint, aiPlatformName, defaultAction);
    this.previewPlanFileWrite(planPath, resolvedPlan !== null, defaultAction);
    counters.totalApiCalls++;
    counters.totalFilesCreated++;
    counters.terminalLines.push('✔ Plan saved to: ' + planPath);
  }

  private buildDefaultPlanPath(ticketKey: string, trackerDir: string, action: ResolutionAction): string {
    const planHash = hashPlanArtifactSources([ticketKey]);
    return path.join(trackerDir, buildPlanArtifactFilename({ hash: planHash, action, format: 'json' }));
  }

  private previewPlanApiCall(endpoint: string, platform: string, action: ResolutionAction): void {
    this.dryRunPreview.previewApiCall({
      method: 'POST', endpoint, platform,
      description: `Generate ${action} plan`,
      estimatedResponse: `{\n  "action": "${action}",\n  "steps": ["<step 1>", "..."],\n  "affectedFiles": ["<file>", "..."]\n}`,
    });
  }

  private previewPlanFileWrite(planPath: string, artifactExists: boolean, action: ResolutionAction): void {
    this.dryRunPreview.previewFileWrite({
      filePath: planPath,
      operation: artifactExists ? 'overwrite' : 'create',
      sizeEstimate: '2–8 KB',
      format: 'json',
      contentPreview: `{\n  "action": "${action}",\n  "estimatedComplexity": "medium",\n  "summary": "<summary>",\n  "steps": [\n    "<step 1>",\n    "<step 2>",\n    ...\n  ]\n}`,
    });
  }

  // eslint-disable-next-line max-lines-per-function
  private previewDryRunImplement(
    ticketKey: string,
    action: ResolutionAction | undefined,
    trackerDir: string,
    aiEndpoint: string,
    aiPlatformName: string,
    repos: (string | undefined)[],
    counters: DryRunStageCounters
  ): void {
    if (action === 'investigate') {
      this.previewInvestigateDryRun(ticketKey, trackerDir, aiEndpoint, aiPlatformName, counters);
      return;
    }

    for (const repo of repos) {
      this.printRepoSubheader(repos, repo);
      this.dryRunPreview.showNoSideEffects();
      console.log(chalk.gray('     Displays: branch name, implementation steps, affected files'));
      counters.totalApiCalls++;
      counters.totalFilesCreated++;
      counters.terminalLines.push(`✔ Implementation guide displayed for: ${repo ?? 'current directory'}`);
    }
  }

  private previewInvestigateDryRun(
    ticketKey: string, trackerDir: string, endpoint: string, platform: string, counters: DryRunStageCounters
  ): void {
    const findingsPath = path.join(trackerDir, `${ticketKey}-plan-investigate-findings-and-recommendations.json`);
    const responseJson = '{\n  "action": "investigate",\n  "summary": "<investigation summary>",\n  "findings": ["<finding 1>", "..."],\n  "recommendations": ["<recommendation 1>", "..."],\n  "conclusion": "<conclusion>"\n}';
    this.dryRunPreview.previewApiCall({
      method: 'POST', endpoint, platform,
      description: 'Generate investigation findings and recommendations',
      estimatedResponse: responseJson,
    });
    const contentPreview = '{\n  "action": "investigate",\n  "summary": "<summary>",\n  "findings": ["<finding>"],\n  "recommendations": ["<recommendation>"],\n  "conclusion": "<conclusion>"\n}';
    this.dryRunPreview.previewFileWrite({
      filePath: findingsPath,
      operation: fs.existsSync(findingsPath) ? 'overwrite' : 'create',
      sizeEstimate: '2–6 KB', format: 'json', contentPreview,
    });
    counters.totalApiCalls++;
    counters.totalFilesCreated++;
    counters.terminalLines.push('✔ Investigation findings saved to: ' + findingsPath);
  }

  private printRepoSubheader(repos: (string | undefined)[], repo: string | undefined): void {
    if (repos.length <= 1) return;
    console.log(chalk.bold.cyan(`\n  ── ${repo ?? 'current directory'} ──`));
  }

  // eslint-disable-next-line max-lines-per-function
  private previewDryRunReview(
    opts: {
      ticketKey: string; trackerName: string; trackerDir: string;
      aiEndpoint: string; aiPlatformName: string;
      repos: (string | undefined)[]; skipExisting: boolean;
    },
    counters: DryRunStageCounters
  ): void {
    const { ticketKey, trackerName, trackerDir, repos, skipExisting } = opts;
    for (const repo of repos) {
      this.printRepoSubheader(repos, repo);
      const repoPlatformDir = repo ? resolveArtifactDir(resolveRepoBasePath(repo), trackerName) : trackerDir;
      const reviewPath = path.join(repoPlatformDir, `${ticketKey}-review.md`);
      const artifactExists = fs.existsSync(reviewPath);

      if (skipExisting && artifactExists) {
        this.dryRunPreview.showSkipped('artifact exists');
        continue;
      }

      this.previewReviewApiAndFile(opts.aiEndpoint, opts.aiPlatformName, reviewPath, artifactExists, counters);
    }
  }

  private previewReviewApiAndFile(
    endpoint: string, platform: string, reviewPath: string, artifactExists: boolean, counters: DryRunStageCounters
  ): void {
    this.dryRunPreview.previewApiCall({
      method: 'POST', endpoint, platform,
      description: 'Review code changes (git diff)',
      estimatedResponse: '{\n  "summary": "<review summary>",\n  "approved": true,\n  "issues": [],\n  "suggestions": ["..."]\n}',
    });
    this.dryRunPreview.previewFileWrite({
      filePath: reviewPath,
      operation: artifactExists ? 'overwrite' : 'create',
      sizeEstimate: '2–5 KB',
      format: 'markdown',
      contentPreview: 'Code Review Report\nContext: <source>\n\n## Summary\n<AI review summary>\n\n## Issues Found\n(none)\n\nStatus: ✔ Approved',
    });
    counters.totalApiCalls++;
    counters.totalFilesCreated++;
    counters.terminalLines.push('✔ Review complete', '  Summary: <AI review summary>', '  Status: ✔ Approved');
  }

  private previewDryRunCommit(
    ticketKey: string,
    repos: (string | undefined)[],
    counters: DryRunStageCounters
  ): void {
    for (const repo of repos) {
      this.printRepoSubheader(repos, repo);
      this.dryRunPreview.showNoSideEffects();
      console.log(chalk.gray('     Displays: commit commands — user confirms before execution'));
      counters.terminalLines.push('✔ Commit message generated', '  Message: ' + ticketKey + ': <AI-generated>');
    }
  }

  private async initializeSession(
    ctx: ResolvedWorkflowContext,
    preloadedSession?: SessionState
  ): Promise<SessionState | undefined> {
    const { options, ticketKey } = ctx;
    let sessionState: SessionState | undefined = preloadedSession;
    let wfSessionId: string | undefined = options.sessionId;
    ({ sessionState, wfSessionId } = await this.loadRequestedSession(sessionState, wfSessionId));
    this.validateSessionOwnership(sessionState, wfSessionId, ticketKey);
    ({ sessionState } = this.dropExpiredSession(sessionState, wfSessionId));
    sessionState ||= await this.createNewSession(ctx);
    this.printSessionId(sessionState.sessionId, options?.silent);
    return sessionState;
  }

  private async loadRequestedSession(
    sessionState: SessionState | undefined,
    wfSessionId: string | undefined
  ): Promise<{ sessionState: SessionState | undefined; wfSessionId: string | undefined }> {
    if (wfSessionId && !sessionState) sessionState = (await this.sessionService.load(wfSessionId)) ?? undefined;
    if (wfSessionId && !sessionState) {
      await this.handleMissingSession(wfSessionId);
      wfSessionId = undefined;
    }
    return { sessionState, wfSessionId };
  }

  private dropExpiredSession(
    sessionState: SessionState | undefined,
    wfSessionId: string | undefined
  ): { sessionState: SessionState | undefined; wfSessionId: string | undefined } {
    if (!sessionState || !this.sessionService.isExpired(sessionState)) return { sessionState, wfSessionId };
    console.log(chalk.yellow(`  Session ${wfSessionId} expired — starting fresh`));
    return { sessionState: undefined, wfSessionId: undefined };
  }

  private async handleMissingSession(sessionId: string): Promise<void> {
    if (!this.isInteractiveSession()) {
      throw new ValidationError(`Session ${sessionId} not found. Omit --session-id to start a new session.`);
    }
    const { proceed } = await inquirer.prompt([
      { type: 'confirm', name: 'proceed', message: `Session ${sessionId} not found. Start a new session?`, prefix: ' ', default: false },
    ]);
    if (!proceed) {
      throw new ValidationError(`Session ${sessionId} not found — aborting`);
    }
  }

  private validateSessionOwnership(
    sessionState: SessionState | undefined, sessionId: string | undefined, ticketKey: string
  ): void {
    if (!sessionState) return;
    if (sessionState.ticketKey !== ticketKey) {
      throw new ValidationError(`Session ${sessionId} belongs to ${sessionState.ticketKey}, not ${ticketKey}`);
    }
  }

  private async createNewSession(ctx: ResolvedWorkflowContext): Promise<SessionState> {
    const sourceType = ctx.customSourcePath || ctx.planTokenResolution?.kind === 'custom' ? 'custom' : 'ticket';
    const sessionState: SessionState = {
      sessionId: crypto.randomUUID(),
      ticketKey: ctx.ticketKey,
      toStage: ctx.toStage,
      action: ctx.action ?? null,
      sourceType,
      customPlanRef: ctx.options.customPlan ?? null,
      sourceBranch: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      stages: {},
    };
    await this.sessionService.save(sessionState);
    return sessionState;
  }

  private printSessionId(sessionId: string | undefined, silent?: boolean): void {
    if (!silent) console.log(chalk.gray(`  wf session: ${sessionId}`));
    if (silent && sessionId) console.log(`session:${sessionId}`);
  }

  private async persistResolvedSessionAction(
    sessionState: SessionState | undefined,
    action: ResolutionAction | undefined
  ): Promise<SessionState | undefined> {
    if (!sessionState || !action || sessionState.action) return sessionState;
    const updatedSession: SessionState = {
      ...sessionState,
      action,
      updatedAt: new Date().toISOString(),
    };
    await this.sessionService.save(updatedSession);
    return updatedSession;
  }

  /**
   * Resolve a custom plan token into its ticket artifact, plan artifact,
   * and action — recording the plan stage as complete in the session.
   */
  private async buildCustomPlanArtifact(
    artifactPath: string,
    resolvedAction: ResolutionAction,
    plan: PlanArtifact['plan']
  ): Promise<PlanArtifact> {
    return { plan, action: resolvedAction, path: artifactPath };
  }

  private async resolveCustomPlanToken(
    planTokenResolution: PlanTokenResolution | undefined,
    sessionState: SessionState | undefined
  ): Promise<{
    action: ResolutionAction;
    ticketArtifact: TicketArtifact;
    planArtifact: PlanArtifact;
    sessionState: SessionState | undefined;
  } | null> {
    if (planTokenResolution?.kind !== 'custom') return null;
    const plan = parsePlanArtifact(fs.readFileSync(planTokenResolution.artifactPath, 'utf-8'), planTokenResolution.artifactPath);
    const filename = path.basename(planTokenResolution.artifactPath);
    let resolvedAction = planTokenResolution.action;
    if (plan.action !== planTokenResolution.action)
      resolvedAction = await this.resolveCustomTokenActionMismatch(plan.action, planTokenResolution.action, filename);
    const ticketArtifact = buildSyntheticTicketArtifact(planTokenResolution.artifactPath, plan);
    const planArtifact = await this.buildCustomPlanArtifact(planTokenResolution.artifactPath, resolvedAction, plan);
    sessionState = await this.recordCustomPlanSession(sessionState, planArtifact);
    return { action: resolvedAction, ticketArtifact, planArtifact, sessionState };
  }

  /**
   * Warn about a custom plan token action mismatch and let the user pick the correct action.
   *
   * @param planAction - The action stored inside the plan file
   * @param requestedAction - The action from the CLI flag or plan filename
   * @param filename - The basename of the plan file (for display)
   * @returns The action the user selected
   * @throws ValidationError when the session is non-interactive
   */
  private async resolveCustomTokenActionMismatch(
    planAction: ResolutionAction,
    requestedAction: ResolutionAction,
    filename: string
  ): Promise<ResolutionAction> {
    console.log(chalk.yellow(`  ⚠  Plan token action mismatch for ${filename}: plan contains '${planAction}', requested '${requestedAction}'.`));
    if (!this.isInteractiveSession()) {
      throw new ValidationError(`Plan token action mismatch: '${filename}' contains '${planAction}' but '${requestedAction}' was requested. Pass the correct --action or re-run interactively to choose.`);
    }
    const { selectedAction } = await inquirer.prompt<{ selectedAction: ResolutionAction }>([{
      type: 'list', name: 'selectedAction', message: 'Which action should be used?', prefix: ' ', choices: [
        { name: `Use '${planAction}' (from plan file)`, value: planAction },
        { name: `Use '${requestedAction}' (from plan token)`, value: requestedAction },
      ], default: planAction,
    }]);
    return selectedAction;
  }

  private async recordCustomPlanSession(
    sessionState: SessionState | undefined, planArtifact: PlanArtifact
  ): Promise<SessionState | undefined> {
    if (!sessionState) return sessionState;
    const started = await this.recordStageStart(sessionState, 'plan');
    return this.sessionService.recordStageComplete(started, 'plan', planArtifact.plan.summary ?? null);
  }

  /**
   * Resolve the ticket artifact from the custom source, fetcher, or disk.
   */
  private async resolveTicketArtifact(ctx: ResolvedWorkflowContext): Promise<TicketArtifact> {
    if (ctx.customSourcePath) {
      return this.loadCustomSourceArtifact(ctx.ticketKey, ctx.customSourcePath, ctx.repoBaseDir);
    }
    if (ctx.stagesToRun.includes(WorkflowStage.FETCH)) {
      return this.fetchTicketArtifact(ctx);
    }
    return this.loadTicketFromDisk(ctx);
  }

  private loadCustomSourceArtifact(ticketKey: string, sourcePath: string, repoBaseDir: string): TicketArtifact {
    return {
      ticketKey,
      content: fs.readFileSync(sourcePath, 'utf-8'),
      path: path.join(resolveCustomArtifactDir(repoBaseDir), `${ticketKey}.md`),
    };
  }

  private async fetchTicketArtifact(ctx: ResolvedWorkflowContext): Promise<TicketArtifact> {
    const artifact = await this.agents.fetcher.execute(ctx.ticketKey, {
      trackerName: ctx.trackerName, repo: ctx.options?.repos?.[0],
      skipExisting: ctx.skipExisting, baseDir: ctx.repoBaseDir, silent: ctx.options?.silent,
    });
    if (ctx.options?.silent) console.log(artifact.path);
    return artifact;
  }

  private loadTicketFromDisk(ctx: ResolvedWorkflowContext): TicketArtifact {
    const artifact = this.agents.fetcher.loadFromDisk(
      ctx.ticketKey, ctx.trackerName, ctx.repoBaseDir, ctx.options?.silent
    );
    if (ctx.options?.silent) console.log(artifact.path);
    return artifact;
  }

  /**
   * Execute the plan stage: generate a plan and offer interactive chat when the plan is fresh.
   */
  private async executePlanStage(
    ticketArtifact: TicketArtifact, action: ResolutionAction,
    ctx: ResolvedWorkflowContext, sessionState: SessionState | undefined
  ): Promise<{ planArtifact: PlanArtifact; sessionState: SessionState | undefined }> {
    sessionState &&= await this.recordStageStart(sessionState, 'plan');

    const planArtifact = await this.generatePlanArtifact(ticketArtifact, action, ctx);
    if (sessionState && planArtifact.sessionId) {
      sessionState = await this.sessionService.recordProviderSessionId(sessionState, 'plan', planArtifact.sessionId);
    }
    if (sessionState && planArtifact.modelUsed) {
      sessionState = await this.sessionService.recordStageModels(sessionState, 'plan', [planArtifact.modelUsed]);
    }
    await this.offerPlanChat(ticketArtifact, planArtifact, ctx);

    return { planArtifact, sessionState };
  }

  private async generatePlanArtifact(
    ticketArtifact: TicketArtifact, action: ResolutionAction, ctx: ResolvedWorkflowContext
  ): Promise<PlanArtifact> {
    const uiDesignScreenshots = this.resolvePlanScreenshots(ctx, ticketArtifact.ticketKey);
    const planArtifact = await this.agents.planner.execute(ticketArtifact, {
      action, skipExisting: ctx.skipExisting,
      affectedRepositories: ctx.options?.repos ?? [path.basename(ctx.repoBaseDir)],
      repoDir: ctx.repoBaseDir,
      silent: ctx.options?.silent,
      sourceKind: ctx.customSourcePath ? 'custom' : 'ticket',
      uiDesignScreenshots,
      figma: ctx.options?.figma,
    });
    if (ctx.options?.silent) console.log(planArtifact.path);
    return planArtifact;
  }

  private resolvePlanScreenshots(
    ctx: ResolvedWorkflowContext, identifier: string
  ): string[] | undefined {
    const rawScreenshots = ctx.options?.uiDesignScreenshots;
    if (!Array.isArray(rawScreenshots) && !rawScreenshots) return undefined;
    return resolveUiDesignScreenshots(
      Array.isArray(rawScreenshots) ? rawScreenshots : [], ctx.repoBaseDir, identifier
    );
  }

  private async offerPlanChat(
    ticketArtifact: TicketArtifact, planArtifact: PlanArtifact, ctx: ResolvedWorkflowContext
  ): Promise<void> {
    if (ctx.options?.silent || !this.isInteractiveSession() || planArtifact.fromCache) return;
    const { startChat } = await inquirer.prompt([
      { type: 'confirm', name: 'startChat', message: 'Would you like to discuss the plan?', prefix: ' ', default: false },
    ]);
    if (!startChat) return;
    await this.startInteractiveChat(
      ticketArtifact.ticketKey, 'plan' as ConvWorkflowStage,
      { ticketContent: ticketArtifact.content, plan: planArtifact.plan },
      resolveRepoBasePath(ctx.repos[0]), ctx.trackerName
    );
  }

  private async recordStageStart(sessionState: SessionState, stage: string): Promise<SessionState> {
    return this.sessionService.recordStageStart(
      sessionState, stage, this.resolveStageFingerprint(stage), this.resolveStageModel(stage)
    );
  }

  // eslint-disable-next-line max-lines-per-function
  private async executeImplementStage(
    ticketArtifact: TicketArtifact,
    planArtifact: PlanArtifact,
    repos: (string | undefined)[],
    options: IssueOptions,
    sessionState: SessionState | undefined,
    primaryRepo: string | undefined
  ): Promise<{
    implementerResult: ImplementerResult | undefined;
    sessionState: SessionState | undefined;
    earlyReturn: boolean;
    expandedRepos: (string | undefined)[];
    primaryRepoSessionId?: string;
  }> {
    const { sessionContext, sessionState: started } = await this.prepareStageSession(sessionState, 'implement');
    sessionState = started;
    const expandedRepos = await this.prepareImplementRepos(repos, planArtifact, options);
    const result = await this.runImplementLoop(
      ticketArtifact, planArtifact, expandedRepos, options, sessionContext, primaryRepo, sessionState
    );
    sessionState = result.sessionState ?? sessionState;
    if (result.earlyReturn) return { ...result, expandedRepos, sessionState };
    sessionState = await this.finalizeImplementSession(
      sessionState, result.implementerResult, planArtifact, result.primaryRepoSessionId
    );
    return {
      implementerResult: result.implementerResult, sessionState,
      earlyReturn: false, expandedRepos, primaryRepoSessionId: result.primaryRepoSessionId,
    };
  }

  private async prepareImplementRepos(
    repos: (string | undefined)[],
    planArtifact: PlanArtifact,
    options: IssueOptions
  ): Promise<(string | undefined)[]> {
    const basePath = resolveRepoBasePath(repos[0]);
    const expandedRepos = await this.expandReposFromPlan(repos, planArtifact, basePath, options?.silent);
    this.printStageHeader(expandedRepos.length > 1, options?.silent, '🔧 STAGE 3: Implementation Guide');
    return expandedRepos;
  }

  private async prepareStageSession(
    sessionState: SessionState | undefined, stage: string
  ): Promise<StageSessionResult> {
    if (!sessionState) return { sessionContext: {}, sessionState };

    const fingerprint = this.resolveStageFingerprint(stage);
    const validation = this.sessionService.validateForStage(
      sessionState, stage, fingerprint, s => this.resolveStageFingerprint(s)
    );
    for (const w of validation.warnings) console.log(chalk.yellow(`  ⚠ ${w}`));

    const providerSessionSelection = await this.selectStageProviderSession(
      fingerprint, validation.providerSessionCandidate
    );
    const started = await this.recordStageStart(sessionState, stage);
    return {
      providerSessionSelection,
      sessionContext: this.createStageSessionContext(providerSessionSelection, validation.priorSummary),
      sessionState: started,
    };
  }

  private createStageSessionContext(
    selection: ProviderSessionSelection, priorStageSummary: string | null
  ): StageSessionResult['sessionContext'] {
    const resumeProviderSessionId = selection.kind === 'new' ? undefined : selection.providerSessionId;
    return { resumeProviderSessionId, priorStageSummary: priorStageSummary ?? undefined };
  }

  private async selectStageProviderSession(
    fingerprint: StageConfigFingerprint, candidate: ProviderSessionCandidate | null
  ): Promise<ProviderSessionSelection> {
    if (!isResumableBackend(fingerprint)) return { kind: 'new' };
    return selectProviderSession({ candidate, fingerprint, interactive: this.isInteractiveSession() });
  }

  private printStageHeader(isMultiRepo: boolean, silent: boolean | undefined, title: string): void {
    if (!isMultiRepo || silent) return;
    console.log(chalk.bold.yellow('\n' + title));
    console.log(chalk.gray('─'.repeat(70)));
  }

  /**
   * Expands the repos list with new repositories declared in the plan.
   * Only repos listed in `plan.newRepositories` are scaffolded. Unresolvable
   * repos NOT declared as new are treated as errors (likely typos).
   *
   * @param repos - Current repos list from CLI options
   * @param planArtifact - The loaded plan artifact
   * @param baseDir - Base directory of the primary repository
   * @param silent - Whether to suppress console output
   * @returns Expanded repos list including scaffolded repos
   */
  private async expandReposFromPlan(
    repos: (string | undefined)[],
    planArtifact: PlanArtifact,
    baseDir: string,
    silent?: boolean
  ): Promise<(string | undefined)[]> {
    const newRepos = (planArtifact.plan.newRepositories ?? []).filter(r => !isRepoResolvable(r));
    this.validateUnresolvedRepos(planArtifact, newRepos);
    if (newRepos.length === 0) return repos;

    if (silent || !this.isInteractiveSession()) {
      for (const repo of newRepos) {
        const repoPath = scaffoldNewRepo(repo, baseDir);
        if (!silent) console.log(chalk.green(`  Scaffolded new repository: ${repoPath}`));
      }
      return [...newRepos, ...repos];
    }

    const readyRepos = await this.promptManualRepoSetup(newRepos, baseDir);
    if (readyRepos.length === 0) return repos;
    return [...readyRepos, ...repos];
  }

  private async promptManualRepoSetup(newRepos: string[], baseDir: string): Promise<string[]> {
    const resolved = newRepos.map(r => ({ name: r, dir: path.resolve(baseDir, '..', r) }));
    console.log(chalk.yellow('\n  The plan requires new repositories that do not exist locally.'));
    console.log(chalk.yellow('  Please create each directory and its wf.config.* file before continuing.\n'));
    for (const r of resolved) {
      console.log(chalk.cyan(`    ${r.name}`));
      console.log(chalk.gray(`      Directory:  ${r.dir}`));
      console.log(chalk.gray(`      Config:     ${r.dir}/wf.config.ts  (or .js / .json / .yaml / .yml)`));
    }
    const { ready } = await inquirer.prompt<{ ready: boolean }>([{
      type: 'confirm', name: 'ready',
      message: 'Have you created the directories and config files listed above?',
      prefix: ' ', default: false,
    }]);
    if (!ready) return [];
    this.validateNewReposExist(resolved);
    for (const r of resolved) console.log(chalk.green(`  Confirmed new repository: ${r.dir}`));
    return resolved.map(r => r.name);
  }

  private validateNewReposExist(resolved: Array<{ name: string; dir: string }>): void {
    const missing = resolved
      .map(r => {
        const dirExists = fs.existsSync(r.dir);
        const configExists = dirExists && wfConfigExtensions.some(ext =>
          fs.existsSync(path.join(r.dir, `wf.config${ext}`))
        );
        if (dirExists && configExists) return null;
        return `${r.name} (${dirExists ? 'wf.config.* not found' : 'directory not found'}: ${r.dir})`;
      })
      .filter((entry): entry is string => entry !== null);
    if (missing.length === 0) return;

    console.log(chalk.red('\n  The following repos are still missing:'));
    for (const m of missing) console.log(chalk.red(`    - ${m}`));
    console.log('');
    throw new ValidationError(
      'Cannot proceed — new repositories must have both a directory and a wf.config.* file. '
      + `Missing: ${missing.join(', ')}`
    );
  }

  /**
   * Throws if any repo in `affectedRepositories` is unresolvable and not
   * declared in `newRepositories`.
   */
  private validateUnresolvedRepos(planArtifact: PlanArtifact, newRepos: string[]): void {
    const allRepos = planArtifact.plan.affectedRepositories ?? [];
    const newSet = new Set(newRepos);
    const invalid = allRepos.filter(r => !isRepoResolvable(r) && !newSet.has(r));
    if (invalid.length === 0) return;
    throw new ValidationError(
      `Plan references repositories not found locally: ${invalid.join(', ')}. `
      + 'If these are new repos, add them to the plan\'s newRepositories field.'
    );
  }

  private buildImplementerOptions(
    repo: string | undefined, repos: (string | undefined)[], options: IssueOptions, isMultiRepo: boolean,
    sessionContext: { resumeProviderSessionId?: string; priorStageSummary?: string },
    planArtifact?: PlanArtifact
  ): ImplementerOptions {
    return {
      trackerName: options?.tracker || getLoadedWfConfig().tracker,
      repoDir: resolveRepoBasePath(repo),
      additionalRepoDirs: repos
        .filter((r): r is string => r !== undefined && r !== repo)
        .map(r => resolveRepoBasePath(r)),
      suppressHeader: isMultiRepo, allowMultiRepoScope: isMultiRepo,
      modelRouting: options.modelRouting as ModelRouting,
      silent: options.silent, noBranch: options.noBranch, branchNamePattern: options.branchNamePattern,
      skipInstall: options.skipInstall,
      isNewRepo: planArtifact?.plan.newRepositories?.includes(repo ?? '') ?? false,
      figma: options?.figma,
      ...sessionContext,
    };
  }

  // eslint-disable-next-line max-lines-per-function
  private async runImplementLoop(
    ticketArtifact: TicketArtifact, planArtifact: PlanArtifact,
    repos: (string | undefined)[], options: IssueOptions,
    sessionContext: { resumeProviderSessionId?: string; priorStageSummary?: string },
    primaryRepo: string | undefined,
    sessionState?: SessionState
  ): Promise<{
    implementerResult: ImplementerResult | undefined;
    earlyReturn: boolean;
    primaryRepoSessionId?: string;
    sessionState: SessionState | undefined;
  }> {
    const isMultiRepo = repos.length > 1;
    let implementerResult: ImplementerResult | undefined;
    let anyHasChanges = false;
    let primaryRepoSessionId: string | undefined;
    for (const repo of repos) {
      await initializeWfConfig(resolveRepoBasePath(repo));
      if (isMultiRepo && !options?.silent) this.printRepoSubheader(repos, repo);
      const scopedContext = this.scopeSessionContextToRepo(sessionContext, repo, primaryRepo);
      const result = await this.executeRepoImplementation(
        ticketArtifact, planArtifact, repo, repos, options, isMultiRepo, scopedContext
      );
      if (result.implementerResult?.type === 'implementation'
        && resolveRepoBasePath(repo) === resolveRepoBasePath(primaryRepo)) {
        primaryRepoSessionId = result.implementerResult.sessionId;
        if (sessionState && primaryRepoSessionId) {
          sessionState = await this.sessionService.recordProviderSessionId(sessionState, 'implement', primaryRepoSessionId);
        }
      }
      if (result.earlyReturn) return { ...result, primaryRepoSessionId, sessionState };
      ({ implementerResult, anyHasChanges } = this.mergeImplementResult(result.implementerResult, anyHasChanges));
    }
    return { ...this.finalizeImplementResult(implementerResult, anyHasChanges), primaryRepoSessionId, sessionState };
  }

  private mergeImplementResult(
    result: ImplementerResult | undefined, accumulator: boolean
  ): { implementerResult: ImplementerResult | undefined; anyHasChanges: boolean } {
    if (result?.type === 'implementation' && result.hasChanges) {
      return { implementerResult: result, anyHasChanges: true };
    }
    return { implementerResult: result, anyHasChanges: accumulator };
  }

  private finalizeImplementResult(
    result: ImplementerResult | undefined, anyHasChanges: boolean
  ): { implementerResult: ImplementerResult | undefined; earlyReturn: boolean } {
    if (result?.type === 'implementation') {
      result = { ...result, hasChanges: anyHasChanges };
    }
    return { implementerResult: result, earlyReturn: false };
  }

  private async executeRepoImplementation(
    ticketArtifact: TicketArtifact, planArtifact: PlanArtifact,
    repo: string | undefined, repos: (string | undefined)[],
    options: IssueOptions, isMultiRepo: boolean,
    sessionContext: { resumeProviderSessionId?: string; priorStageSummary?: string }
  ): Promise<{ implementerResult: ImplementerResult | undefined; earlyReturn: boolean }> {
    const implOpts = this.buildImplementerOptions(
      repo, repos, options, isMultiRepo, sessionContext, planArtifact);
    const result = await this.agents.implementer.execute(ticketArtifact, planArtifact, implOpts);
    if (result?.type === 'investigation') {
      console.log(chalk.bold.green('\n✔ Investigation workflow complete — no further stages will run'));
      return { implementerResult: result, earlyReturn: true };
    }
    return { implementerResult: result, earlyReturn: false };
  }

  private async finalizeImplementSession(
    sessionState: SessionState | undefined, result: ImplementerResult | undefined,
    planArtifact: PlanArtifact, primaryRepoSessionId: string | undefined
  ): Promise<SessionState | undefined> {
    const resumableSessionId = primaryRepoSessionId
      ?? (result?.type === 'implementation' ? result.sessionId : undefined);
    if (sessionState && resumableSessionId) {
      sessionState = await this.sessionService.recordProviderSessionId(sessionState, 'implement', resumableSessionId);
    }
    if (sessionState && result?.type === 'implementation' && result.modelsUsed?.length) {
      sessionState = await this.sessionService.recordStageModels(sessionState, 'implement', result.modelsUsed);
    }
    if (sessionState && result?.type === 'implementation') {
      sessionState = await this.recordSessionSourceBranch(sessionState, planArtifact);
    }
    sessionState &&= await this.sessionService.recordStageComplete(sessionState, 'implement', null);
    return sessionState;
  }

  /**
   * Copies the source branch ImplementerAgent already recorded onto the plan's manifest
   * (best-effort, at branch-creation time) onto the session too — so a later, possibly
   * separate-process `issue:review` run can recover it via `SessionService.findByTicketKey`,
   * a reliable anchor regardless of invocation path, unlike re-deriving it from git state.
   */
  private async recordSessionSourceBranch(
    sessionState: SessionState, planArtifact: PlanArtifact
  ): Promise<SessionState> {
    const manifest = readPlanArtifactManifest(buildPlanArtifactManifestPath(planArtifact.path));
    if (!manifest?.sourceBranch) return sessionState;
    return this.sessionService.recordSourceBranch(sessionState, manifest.sourceBranch);
  }

  private async executeReviewStage(
    ticketArtifact: TicketArtifact, planArtifact: PlanArtifact | undefined,
    repos: (string | undefined)[], options: IssueOptions, sessionState: SessionState | undefined,
    implementerResult: ImplementerResult | undefined,
    { ticketKey, primaryRepo }: { ticketKey: string; primaryRepo: string | undefined }
  ): Promise<{ reviewArtifact: ReviewArtifact | null; sessionState: SessionState | undefined }> {
    const passCount = implementerResult?.type === 'implementation' ? implementerResult.passCount : undefined;
    const estimatedComplexity = planArtifact?.plan.estimatedComplexity;
    const { prepared, forkSession } = await this.resolveReviewFork(sessionState, implementerResult, planArtifact);
    this.printStageHeader(repos.length > 1, options?.silent, '🔍 STAGE 4: Code Review');
    const { reviewArtifact, sessionState: loopState } = await this.runReviewLoop(
      ticketArtifact, planArtifact, repos, options,
      { ...prepared.sessionContext, forkSession, estimatedComplexity, passCount },
      { ticketKey, primaryRepo },
      prepared.sessionState
    );
    sessionState = loopState;
    sessionState &&= await this.sessionService.recordStageComplete(sessionState, 'review', null);
    return { reviewArtifact, sessionState };
  }

  /**
   * @param sessionState - current workflow session state
   * @param implementerResult - result from the implement stage (passCount, sessionId)
   * @param planArtifact - plan artifact carrying estimatedComplexity
   * @returns prepared session context and whether the review CLI session should be forked
   */
  private async resolveReviewFork(
    sessionState: SessionState | undefined,
    implementerResult: ImplementerResult | undefined,
    planArtifact: PlanArtifact | undefined,
  ): Promise<{ prepared: StageSessionResult; forkSession: boolean }> {
    const implId = implementerResult?.type === 'implementation' ? implementerResult.sessionId : undefined;
    const prepared = await this.prepareReviewSession(sessionState, implId);
    const passCount = implementerResult?.type === 'implementation' ? implementerResult.passCount : undefined;
    const forkSession = shouldForkReviewSession(
      planArtifact?.plan.estimatedComplexity, passCount, prepared.sessionContext.resumeProviderSessionId
    );
    return { prepared, forkSession };
  }

  private async recordReviewProviderSession(
    sessionState: SessionState | undefined, artifact: ReviewArtifact | null
  ): Promise<SessionState | undefined> {
    if (!sessionState || !artifact?.sessionId) return sessionState;
    return this.sessionService.recordProviderSessionId(sessionState, 'review', artifact.sessionId);
  }

  private async prepareReviewSession(
    sessionState: SessionState | undefined, implementSessionId: string | undefined
  ): Promise<StageSessionResult> {
    const prepared = await this.prepareStageSession(sessionState, 'review');
    const resumeId = prepared.providerSessionSelection?.kind === 'new'
      ? undefined
      : prepared.sessionContext.resumeProviderSessionId ?? implementSessionId ?? undefined;
    return {
      providerSessionSelection: prepared.providerSessionSelection,
      sessionContext: { ...prepared.sessionContext, resumeProviderSessionId: resumeId },
      sessionState: prepared.sessionState,
    };
  }

  private async runReviewLoop(
    ticketArtifact: TicketArtifact, planArtifact: PlanArtifact | undefined,
    repos: (string | undefined)[], options: IssueOptions,
    sessionContext: ReviewLoopContext,
    { ticketKey, primaryRepo }: { ticketKey: string; primaryRepo: string | undefined },
    sessionState: SessionState | undefined
  ): Promise<{ reviewArtifact: ReviewArtifact | null; sessionState: SessionState | undefined }> {
    const reviewContext = this.createReviewRepoContext(
      ticketArtifact, planArtifact, repos, options, sessionContext, ticketKey, primaryRepo
    );
    const { reviewArtifacts, sessionState: updated } = await this.collectReviewArtifacts(
      repos, reviewContext, sessionState
    );
    return { reviewArtifact: reviewArtifacts.at(-1) ?? null, sessionState: updated };
  }

  private async recordAndPresentReviewArtifact(
    reviewArtifact: ReviewArtifact, reviewContext: ReviewRepoContext, sessionState: SessionState | undefined
  ): Promise<SessionState | undefined> {
    sessionState = await this.recordReviewProviderSession(sessionState, reviewArtifact);
    if (sessionState && reviewArtifact.modelUsed) {
      sessionState = await this.sessionService.recordStageModels(sessionState, 'review', [reviewArtifact.modelUsed]);
    }
    await this.persistAndPresentReview(
      reviewContext.ticketArtifact, reviewContext.planArtifact, reviewArtifact, reviewContext
    );
    return sessionState;
  }

  private async collectReviewArtifacts(
    repos: (string | undefined)[],
    reviewContext: ReviewRepoContext,
    sessionState: SessionState | undefined
  ): Promise<{ reviewArtifacts: ReviewArtifact[]; sessionState: SessionState | undefined }> {
    const reviewArtifacts: ReviewArtifact[] = [];
    for (const repo of repos) {
      try {
        const reviewArtifact = await this.runReviewForRepo(repo, reviewContext);
        if (!reviewArtifact) continue;
        sessionState = await this.recordAndPresentReviewArtifact(reviewArtifact, reviewContext, sessionState);
        reviewArtifacts.push(reviewArtifact);
      } catch (error) {
        this.handleReviewLoopError(error, repo, repos, reviewContext.options);
      }
    }
    return { reviewArtifacts, sessionState };
  }

  private handleReviewLoopError(
    error: unknown,
    repo: string | undefined,
    repos: (string | undefined)[],
    options: IssueOptions
  ): void {
    if (repos.length <= 1) throw error;
    const repoLabel = repo ?? path.basename(process.cwd());
    const message = `Review failed for ${repoLabel}: ${error instanceof Error ? error.message : String(error)}`;
    if (!options?.silent) console.log(chalk.yellow(`⚠ ${message}`));
  }

  private scopeSessionContextToRepo<T extends { resumeProviderSessionId?: string }>(
    sessionContext: T,
    repo: string | undefined,
    primaryRepo: string | undefined
  ): T {
    if (!sessionContext.resumeProviderSessionId) return sessionContext;
    const isPrimary = resolveRepoBasePath(repo) === resolveRepoBasePath(primaryRepo);
    return isPrimary ? sessionContext : { ...sessionContext, resumeProviderSessionId: undefined } as T;
  }

  private async runReviewForRepo(
    repo: string | undefined,
    reviewContext: ReviewRepoContext
  ): Promise<ReviewArtifact | null> {
    await initializeWfConfig(resolveRepoBasePath(repo));
    const { isMultiRepo, options, planArtifact, primaryRepo, repos, sessionContext, ticketArtifact } = reviewContext;
    if (isMultiRepo && !options?.silent) this.printRepoSubheader(repos, repo);
    const scopedContext = this.scopeSessionContextToRepo(sessionContext, repo, primaryRepo);
    const reviewArtifact = await this.agents.reviewer.execute(ticketArtifact, {
      skipExisting: !options?.force, repoDir: resolveRepoBasePath(repo),
      suppressHeader: isMultiRepo, silent: options?.silent,
      sonar: options?.sonar, figma: options?.figma,
      planArtifactPath: planArtifact?.path, ...scopedContext,
    });
    if (!reviewArtifact) return null;

    return reviewArtifact;
  }

  private createReviewRepoContext(
    ticketArtifact: TicketArtifact,
    planArtifact: PlanArtifact | undefined,
    repos: (string | undefined)[],
    options: IssueOptions,
    sessionContext: ReviewLoopContext,
    ticketKey: string,
    primaryRepo: string | undefined
  ): ReviewRepoContext {
    return {
      isMultiRepo: repos.length > 1,
      options,
      planArtifact,
      primaryRepo,
      repos,
      sessionContext,
      ticketArtifact,
      ticketKey,
    };
  }

  private async persistAndPresentReview(
    ticketArtifact: TicketArtifact,
    planArtifact: PlanArtifact | undefined,
    reviewArtifact: ReviewArtifact,
    reviewContext: ReviewRepoContext
  ): Promise<void> {
    this.printReviewStatus(reviewArtifact, reviewContext.options?.silent);
    this.agents.reviewer.persistArtifact(reviewArtifact, ticketArtifact.ticketKey);
    if (!reviewContext.options?.silent) console.log(chalk.gray('  Saved to ' + reviewArtifact.path));
    await this.offerReviewChat(
      ticketArtifact,
      planArtifact,
      reviewArtifact,
      reviewContext.ticketKey,
      reviewContext.repos,
      reviewContext.options
    );
  }

  private printReviewStatus(artifact: ReviewArtifact, silent?: boolean): void {
    if (silent) {
      console.log(artifact.path);
      return;
    }
    this.reviewPresenter.displayReview(artifact.review);
  }

  private async offerReviewChat(
    ticketArtifact: TicketArtifact, planArtifact: PlanArtifact | undefined,
    reviewArtifact: ReviewArtifact, ticketKey: string,
    repos: (string | undefined)[], options: IssueOptions
  ): Promise<void> {
    if (options?.silent || !this.isInteractiveSession()) return;
    const { startChat } = await inquirer.prompt([
      { type: 'confirm', name: 'startChat', message: 'Would you like to discuss the review?', prefix: ' ', default: false },
    ]);
    if (!startChat) return;
    const trackerName = options?.tracker || getLoadedWfConfig().tracker;
    await this.startInteractiveChat(
      ticketKey, 'review' as ConvWorkflowStage,
      { ticketContent: ticketArtifact.content, plan: planArtifact?.plan, review: reviewArtifact.review },
      resolveRepoBasePath(repos[0]), trackerName
    );
  }

  private async commitForRepo(
    repo: string | undefined, ticketKey: string, planArtifact: PlanArtifact | undefined,
    options: IssueOptions, trackerName: string, isMultiRepo: boolean
  ): Promise<void> {
    await initializeWfConfig(resolveRepoBasePath(repo));
    this.printRepoHeader(isMultiRepo, repo, options);
    const repoDir = resolveRepoBasePath(repo);
    const scopeSummary = resolveCommitScopeSummary(
      repoDir, trackerName, ticketKey, planArtifact?.plan?.summary
    ) ?? undefined;
    if (scopeSummary && scopeSummary !== planArtifact?.plan?.summary && !options?.silent) {
      console.log(chalk.gray('  Using scope summary from prior review/plan'));
    }
    await this.agents.committer.execute(ticketKey, repoDir, scopeSummary, isMultiRepo, options?.silent);
  }

  private async executeCommitStage(
    ticketKey: string, planArtifact: PlanArtifact | undefined,
    repos: (string | undefined)[], options: IssueOptions, trackerName: string
  ): Promise<void> {
    const isMultiRepo = repos.length > 1;
    this.printStageHeader(isMultiRepo, options?.silent, '💾 STAGE 5: Commit Changes');
    for (const repo of repos) {
      await this.commitForRepo(repo, ticketKey, planArtifact, options, trackerName, isMultiRepo);
    }
  }

  private printRepoHeader(isMultiRepo: boolean, repo: string | undefined, options: IssueOptions): void {
    if (isMultiRepo && !options?.silent) {
      console.log(chalk.bold.cyan(`\n  ── ${repo ?? 'current directory'} ──`));
    }
  }

  private parseStage(stage: string): WorkflowStage {
    const normalized = stage.toLowerCase();
    if (!Object.values(WorkflowStage).includes(normalized as WorkflowStage)) {
      throw new ValidationError(`Invalid stage: ${stage}. Must be one of: ${Object.values(WorkflowStage).join(', ')}`);
    }
    return normalized as WorkflowStage;
  }

  private getStagesToRun(from: WorkflowStage, to: WorkflowStage): WorkflowStage[] {
    const fromIndex = stageOrder.indexOf(from);
    const toIndex = stageOrder.indexOf(to);

    if (fromIndex > toIndex) {
      throw new ValidationError(`Invalid stage range: --from ${from} --to ${to}. 'from' must come before 'to'.`);
    }

    return stageOrder.slice(fromIndex, toIndex + 1);
  }

  /**
   * Start interactive chat session
   *
   * @param ticketKey - Ticket identifier
   * @param stage - Current workflow stage
   * @param workflowState - State data including ticket content, plan, review
   * @param repoDir
   * @param trackerName
   */
  // workflowState is intentionally typed `any` — it carries heterogeneous stage outputs

  private async startInteractiveChat(
    ticketKey: string, stage: ConvWorkflowStage,
    workflowState: any, repoDir: string, trackerName: string
  ): Promise<void> {
    const context = this.buildConversationContext(ticketKey, stage, workflowState, repoDir, trackerName);

    let conversation = await this.conversationService.loadConversation(ticketKey, repoDir, trackerName);
    conversation ??= await this.conversationService.createConversation(ticketKey, context);

    const systemPrompt = this.buildChatSystemPrompt(stage, workflowState);
    await this.conversationService.startChatSession(conversation.conversationId, {
      systemPrompt, maxTurns: 20, exitCommands: ['exit', 'quit', 'continue'], stage, repoDir,
    });
  }

  private buildConversationContext(
    ticketKey: string, stage: ConvWorkflowStage,
    workflowState: any, repoDir: string, trackerName: string
  ): ConversationContext {
    return {
      ticketKey, stage, repoDir, trackerName,
      stageOutput: stage === 'plan' ? workflowState.plan : workflowState.review,
      workflowState: {
        ticketContent: workflowState.ticketContent,
        plan: workflowState.plan,
        review: workflowState.review,
      },
    };
  }

  /**
   * Build system prompt with workflow stage context
   *
   * @param stage - Current workflow stage
   * @param workflowState - State data
   * @returns System prompt with contextual information
   */

  private buildChatSystemPrompt(stage: ConvWorkflowStage, workflowState: any): string {
    const base = `You are an AI assistant helping a developer with a ticket workflow.\n`
      + `The developer is currently at the ${stage.toUpperCase()} stage.\n\n`
      + `Ticket Content:\n${workflowState.ticketContent}\n`;

    if (stage === 'plan' && workflowState.plan) return base + this.buildPlanPromptSuffix(workflowState.plan);
    if (stage === 'review' && workflowState.review) return base + this.buildReviewPromptSuffix(workflowState.review);
    return base;
  }

  private buildPlanPromptSuffix(plan: any): string {
    const formatStep = (s: string, i: number): string => '  ' + (i + 1) + '. ' + s;
    const resolveFilePath = (f: any): string => typeof f === 'string' ? f : f.filePath;
    const formatFile = (f: any): string => '  - ' + resolveFilePath(f);
    const formatRisk = (r: PlanRisk): string => '  - ' + formatPlanRisk(r);

    const steps = plan.steps.map(formatStep).join('\n');
    const files = plan.affectedFiles
      ? '\nFiles Affected:\n' + plan.affectedFiles.map(formatFile).join('\n')
      : '';
    const risks = plan.risks
      ? '\nRisks:\n' + plan.risks.map(formatRisk).join('\n')
      : '';
    return '\nGenerated Plan:\n- Summary: ' + plan.summary + '\n- Action: ' + plan.action + '\n'
      + '- Complexity: ' + plan.estimatedComplexity + '\n- Steps:\n' + steps + files + risks + '\n\n'
      + 'Help the developer refine the implementation plan, discuss the approach, or address concerns.';
  }

  private buildReviewPromptSuffix(review: any): string {
    const issues = review.issues.length > 0
      ? review.issues.map((i: any) => this.formatIssuePromptLine(i)).join('\n')
      : '  No issues found';
    const suggestions = review.suggestions.length > 0
      ? review.suggestions.map((s: string) => '  - ' + s).join('\n')
      : '  No suggestions';
    const verdict = review.approved ? REVIEW_VERDICT_APPROVED : REVIEW_VERDICT_CHANGES_REQUESTED;
    return '\nCode Review Results:\n- Summary: ' + review.summary + '\n- Status: ' + verdict + '\n\n'
      + 'Issues Found:\n' + issues + '\n\nSuggestions:\n' + suggestions + '\n\n'
      + 'Help the developer understand the review feedback, discuss issues, or suggest fixes.';
  }

  private formatIssuePromptLine(issue: any): string {
    let location = '';
    if (issue.file) {
      const lineRef = issue.line ? ':' + issue.line : '';
      location = ' (' + issue.file + lineRef + ')';
    }
    return '  [' + issue.severity + '] ' + issue.message + location;
  }

  /**
   * Resolve a repository name to a filesystem base path.
   *
   * Resolution order:
   *   1. Absolute path that exists on disk — used as-is
   *   2. Path relative to cwd that exists — resolved to absolute
   *   3. Sibling directory of cwd (../repo) that exists
   *   4. Falls back to cwd with a warning
   *
   * @returns Absolute base path to use for artifact storage
   * @param stage
   */

  /**
   * Resolve a plan artifact reference without throwing.
   * @returns The resolved reference, or null when no matching artifact exists
   */
  private safePlanResolve(
    ticketKey: string,
    artifactDir: string,
    action?: ResolutionAction
  ): ReturnType<typeof resolvePlanArtifactReferenceInDir> | null {
    try {
      return resolvePlanArtifactReferenceInDir(ticketKey, { artifactDir, action });
    } catch {
      return null;
    }
  }

  private resolveStageFingerprint(stage: string): StageConfigFingerprint {
    const provider = (this.configService.get<string>(`stages.${stage}.provider`)
      ?? this.configService.get<string>('ai.provider', 'anthropic')) as StageConfigFingerprint['provider'];
    const backend = (this.configService.get<string>(`stages.${stage}.backend`)
      ?? resolveDefaultStageBackend(stage as StageBackendDefaultStageName)) as StageConfigFingerprint['backend'];
    return { provider, backend };
  }

  private resolveStageModel(stage: string): string {
    const stageModel = this.configService.get<string>(`stages.${stage}.model`);
    if (stageModel) return stageModel;
    if (stage === 'implement') {
      const implementModels = this.configService.get<{ default?: string }>('stages.implement.models');
      if (implementModels?.default) return implementModels.default;
    }
    const provider = this.configService.get<string>(`stages.${stage}.provider`)
      ?? this.configService.get<string>('ai.provider', 'anthropic');
    return resolveProviderModel(this.configService, provider, '');
  }

  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }
}
