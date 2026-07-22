import { Command, CommandRunner, Option } from 'nest-commander';
import { ensureWfHome } from '../shared/utils/ensure-wf-home';
import { ConversationService } from '../integrations/ai/conversation/conversation.service';
import { ConversationContext, WorkflowStage as ConvWorkflowStage } from '../integrations/ai/conversation/interfaces';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ValidationError } from '../shared/utils/errors';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import { resolveArtifactDir, resolveCustomArtifactDir, resolveRepoBasePath } from '../agents/utils';
import {
  buildPlanArtifactFilename,
  buildSyntheticTicketArtifact,
  hashPlanArtifactSources,
  isPlanToken,
  parsePlanArtifact,
  resolvePlanArtifactReference as resolvePlanArtifactReferenceInDir,
  resolvePlanToken,
} from '../shared/utils/plan-artifact';
import { resolveCustomSourcePath } from '../shared/utils/custom-source';
import { parseReposOption } from './utils/repos-option';
import { ConfigService } from '@nestjs/config';
import { AiService, REVIEW_VERDICT_APPROVED, REVIEW_VERDICT_CHANGES_REQUESTED } from '../integrations/ai/ai.service';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
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
  ImplementerResult,
} from '../agents/interfaces';
import type { ModelRouting } from '../agents/interfaces';
import { SessionService } from '../shared/session/session.service';
import type { PlanTokenResolution } from '../shared/types/plan-artifact.types';
import type { SessionState, StageConfigFingerprint } from '../shared/types/session.types';
import { resolveDefaultStageBackend, type StageBackendDefaultStageName } from '../config/stage-backend-defaults';
import * as crypto from 'node:crypto';

const VALID_MODEL_ROUTING: ModelRouting[] = ['auto', 'default', 'mechanical'];

const ISSUE_EXAMPLES: CliExample[] = [
  {
    comment: 'Run full workflow from fetch',
    command: 'wf issue -k WBP-2971 --from fetch --action fix',
  },
  {
    comment: 'Resume from implement stage',
    command: 'wf issue -k WBP-2971 --from implement --action fix --tracker jira',
  },
  {
    comment: 'Run the workflow from a custom markdown plan source (--from defaults to plan)',
    command: 'wf issue -c bar.md --action fix',
  },
  {
    comment: 'Resume from a hashed plan artifact without --action (--from defaults to implement)',
    command: 'wf issue 2026-05-04-1a2b3c4d-fix-plan.json --to review',
  },
];

enum WorkflowStage {
  FETCH = 'fetch',
  PLAN = 'plan',
  IMPLEMENT = 'implement',
  REVIEW = 'review',
  COMMIT = 'commit',
}

const STAGE_ORDER = [
  WorkflowStage.FETCH,
  WorkflowStage.PLAN,
  WorkflowStage.IMPLEMENT,
  WorkflowStage.REVIEW,
  WorkflowStage.COMMIT,
];

interface IssueOptions {
  action?: string;
  branch?: boolean;
  branchNamePattern?: string;
  customPlan?: string;
  dryRun?: boolean;
  force?: boolean;
  from: string;
  modelRouting?: string;
  noBranch?: boolean;
  pr?: boolean;
  repos?: string[];
  sessionId?: string;
  silent?: boolean;
  ticketKey?: string;
  to?: string;
  tracker?: string;
}

interface ResolvedWorkflowContext {
  action: ResolutionAction | undefined;
  customSourcePath?: string;
  fromStage: WorkflowStage;
  options: IssueOptions;
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
  sessionContext: { resumeProviderSessionId?: string; priorStageSummary?: string };
  sessionState: SessionState | undefined;
}

interface DryRunStageCounters {
  terminalLines: string[];
  totalApiCalls: number;
  totalFilesCreated: number;
}

@Command({
  name: 'issue',
  description:
    'Complete workflow: fetch, plan, implement, review, and commit. Use --from and --to to control stage range. '
    + 'Pass --repos to specify repositories: the first repo anchors artifact storage; remaining repos expand execution context. '
    + 'Resuming from `--from implement` can accept a hashed plan token or a hashed plan filename; if `--action` is provided, it is validated against the resolved artifact.',
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
    description: 'Override branch name validation pattern from git.branchNamePattern config',
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
    description: 'Force refetch and recreate all local artifacts, ignoring any cached files',
  })
  parseForce(): boolean {
    return true;
  }

  @Option({
    flags: '--from <stage>',
    description:
      'Start from stage (fetch|plan|implement|review|commit) — defaults to `plan` when `--custom-plan` is provided, `implement` when a plan token is provided',
  })
  parseFrom(val: string): string {
    return val;
  }

  @Option({
    flags: '--model-routing <mode>',
    description:
      'Model selection strategy for implement stage: auto (detect mechanical vs creative), default (force default model), mechanical (force cheaper model). Defaults to auto.',
  })
  parseModelRouting(val: string): string {
    if (!VALID_MODEL_ROUTING.includes(val as ModelRouting)) {
      throw new ValidationError(
        `Invalid --model-routing value: ${val}. Must be one of: ${VALID_MODEL_ROUTING.join(', ')}`
      );
    }
    return val;
  }

  @Option({
    flags: '--no-branch',
    description: 'Suppress branch creation; work directly on the current branch',
  })
  parseNoBranch(): boolean {
    // Commander maps --no-X flags as boolean negation of X.
    // Return false so that options.branch becomes false when --no-branch is passed.
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
    description: 'Resume a wf session by UUID (persisted to ~/.wf/state/sessions/); omit to auto-generate a new one',
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
      const ctx = this.validateAndResolveInputs(passedParams, options);

      if (ctx.options?.dryRun) {
        return this.previewDryRun(ctx);
      }

      this.printWorkflowHeader(ctx);
      await this.executeWorkflow(ctx);
    } });
  }

  private validateAndResolveInputs(passedParams: string[], options?: IssueOptions): ResolvedWorkflowContext {
    if (!options?.silent) printExamples(ISSUE_EXAMPLES);

    const planToken = passedParams[0];
    const validatedOptions = this.validateInputExclusions(planToken, options);
    const { fromStage, toStage, stagesToRun } = this.resolveStageRange(validatedOptions);
    const trackerName = validatedOptions?.tracker || this.configService.get<string>('tracker') || 'jira';
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
      options: validatedOptions,
    };
  }

  private validateInputExclusions(planToken: string | undefined, options?: IssueOptions): IssueOptions {
    this.assertMutualExclusions(planToken, options);
    return this.resolveFromStage(planToken, options);
  }

  // eslint-disable-next-line max-lines-per-function
  private assertMutualExclusions(planToken: string | undefined, options?: IssueOptions): void {
    if (options?.noBranch && options?.branchNamePattern) {
      throw new ValidationError(
        '--no-branch and --branch-name-pattern are mutually exclusive.\n'
        + '  Use --no-branch to stay on the current branch, or\n  Use --branch-name-pattern <pattern> to validate a generated branch name.'
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
    let fromStage = this.parseStage(options.from);
    const toStage = options.to ? this.parseStage(options.to) : WorkflowStage.COMMIT;

    if (options?.customPlan && fromStage === WorkflowStage.FETCH) {
      console.log(chalk.yellow('⚠️  Custom plans skip the fetch stage; starting from plan.'));
      fromStage = WorkflowStage.PLAN;
    }

    if (STAGE_ORDER.indexOf(fromStage) > STAGE_ORDER.indexOf(toStage)) {
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

    if (['fetch', 'plan'].includes(options.from.toLowerCase())) {
      throw new ValidationError(
        'A plan token is only valid when resuming from --from implement or later.\n'
        + 'A plan token references a plan artifact that already exists.\n'
        + 'Use --ticket-key instead when running from the fetch or plan stage.'
      );
    }

    return resolvePlanToken(planToken, trackerDir, repoBaseDir);
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
    let sessionState = await this.initializeSession(ctx.ticketKey, ctx.options);
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
    }

    if (!planArtifact) ticketArtifact = await this.resolveTicketArtifact(ctx);

    if (!planArtifact && ctx.stagesToRun.includes(WorkflowStage.PLAN)) {
      const result = await this.executePlanStage(ticketArtifact, action!, ctx, sessionState);
      planArtifact = result.planArtifact;
      sessionState = result.sessionState;
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

    const loaded = await this.agents.planner.loadFromDisk(ticketArtifact.path, action, ctx.options?.silent);
    sessionState = await this.promptAndRecordSkippedPlanSession(loaded, sessionState);
    return { planArtifact: loaded, sessionState };
  }

  private async finalizePlanSession(
    planArtifact: PlanArtifact | undefined, sessionState: SessionState | undefined
  ): Promise<SessionState | undefined> {
    if (planArtifact?.sessionId && sessionState) {
      sessionState = await this.sessionService.recordProviderSessionId(sessionState, 'plan', planArtifact.sessionId);
    }
    if (sessionState?.stages['plan'] && !sessionState.stages['plan'].completedAt) {
      sessionState = await this.sessionService.recordStageComplete(
        sessionState, 'plan', planArtifact?.plan?.summary ?? null
      );
    }
    return sessionState;
  }

  private async promptAndRecordSkippedPlanSession(
    planArtifact: PlanArtifact, sessionState: SessionState | undefined
  ): Promise<SessionState | undefined> {
    const id = await this.promptProviderSessionId();
    if (!id) return sessionState;
    planArtifact.sessionId = id;
    sessionState &&= await this.sessionService.recordProviderSessionId(sessionState, 'plan', id);
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

    let implementerResult: ImplementerResult | undefined;
    if (stagesToRun.includes(WorkflowStage.IMPLEMENT) && planArtifact) {
      const result = await this.executeImplementStage(ticketArtifact, planArtifact, ctx.repos, options, sessionState);
      implementerResult = result.implementerResult;
      sessionState = result.sessionState;
      if (result.earlyReturn) return { sessionState, earlyReturn: true };
    }

    const skipReview = implementerResult?.type === 'implementation'
      && !implementerResult.hasChanges;

    if (stagesToRun.includes(WorkflowStage.REVIEW) && planArtifact?.action !== 'investigate' && !skipReview) {
      const result = await this.executeReviewStage(
        ticketArtifact, planArtifact, ctx.repos, options, sessionState,
        implementerResult, ctx.ticketKey
      );
      sessionState = result.sessionState;
    } else if (skipReview && !options?.silent) {
      console.log(chalk.gray('\n  Skipping review -- no file changes from implementation'));
    }

    if (stagesToRun.includes(WorkflowStage.COMMIT) && planArtifact?.action !== 'investigate') {
      await this.executeCommitStage(ctx.ticketKey, planArtifact, ctx.repos, options);
    }

    return { sessionState, earlyReturn: false };
  }

  private printWorkflowComplete(ctx: ResolvedWorkflowContext): void {
    if (ctx.options?.silent) return;
    console.log(chalk.bold.green('\n✅ Workflow Complete!'));
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
    const ai = this.resolveAiPreviewContext();
    const trackerDir = resolveArtifactDir(ctx.repoBaseDir, ctx.trackerName);

    for (const stage of ctx.stagesToRun) {
      this.previewDryRunStage(stage, ctx, ai, trackerDir, counters);
    }

    this.showDryRunSummary(counters);
  }

  private resolveAiPreviewContext(): { endpoint: string; platform: string } {
    const platform = this.aiService.getProviderDisplayName();
    const provider = this.configService.get<string>('ai.provider', 'anthropic');
    let endpoint: string;
    switch (provider) {
      case 'google':
        endpoint = '/v1beta/models';
        break;
      case 'openai':
      case 'deepseek':
        endpoint = '/chat/completions';
        break;
      default:
        endpoint = '/v1/messages';
    }
    return { endpoint, platform };
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
    counters.terminalLines.push(`✓ Ticket fetched and saved to: ${ticketPath}`);
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
    counters.terminalLines.push('✓ Plan saved to: ' + planPath);
  }

  private buildDefaultPlanPath(ticketKey: string, trackerDir: string, action: ResolutionAction): string {
    const planHash = hashPlanArtifactSources([ticketKey]);
    return path.join(trackerDir, buildPlanArtifactFilename({ hash: planHash, action, format: 'json' }));
  }

  private previewPlanApiCall(endpoint: string, platform: string, action: ResolutionAction): void {
    this.dryRunPreview.previewApiCall({
      method: 'POST', endpoint, platform,
      description: `Generate ${action} plan`,
      estimatedResponse: `{\n  "action": "${action}",\n  "estimatedComplexity": "medium",\n  "steps": ["<step 1>", "..."],\n  "affectedFiles": ["<file>", "..."]\n}`,
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
      counters.terminalLines.push(`✓ Implementation guide displayed for: ${repo ?? 'current directory'}`);
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
    counters.terminalLines.push('✓ Investigation findings saved to: ' + findingsPath);
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
      contentPreview: 'Code Review Report\nContext: <source>\n\n## Summary\n<AI review summary>\n\n## Issues Found\n(none)\n\nStatus: ✓ Approved',
    });
    counters.totalApiCalls++;
    counters.totalFilesCreated++;
    counters.terminalLines.push('✓ Review complete', '  Summary: <AI review summary>', '  Status: ✓ Approved');
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
      counters.terminalLines.push('✓ Commit message generated', '  Message: ' + ticketKey + ': <AI-generated>');
    }
  }

  private async initializeSession(ticketKey: string, options: IssueOptions): Promise<SessionState | undefined> {
    let sessionState: SessionState | undefined;
    let wfSessionId: string | undefined = options.sessionId;

    if (wfSessionId) {
      sessionState = (await this.sessionService.load(wfSessionId)) ?? undefined;
    }

    if (wfSessionId && !sessionState) {
      await this.handleMissingSession(wfSessionId);
      wfSessionId = undefined;
    }

    this.validateSessionOwnership(sessionState, wfSessionId, ticketKey);

    if (sessionState && this.sessionService.isExpired(sessionState)) {
      console.log(chalk.yellow(`  Session ${wfSessionId} expired — starting fresh`));
      sessionState = undefined;
      wfSessionId = undefined;
    }

    if (!sessionState) {
      sessionState = await this.createNewSession(ticketKey);
      wfSessionId = sessionState.sessionId;
    }

    this.printSessionId(wfSessionId, options?.silent);
    return sessionState;
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

  private async createNewSession(ticketKey: string): Promise<SessionState> {
    const sessionState: SessionState = {
      sessionId: crypto.randomUUID(),
      ticketKey,
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

  /**
   * Resolve a custom plan token into its ticket artifact, plan artifact,
   * and action — recording the plan stage as complete in the session.
   */
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

    const plan = parsePlanArtifact(
      fs.readFileSync(planTokenResolution.artifactPath, 'utf-8'),
      planTokenResolution.artifactPath
    );

    const filename = path.basename(planTokenResolution.artifactPath);
    let resolvedAction = planTokenResolution.action;

    if (plan.action !== planTokenResolution.action) {
      resolvedAction = await this.resolveCustomTokenActionMismatch(
        plan.action, planTokenResolution.action, filename
      );
    }

    const ticketArtifact = buildSyntheticTicketArtifact(planTokenResolution.artifactPath, plan);
    const planArtifact: PlanArtifact = {
      plan, action: resolvedAction, path: planTokenResolution.artifactPath,
    };

    const providerSessionId = await this.promptProviderSessionId();
    if (providerSessionId) planArtifact.sessionId = providerSessionId;

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
    console.log(
      chalk.yellow(
        `  ⚠️  Plan token action mismatch for ${filename}: plan contains '${planAction}', requested '${requestedAction}'.`
      )
    );

    if (!this.isInteractiveSession()) {
      throw new ValidationError(
        `Plan token action mismatch: '${filename}' contains '${planAction}' but '${requestedAction}' was requested. `
        + `Pass the correct --action or re-run interactively to choose.`
      );
    }

    const { selectedAction } = await inquirer.prompt<{ selectedAction: ResolutionAction }>([{
      type: 'list',
      name: 'selectedAction',
      message: 'Which action should be used?',
      prefix: ' ',
      choices: [
        { name: `Use '${planAction}' (from plan file)`, value: planAction },
        { name: `Use '${requestedAction}' (from plan token)`, value: requestedAction },
      ],
      default: planAction,
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
   * Execute the plan stage: generate a plan, prompt for provider session ID
   * on cache hit, and offer interactive chat when the plan is fresh.
   */
  private async executePlanStage(
    ticketArtifact: TicketArtifact, action: ResolutionAction,
    ctx: ResolvedWorkflowContext, sessionState: SessionState | undefined
  ): Promise<{ planArtifact: PlanArtifact; sessionState: SessionState | undefined }> {
    sessionState &&= await this.recordStageStart(sessionState, 'plan');

    const planArtifact = await this.generatePlanArtifact(ticketArtifact, action, ctx);
    await this.promptCachedPlanSession(planArtifact);
    await this.offerPlanChat(ticketArtifact, planArtifact, ctx);

    return { planArtifact, sessionState };
  }

  private async generatePlanArtifact(
    ticketArtifact: TicketArtifact, action: ResolutionAction, ctx: ResolvedWorkflowContext
  ): Promise<PlanArtifact> {
    const planArtifact = await this.agents.planner.execute(ticketArtifact, {
      action, skipExisting: ctx.skipExisting,
      affectedRepositories: ctx.options?.repos ?? [path.basename(ctx.repoBaseDir)],
      silent: ctx.options?.silent,
    });
    if (ctx.options?.silent) console.log(planArtifact.path);
    return planArtifact;
  }

  private async promptCachedPlanSession(planArtifact: PlanArtifact): Promise<void> {
    if (!planArtifact.fromCache) return;
    const id = await this.promptProviderSessionId();
    if (id) planArtifact.sessionId = id;
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

  private async executeImplementStage(
    ticketArtifact: TicketArtifact,
    planArtifact: PlanArtifact,
    repos: (string | undefined)[],
    options: IssueOptions,
    sessionState: SessionState | undefined
  ): Promise<{
    implementerResult: ImplementerResult | undefined;
    sessionState: SessionState | undefined;
    earlyReturn: boolean;
  }> {
    const { sessionContext, sessionState: started } = await this.prepareStageSession(sessionState, 'implement');
    sessionState = started;

    const isMultiRepo = repos.length > 1;
    this.printStageHeader(isMultiRepo, options?.silent, '🔧 STAGE 3: Implementation Guide');

    const result = await this.runImplementLoop(ticketArtifact, planArtifact, repos, options, sessionContext);
    if (result.earlyReturn) return { ...result, sessionState };

    sessionState = await this.finalizeImplementSession(sessionState, result.implementerResult);
    return { implementerResult: result.implementerResult, sessionState, earlyReturn: false };
  }

  private async prepareStageSession(
    sessionState: SessionState | undefined, stage: string
  ): Promise<StageSessionResult> {
    if (!sessionState) return { sessionContext: {}, sessionState };

    const validation = this.sessionService.validateForStage(
      sessionState, stage, this.resolveStageFingerprint(stage), s => this.resolveStageFingerprint(s)
    );
    for (const w of validation.warnings) console.log(chalk.yellow(`  ⚠️ ${w}`));

    const started = await this.recordStageStart(sessionState, stage);
    return {
      sessionContext: {
        resumeProviderSessionId: validation.resumableProviderSessionId ?? undefined,
        priorStageSummary: validation.priorSummary ?? undefined,
      },
      sessionState: started,
    };
  }

  private printStageHeader(isMultiRepo: boolean, silent: boolean | undefined, title: string): void {
    if (!isMultiRepo || silent) return;
    console.log(chalk.bold.yellow('\n' + title));
    console.log(chalk.gray('─'.repeat(70)));
  }

  private async runImplementLoop(
    ticketArtifact: TicketArtifact, planArtifact: PlanArtifact,
    repos: (string | undefined)[], options: IssueOptions,
    sessionContext: { resumeProviderSessionId?: string; priorStageSummary?: string }
  ): Promise<{ implementerResult: ImplementerResult | undefined; earlyReturn: boolean }> {
    const isMultiRepo = repos.length > 1;
    let implementerResult: ImplementerResult | undefined;

    for (const repo of repos) {
      if (isMultiRepo && !options?.silent) this.printRepoSubheader(repos, repo);
      implementerResult = await this.agents.implementer.execute(ticketArtifact, planArtifact, {
        trackerName: options?.tracker || this.configService.get<string>('tracker') || 'jira',
        repoDir: resolveRepoBasePath(repo),
        additionalRepoDirs: (options.repos ?? []).filter(r => r !== repo).map(r => resolveRepoBasePath(r)),
        suppressHeader: isMultiRepo, allowMultiRepoScope: isMultiRepo,
        modelRouting: options.modelRouting as ModelRouting,
        silent: options.silent, noBranch: options.noBranch, branchNamePattern: options.branchNamePattern,
        ...sessionContext,
      });

      if (implementerResult?.type === 'investigation') {
        console.log(chalk.bold.green('\n✓ Investigation workflow complete — no further stages will run'));
        return { implementerResult, earlyReturn: true };
      }
    }

    return { implementerResult, earlyReturn: false };
  }

  private async finalizeImplementSession(
    sessionState: SessionState | undefined, result: ImplementerResult | undefined
  ): Promise<SessionState | undefined> {
    if (sessionState && result?.type === 'implementation' && result.sessionId) {
      sessionState = await this.sessionService.recordProviderSessionId(sessionState, 'implement', result.sessionId);
    }
    sessionState &&= await this.sessionService.recordStageComplete(sessionState, 'implement', null);
    return sessionState;
  }

  private async executeReviewStage(
    ticketArtifact: TicketArtifact,
    planArtifact: PlanArtifact | undefined,
    repos: (string | undefined)[],
    options: IssueOptions,
    sessionState: SessionState | undefined,
    implementerResult: ImplementerResult | undefined,
    ticketKey: string
  ): Promise<{ reviewArtifact: ReviewArtifact | null; sessionState: SessionState | undefined }> {
    const implSessionId = implementerResult?.type === 'implementation' ? implementerResult.sessionId : undefined;
    const prepared = await this.prepareReviewSession(sessionState, implSessionId);
    sessionState = prepared.sessionState;
    this.printStageHeader(repos.length > 1, options?.silent, '🔍 STAGE 4: Code Review');

    const reviewArtifact = await this.runReviewLoop(
      ticketArtifact, planArtifact, repos, options, prepared.sessionContext, ticketKey
    );

    sessionState &&= await this.sessionService.recordStageComplete(sessionState, 'review', null);
    return { reviewArtifact, sessionState };
  }

  private async prepareReviewSession(
    sessionState: SessionState | undefined, implementSessionId: string | undefined
  ): Promise<StageSessionResult> {
    const prepared = await this.prepareStageSession(sessionState, 'review');
    const resumeId = prepared.sessionContext.resumeProviderSessionId ?? implementSessionId ?? undefined;
    return {
      sessionContext: { ...prepared.sessionContext, resumeProviderSessionId: resumeId },
      sessionState: prepared.sessionState,
    };
  }

  private async runReviewLoop(
    ticketArtifact: TicketArtifact, planArtifact: PlanArtifact | undefined,
    repos: (string | undefined)[], options: IssueOptions,
    sessionContext: { resumeProviderSessionId?: string; priorStageSummary?: string },
    ticketKey: string
  ): Promise<ReviewArtifact | null> {
    const isMultiRepo = repos.length > 1;
    let reviewArtifact: ReviewArtifact | null = null;

    for (const repo of repos) {
      if (isMultiRepo && !options?.silent) this.printRepoSubheader(repos, repo);
      reviewArtifact = await this.agents.reviewer.execute(ticketArtifact, {
        skipExisting: !options?.force, repoDir: resolveRepoBasePath(repo),
        suppressHeader: isMultiRepo, silent: options?.silent, ...sessionContext,
      });

      if (!reviewArtifact) continue;
      this.printReviewStatus(reviewArtifact, options?.silent);
      await this.offerReviewChat(ticketArtifact, planArtifact, reviewArtifact, ticketKey, repos, options);
    }

    return reviewArtifact;
  }

  private printReviewStatus(artifact: ReviewArtifact, silent?: boolean): void {
    if (silent) {
      console.log(artifact.path);
      return;
    }
    console.log(chalk.bold('\n  Status:'));
    if (artifact.approved) {
      console.log(chalk.cyan('    Changes approved - proceeding to commit stage'));
      return;
    }
    console.log(chalk.yellow('    ⚠️  Review found issues - address before committing'));
    console.log(chalk.cyan('    Commit stage will still execute (you can skip it if needed)'));
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
    const trackerName = options?.tracker || this.configService.get<string>('tracker') || 'jira';
    await this.startInteractiveChat(
      ticketKey, 'review' as ConvWorkflowStage,
      { ticketContent: ticketArtifact.content, plan: planArtifact?.plan, review: reviewArtifact.review },
      resolveRepoBasePath(repos[0]), trackerName
    );
  }

  private async executeCommitStage(
    ticketKey: string, planArtifact: PlanArtifact | undefined,
    repos: (string | undefined)[], options: IssueOptions
  ): Promise<void> {
    const isMultiRepo = repos.length > 1;
    this.printStageHeader(isMultiRepo, options?.silent, '💾 STAGE 5: Commit Changes');
    for (const repo of repos) {
      this.printRepoHeader(isMultiRepo, repo, options);
      await this.agents.committer.execute(
        ticketKey, resolveRepoBasePath(repo), planArtifact?.plan?.summary, isMultiRepo, options?.silent
      );
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
    const fromIndex = STAGE_ORDER.indexOf(from);
    const toIndex = STAGE_ORDER.indexOf(to);

    if (fromIndex > toIndex) {
      throw new ValidationError(`Invalid stage range: --from ${from} --to ${to}. 'from' must come before 'to'.`);
    }

    return STAGE_ORDER.slice(fromIndex, toIndex + 1);
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
    const formatRisk = (r: string): string => '  - ' + r;

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
    return this.configService.get<string>(`stages.${stage}.model`) ?? this.configService.get<string>('ai.model', '');
  }

  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  /**
   * Prompt the user for a provider session ID from a prior conversation.
   * Gated on TTY only — no silent guard — because this is the only path to
   * capture the provider session ID when the plan was not freshly generated.
   * Safe to call in any context; returns `undefined` without prompting when
   * no TTY is available.
   *
   * @returns The entered session ID, or `undefined` if blank or non-interactive.
   */
  private async promptProviderSessionId(): Promise<string | undefined> {
    if (!this.isInteractiveSession()) {
      return undefined;
    }
    const { providerSessionId } = await inquirer.prompt([
      {
        type: 'input',
        name: 'providerSessionId',
        message: 'Provider session ID from issue:plan (leave blank to skip):',
        prefix: ' ',
        default: '',
      },
    ]);
    return providerSessionId || undefined;
  }
}
