import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import * as path from 'node:path';
import type { PlanProblem } from '../../../shared/types/agent.types';
import type { UiDesignScreenshot } from '../../../shared/types/ui-design-screenshot';
import { AiProviderError, ExecutionError } from '../../../shared/utils/errors';
import { formatPlanRisks } from '../../../shared/utils/plan-risk';
import type {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  ImplementerBackend,
  VerificationScript,
  VerificationOutcome,
} from '../../../agents/interfaces';
import {
  printVerificationReport, getEnforcedFailures,
  buildVerificationFixPrompt, runProgrammaticVerification,
  checkVerificationStall, detectVerificationStatus, partitionFailures, STALL_THRESHOLD,
} from './verification-report';
import { logFileSummary } from './file-summary';
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_ANTHROPIC_MECHANICAL_MODEL,
  resolveModelRouting,
  resolveProviderModel,
  stripRepoPrefix,
  isGlobPattern,
  loadClaudeContext,
  discoverChangedFiles,
  buildTaskBrief,
  resolveInitialUserPrompt,
  continuationTail,
  parseNoChangeDeclarations,
  acceptNoChangeDeclarations,
  collectPlanProblems,
  type BuildPlanContextParams,
} from './shared-routing';
import {
  ANTHROPIC_AGENT_LABEL,
  buildSystemPrompt, computeStallThreshold, formatProgressMessage, formatActivityMessages, resolveProgressColor,
} from './anthropic-agent.adapter';
import {
  assertClaudeCliAvailable,
  buildClaudeStdinPrompt,
  buildCliArgs,
  CLI_INACTIVITY_TIMEOUT_MS,
  CLI_TIMEOUT_MS,
  spawnCli,
  type ClaudeCliMessage,
} from './claude-cli-runner';
import { buildSkillPromptFragment } from '../../../skills';

const CLI_ADAPTER_LABEL = 'claude-cli';
const implementTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill'];
type ActivityState = {
  lastVerificationCommand?: string;
  verificationOutcomes: VerificationOutcome[];
  planProblems: PlanProblem[];
};

type ToolBlock = {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
};

type ResultBlock = {
  type: string;
  content?: string;
  is_error?: boolean;
  tool_use_id?: string;
};

type GenerateAndVerifyParams = {
  ticket: TicketArtifact;
  planArtifact: PlanArtifact;
  options: ImplementerOptions;
  verificationScripts: VerificationScript[];
  repoFiles: string[];
  contextFiles?: string[];
  repoName: string;
  trackedFilePaths: string[];
  conventionsSection?: string;
  skillNames?: string[];
  figmaContextSection?: string;
  uiDesignScreenshotPaths?: string[];
  verificationPassOffset?: number;
};

type CliSessionParams = {
  options: ImplementerOptions;
  repoFiles: string[];
  repoName: string;
  repoDir: string;
  additionalRepoDirs: string[];
  appendSystemPrompt: string;
  model: string;
  verificationScripts: VerificationScript[];
  taskBriefParams: BuildPlanContextParams;
  planStepCount: number;
  uiDesignScreenshotPaths?: string[];
  verificationPassOffset?: number;
};

type ContinuationLoopParams = {
  sessionId: string | undefined;
  repoFiles: string[];
  repoName: string;
  touchedFiles: Set<string>;
  notApplicableFiles: Set<string>;
  appendSystemPrompt: string;
  model: string;
  repoDir: string;
  additionalRepoDirs: string[];
  activityState: ActivityState;
  verificationScripts: VerificationScript[];
  taskBriefParams: BuildPlanContextParams;
  planStepCount: number;
  verificationPassOffset?: number;
};

type SinglePassParams = {
  passNumber: number;
  sessionId: string;
  currentUnvisited: string[];
  promptOverride?: string;
  appendSystemPrompt?: string;
  model: string;
  repoDir: string;
  additionalRepoDirs: string[];
  touchedFiles: Set<string>;
  activityState: ActivityState;
  totalPlanned?: number;
  taskBriefParams?: BuildPlanContextParams;
};

type ToolBlockLogParams = {
  block: ToolBlock;
  repoDir: string;
  activityState: ActivityState;
  touchedFiles?: Set<string>;
};

const buildCliSystemPrompt = (
  priorStageSummary: string | undefined,
  claudeContext: string | null,
  systemPrompt: string
): string => {
  const preamble = priorStageSummary
    ? `<prior-stage-context>\n${priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.`
    : '';
  return [preamble, claudeContext ? `Repo AI context:\n${claudeContext}` : '', systemPrompt]
    .filter(Boolean)
    .join('\n\n');
};

const collectTouchedFiles = (message: ClaudeCliMessage, repoDir: string, touchedFiles: Set<string>): void => {
  if (!message.files) return;
  for (const { filename } of message.files) {
    const absolutePath = path.isAbsolute(filename) ? filename : path.resolve(repoDir, filename);
    touchedFiles.add(path.relative(repoDir, absolutePath));
  }
};

const logCliResultSummary = (message: ClaudeCliMessage): void => {
  const summary = message.result?.trim();
  if (!summary) return;
  console.log(chalk.bold('\n  Summary:'));
  for (const line of summary.split('\n')) {
    if (line.trim()) console.log(chalk.cyan(`    ${line}`));
  }
};

/**
 * Describes why the CLI failed. An errored result has no `result` string — the detail
 * lives in `errors` and the cause in `terminal_reason` — so reading `result` alone
 * renders every failure as "unknown error". Falls back through progressively weaker
 * sources rather than discarding what the CLI did report.
 *
 * @param message - A result-type CLI message with is_error set
 * @returns Human-readable failure description
 */
const describeCliFailure = (message: ClaudeCliMessage): string => {
  const parts = [
    message.result,
    message.errors?.length ? message.errors.join('; ') : undefined,
    message.terminal_reason ? `terminal_reason=${message.terminal_reason}` : undefined,
    message.subtype ? `subtype=${message.subtype}` : undefined,
    message.num_turns ? `turns=${message.num_turns}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : 'unknown error';
};

const logCliResult = (message: ClaudeCliMessage, sessionId: string | undefined): void => {
  if (message.is_error) throw new AiProviderError(`Claude CLI failed: ${describeCliFailure(message)}`);
  logCliResultSummary(message);
  if (message.num_turns) {
    console.log(chalk.green(`  [${CLI_ADAPTER_LABEL}] Agent completed in ${message.num_turns} turn(s).`));
  }
  if (message.total_cost_usd && message.total_cost_usd > 0) {
    console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] Cost: $${message.total_cost_usd.toFixed(4)} USD`));
  }
  if (sessionId) {
    console.log(chalk.gray(`  [${CLI_ADAPTER_LABEL}] Provider session: ${sessionId}`));
  }
};

const processCliStream = (
  message: ClaudeCliMessage,
  repoDir: string,
  sessionId: string | undefined,
  touchedFiles: Set<string>
): string | undefined => {
  const updatedSession = message.session_id ?? sessionId;
  collectTouchedFiles(message, repoDir, touchedFiles);
  if (message.type === 'result') logCliResult(message, updatedSession);
  return updatedSession;
};

type CliContinuationPromptParams = {
  currentUnvisited: string[];
  totalPlanned: number;
  passNumber: number;
  taskBriefParams: BuildPlanContextParams;
};

const buildContinuationPrompt = (p: CliContinuationPromptParams): string => {
  const completed = p.totalPlanned - p.currentUnvisited.length;
  const unvisitedLines = p.currentUnvisited.map(f => `- ${f}`).join('\n');
  return [
    `Progress: ${completed}/${p.totalPlanned} files modified (pass ${p.passNumber})`,
    buildTaskBrief(p.taskBriefParams),
    `\nContinue implementing the remaining plan steps. The following planned files are still unmodified:\n\n${unvisitedLines}`,
    continuationTail,
  ].join('\n');
};

const logContinuationPassResult = (passNumber: number, message: ClaudeCliMessage): void => {
  if (message.type !== 'result') return;
  const outcome = message.is_error
    ? chalk.yellow(`  [${CLI_ADAPTER_LABEL}] Pass ${passNumber} completed with errors — continuing`)
    : chalk.green(`  [${CLI_ADAPTER_LABEL}] Pass ${passNumber} completed in ${message.num_turns ?? '?'} turn(s).`);
  console.log(outcome);
  if (message.total_cost_usd && message.total_cost_usd > 0) {
    console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] Pass ${passNumber} cost: $${message.total_cost_usd.toFixed(4)} USD`));
  }
};

type StallCheckParams = {
  previousWorkload: number;
  stalledPasses: number;
  currentUnvisited: string[];
  threshold: number;
};

const checkStallCondition = (
  { previousWorkload, stalledPasses, currentUnvisited, threshold }: StallCheckParams
): number => {
  const updated = currentUnvisited.length < previousWorkload ? 0 : stalledPasses + 1;
  if (updated < threshold) return updated;
  console.log(chalk.yellow(`\n  [${CLI_ADAPTER_LABEL}] Workload not decreasing after ${threshold} passes — stopping`));
  const remaining = `  [${CLI_ADAPTER_LABEL}] Remaining: ${currentUnvisited.length} planned file(s) not touched: ${currentUnvisited.join(', ')}`;
  console.log(chalk.yellow(remaining));
  return -1;
};

type ContinuationLoopResult = { sessionId: string | undefined; passCount: number };

type ContinuationPassOutcome = { sessionId: string | undefined; madeProgress: boolean };

type SinglePassResult = { sessionId: string | undefined; wrote: boolean; resultText: string };

const hasReachedNoOpCutoff = (noOpPasses: number): boolean => {
  if (noOpPasses < STALL_THRESHOLD) return false;
  console.log(chalk.yellow(`  [${CLI_ADAPTER_LABEL}] No file changes across ${STALL_THRESHOLD} passes — stopping`));
  return true;
};

const buildContinuationPassParams = (
  p: ContinuationLoopParams, pass: Pick<SinglePassParams, 'passNumber' | 'sessionId' | 'currentUnvisited'>,
): SinglePassParams => ({
  ...pass,
  appendSystemPrompt: undefined, model: p.model, repoDir: p.repoDir,
  additionalRepoDirs: p.additionalRepoDirs, touchedFiles: p.touchedFiles, activityState: p.activityState,
  totalPlanned: p.repoFiles.filter(f => !isGlobPattern(f)).length,
  taskBriefParams: p.taskBriefParams,
});

const acceptPassDeclarations = (p: ContinuationLoopParams, resultText: string): number =>
  acceptNoChangeDeclarations({
    declared: parseNoChangeDeclarations(resultText),
    repoName: p.repoName,
    plannedFiles: p.repoFiles,
    touchedFiles: p.touchedFiles,
    notApplicableFiles: p.notApplicableFiles,
  });

const logSdkProgressEvent = (message: ClaudeCliMessage, repoDir: string, activityState: ActivityState): boolean => {
  const progressLine = formatProgressMessage(message as never);
  if (!progressLine) return false;
  const label = progressLine.replace(`[${ANTHROPIC_AGENT_LABEL}]`, `[${CLI_ADAPTER_LABEL}]`);
  console.log(resolveProgressColor(message as never)(label));
  for (const line of formatActivityMessages(message as never, repoDir, activityState)) {
    console.log(chalk.cyan(line.replace(`[${ANTHROPIC_AGENT_LABEL}]`, `[${CLI_ADAPTER_LABEL}]`)));
  }
  return true;
};

const logCliProgressEvent = (message: ClaudeCliMessage, repoDir: string, activityState: ActivityState): boolean => {
  if (message.type === 'system' && message.subtype === 'task_progress' && message.last_tool_name === 'Skill') {
    const raw = message.summary ?? message.description;
    const summary = (typeof raw === 'string' ? raw : '').trim();
    if (summary) console.log(chalk.gray(`  [${CLI_ADAPTER_LABEL}] Skill: ${summary}`));
    return true;
  }
  if (logSdkProgressEvent(message, repoDir, activityState)) return true;
  const activityLines = formatActivityMessages(message as never, repoDir, activityState);
  for (const line of activityLines) {
    console.log(chalk.cyan(line.replace(`[${ANTHROPIC_AGENT_LABEL}]`, `[${CLI_ADAPTER_LABEL}]`)));
  }
  return activityLines.length > 0;
};

const logWriteEditEvent = (
  toolName: string,
  input: Record<string, unknown>,
  repoDir: string,
  touchedFiles: Set<string> | undefined
): boolean => {
  const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '';
  if (!filePath) return false;
  const relativePath = path.isAbsolute(filePath) ? path.relative(repoDir, filePath) : filePath;
  const action = toolName === 'Write' ? 'created' : 'updated';
  console.log(chalk.gray(`  [${CLI_ADAPTER_LABEL}] File ${action}: ${relativePath}`));
  touchedFiles?.add(relativePath);
  return true;
};

const logBashEvent = (input: Record<string, unknown>, activityState: ActivityState): void => {
  const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
  if (!command) return;
  activityState.lastVerificationCommand = command;
  console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] Verification running: ${command}`));
};

const resolveReadTarget = (input: Record<string, unknown>): string => {
  if (typeof input['file_path'] === 'string') return input['file_path'];
  if (typeof input['pattern'] === 'string') return input['pattern'];
  return '';
};

const logReadEvent = (toolName: string, input: Record<string, unknown>): void => {
  const target = resolveReadTarget(input);
  if (!target) return;
  const short = target.length > 60 ? `${target.slice(0, 57)}...` : target;
  console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] ${toolName}: ${short}`));
};

const logToolResultVerification = (
  block: ResultBlock,
  activityState: ActivityState,
): void => {
  const content = typeof block.content === 'string' ? block.content : '';
  if (!content || !activityState.lastVerificationCommand) return;
  const status = detectVerificationStatus(content, block.is_error);
  if (!status) return;
  const command = activityState.lastVerificationCommand;
  const color = status === 'failed' ? chalk.red : chalk.green;
  console.log(color(`  [${CLI_ADAPTER_LABEL}] Verification ${status}: ${command}`));
  activityState.lastVerificationCommand = undefined;
};

const computeUnvisitedFiles = (
  repoFiles: string[], repoName: string, touchedFiles: Set<string>, notApplicableFiles: Set<string>,
): string[] =>
  repoFiles
    .map(f => stripRepoPrefix(f, repoName))
    .filter(f => !touchedFiles.has(f) && !notApplicableFiles.has(f) && !isGlobPattern(f));

const screenshotMediaTypes: Record<string, UiDesignScreenshot['mediaType']> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
};

const toScreenshot = (imgPath: string): UiDesignScreenshot => ({
  path: imgPath,
  mediaType: screenshotMediaTypes[path.extname(imgPath).toLowerCase()] ?? 'image/png',
  base64: '',
});

const buildImplementCliArgs = (p: CliSessionParams) =>
  buildCliArgs({
    prompt: resolveInitialUserPrompt(p.options.initialPromptOverride, p.taskBriefParams),
    appendSystemPrompt: p.appendSystemPrompt,
    model: p.model,
    cwd: p.repoDir,
    tools: implementTools,
    permissionMode: 'acceptEdits',
    addDirs: p.additionalRepoDirs.length > 0 ? p.additionalRepoDirs : undefined,
    sessionId: p.options.resumeProviderSessionId,
    screenshots: p.uiDesignScreenshotPaths?.map(toScreenshot),
  });

const buildCliSystemPromptParams = (params: GenerateAndVerifyParams): Parameters<typeof buildSystemPrompt>[0] => ({
  repoDir: params.options.repoDir ?? process.cwd(),
  conventionsSection: params.conventionsSection,
});

const buildAppendSystemPrompt = async (params: GenerateAndVerifyParams, repoDir: string): Promise<string> =>
  buildCliSystemPrompt(
    params.options.priorStageSummary,
    await loadClaudeContext(repoDir),
    buildSystemPrompt(buildCliSystemPromptParams(params)),
  );

const resolveAdditionalRepoDirs = (params: GenerateAndVerifyParams): string[] =>
  params.options.additionalRepoDirs ?? [];

const buildCliTaskBriefParams = (
  params: GenerateAndVerifyParams, repoDir: string, skillFragment: string,
): BuildPlanContextParams => ({
  ticketKey: params.ticket.ticketKey, repoDir, repoName: params.repoName,
  repoFiles: params.repoFiles, trackedFilePaths: params.trackedFilePaths,
  verificationScripts: params.verificationScripts, planSteps: params.planArtifact.plan.steps,
  planSummary: params.planArtifact.plan.summary, planAction: params.planArtifact.plan.action,
  planRisks: formatPlanRisks(params.planArtifact.plan.risks), contextFiles: params.contextFiles,
  skillFragment: skillFragment.length > 0 ? skillFragment : undefined, figmaContextSection: params.figmaContextSection,
  phases: params.planArtifact.plan.phases ?? undefined,
});

const createCliSessionParams = async (
  params: GenerateAndVerifyParams, repoDir: string, model: string, appendSystemPrompt: string,
): Promise<Omit<CliSessionParams, 'planStepCount'>> => {
  const skillFragment = params.skillNames?.length
    ? await buildSkillPromptFragment(params.skillNames, CLI_ADAPTER_LABEL, chalk.gray)
    : '';
  return {
    options: params.options, repoFiles: params.repoFiles, repoName: params.repoName,
    repoDir, appendSystemPrompt, model,
    additionalRepoDirs: resolveAdditionalRepoDirs(params),
    verificationScripts: params.verificationScripts,
    taskBriefParams: buildCliTaskBriefParams(params, repoDir, skillFragment),
    uiDesignScreenshotPaths: params.uiDesignScreenshotPaths,
  };
};

const buildPassCliArgs = (p: SinglePassParams, continuationPrompt: string) =>
  buildCliArgs({
    prompt: continuationPrompt,
    appendSystemPrompt: p.appendSystemPrompt,
    model: p.model,
    cwd: p.repoDir,
    sessionId: p.sessionId,
    tools: implementTools,
    permissionMode: 'acceptEdits',
    addDirs: p.additionalRepoDirs.length > 0 ? p.additionalRepoDirs : undefined,
  });

interface VerificationFixState {
  outcomes: VerificationOutcome[];
  codeFailures: VerificationOutcome[];
  sessionId: string | undefined;
  prevFails: number;
  stalled: number;
  readOnly: number;
  passNumber: number;
  exhausted: boolean;
}

/**
 * Claude CLI headless mode (`claude -p`) implementer backend.
 * Spawns the Claude CLI as a subprocess with `--permission-mode acceptEdits`
 * and streams NDJSON progress messages.
 */
export class ClaudeCliAdapter implements ImplementerBackend {
  constructor(private readonly configService: ConfigService) {}

  async generateAndVerify(
    params: GenerateAndVerifyParams,
  ): Promise<{
    sessionId?: string; verificationOutcomes: VerificationOutcome[];
    passCount: number; modelsUsed: string[]; verificationPassCount: number; planProblems: PlanProblem[];
  }> {
    assertClaudeCliAvailable();
    const sessionParams = await this.buildCliSessionParams(params);
    const result = await this.runCliSession(sessionParams);
    // Reported separately from the configured stage model: auto-routing may have selected the
    // mechanical model, in which case the configured one never ran.
    return { ...result, modelsUsed: [sessionParams.model] };
  }

  private async buildCliSessionParams(params: GenerateAndVerifyParams): Promise<CliSessionParams> {
    const { options } = params;
    const repoDir = options.repoDir ?? process.cwd();
    const modelRoutingResult = this.resolveCliModelRouting(options, params.planArtifact);
    console.log(chalk.cyan(`  ${modelRoutingResult.logMessage}`));
    const appendSystemPrompt = await buildAppendSystemPrompt(params, repoDir);
    return {
      ...await createCliSessionParams(params, repoDir, modelRoutingResult.model, appendSystemPrompt),
      verificationPassOffset: params.verificationPassOffset,
      planStepCount: params.planArtifact.plan.steps.length,
    };
  }

  private resolveCliModelRouting(options: ImplementerOptions, planArtifact: PlanArtifact) {
    return resolveModelRouting({
      routing: options.modelRouting ?? 'auto',
      fallbackDefaultModel: resolveProviderModel(this.configService, 'anthropic', DEFAULT_ANTHROPIC_MODEL),
      defaultMechanicalModel: DEFAULT_ANTHROPIC_MECHANICAL_MODEL,
      configService: this.configService,
      plan: planArtifact.plan,
      adapterLabel: CLI_ADAPTER_LABEL,
    });
  }

  /**
   * Resolves the implement stage's wall-clock and inactivity timeouts from config.
   * Without this the hardcoded defaults apply, and `stages.implement.timeoutMs` /
   * `inactivityTimeoutMs` are silently ignored even though the schema accepts them.
   *
   * @returns Wall-clock and inactivity timeouts in milliseconds
   */
  private resolveImplementTimeouts(): { timeoutMs: number; inactivityTimeoutMs: number } {
    return {
      timeoutMs: this.configService.get<number>('stages.implement.timeoutMs', CLI_TIMEOUT_MS),
      inactivityTimeoutMs: this.configService.get<number>(
        'stages.implement.inactivityTimeoutMs',
        CLI_INACTIVITY_TIMEOUT_MS
      ),
    };
  }

  private async completeCliSession(
    p: CliSessionParams,
    sessionId: string | undefined,
    touchedFiles: Set<string>,
    activityState: ActivityState
  ): Promise<{
    sessionId?: string; verificationOutcomes: VerificationOutcome[]; passCount: number; verificationPassCount: number;
    planProblems: PlanProblem[];
  }> {
    await discoverChangedFiles(p.repoDir, touchedFiles);
    const notApplicableFiles = new Set<string>();
    return this.finalizeCliSession({ ...p, sessionId, touchedFiles, notApplicableFiles, activityState });
  }

  private openImplementStream(p: CliSessionParams): AsyncGenerator<ClaudeCliMessage, void, undefined> {
    const { timeoutMs, inactivityTimeoutMs } = this.resolveImplementTimeouts();
    const prompt = buildClaudeStdinPrompt({
      prompt: resolveInitialUserPrompt(p.options.initialPromptOverride, p.taskBriefParams),
      screenshots: p.uiDesignScreenshotPaths?.map(toScreenshot),
    });
    return spawnCli(buildImplementCliArgs(p), p.repoDir, prompt, undefined, timeoutMs, inactivityTimeoutMs);
  }

  private async readImplementStream(
    p: CliSessionParams, activityState: ActivityState, touchedFiles: Set<string>,
  ): Promise<{ sessionId: string | undefined; resultText: string }> {
    let sessionId: string | undefined = p.options.resumeProviderSessionId;
    let resultText = '';
    for await (const message of this.openImplementStream(p)) {
      this.logCliMessage(message, p.repoDir, activityState, touchedFiles);
      sessionId = processCliStream(message, p.repoDir, sessionId, touchedFiles);
      if (message.type === 'result' && !message.is_error) resultText = message.result ?? '';
    }
    return { sessionId, resultText };
  }

  private async runCliSession(
    p: CliSessionParams,
  ): Promise<{
    sessionId?: string; verificationOutcomes: VerificationOutcome[]; passCount: number; verificationPassCount: number;
    planProblems: PlanProblem[];
  }> {
    console.log(chalk.bold.cyan(`\n  [${CLI_ADAPTER_LABEL}] Running CLI agent in ${p.repoDir}...`));
    const touchedFiles = new Set<string>();
    const activityState: ActivityState = { verificationOutcomes: [], planProblems: [] };
    const { sessionId, resultText } = await this.readImplementStream(p, activityState, touchedFiles);
    collectPlanProblems(activityState.planProblems, resultText, p.planStepCount);
    return this.completeCliSession(p, sessionId, touchedFiles, activityState);
  }

  private async finalizeCliSession(
    p: ContinuationLoopParams,
  ): Promise<{
    sessionId?: string; verificationOutcomes: VerificationOutcome[]; passCount: number; verificationPassCount: number;
    planProblems: PlanProblem[];
  }> {
    const { sessionId, passCount } = await this.runContinuationLoop(p);
    logFileSummary(p.touchedFiles, p.notApplicableFiles);
    const { outcomes, verificationPassCount } = await this.runProgrammaticVerificationLoop(p, sessionId);
    printVerificationReport(outcomes);
    return {
      sessionId, verificationOutcomes: outcomes, passCount, verificationPassCount,
      planProblems: p.activityState.planProblems,
    };
  }

  private async runVerificationFixPass(
    p: ContinuationLoopParams, passNumber: number, sessionId: string, codeFailures: VerificationOutcome[],
  ): Promise<{ sessionId: string | undefined; wrote: boolean }> {
    const result = await this.runSinglePass({
      passNumber: 100 + passNumber, sessionId, currentUnvisited: [],
      promptOverride: buildVerificationFixPrompt(codeFailures, p.repoFiles, p.taskBriefParams.skillFragment),
      appendSystemPrompt: undefined, model: p.model,
      repoDir: p.repoDir, additionalRepoDirs: p.additionalRepoDirs,
      touchedFiles: p.touchedFiles, activityState: p.activityState,
    });
    collectPlanProblems(p.activityState.planProblems, result.resultText, p.planStepCount);
    if (result.sessionId) await discoverChangedFiles(p.repoDir, p.touchedFiles);
    return result;
  }

  private async evaluateVerificationPass(
    scripts: VerificationScript[], repoDir: string, passNumber: number,
  ): Promise<{ outcomes: VerificationOutcome[]; codeFailures: VerificationOutcome[] }> {
    console.log(chalk.bold(`\n  Running verification (pass ${passNumber})...`));
    const outcomes = await runProgrammaticVerification(scripts, repoDir);
    const { codeFailures, commandFailures } = partitionFailures(getEnforcedFailures(outcomes));
    for (const cf of commandFailures) {
      console.log(chalk.gray(`    [${CLI_ADAPTER_LABEL}] Skipping unfixable command: ${cf.command}`));
    }
    return { outcomes, codeFailures };
  }

  private logFixPassStart(passNumber: number, failureCount: number): void {
    console.log(chalk.yellow(
      `\n  [${CLI_ADAPTER_LABEL}] Fix pass ${passNumber}: `
      + `${failureCount} enforced verification(s) failed — sending back for resolution`,
    ));
  }

  private async attemptVerificationFix(
    p: ContinuationLoopParams, passNumber: number, sessionId: string, codeFailures: VerificationOutcome[],
  ): Promise<{ sessionId: string | undefined; wrote: boolean }> {
    this.logFixPassStart(passNumber, codeFailures.length);
    const fix = await this.runVerificationFixPass(p, passNumber, sessionId, codeFailures);
    if (!fix.wrote) console.log(chalk.gray(`  [${CLI_ADAPTER_LABEL}] No files written during fix pass — skipping re-verification`));
    return fix;
  }

  private async initVerificationFixState(
    p: ContinuationLoopParams, sessionId: string | undefined
  ): Promise<VerificationFixState> {
    const passNumber = (p.verificationPassOffset ?? 0) + 1;
    const { outcomes, codeFailures } = await this.evaluateVerificationPass(
      p.verificationScripts, p.repoDir, passNumber,
    );
    return {
      outcomes, codeFailures, sessionId, prevFails: Infinity, stalled: 0, readOnly: 0, passNumber, exhausted: false,
    };
  }

  /**
   * Resolves the stall cap for the implement verification-fix loop from
   * `stages.implement.stallThresholdForVerificationFix`. Without this read the config field is
   * accepted by the schema but the loop silently uses the hardcoded default.
   */
  private resolveStallThreshold(): number {
    return this.configService.get<number>('stages.implement.stallThresholdForVerificationFix', STALL_THRESHOLD);
  }

  private shouldRunFixIteration(state: VerificationFixState): boolean {
    return !state.exhausted
      && state.codeFailures.length > 0
      && state.sessionId !== undefined
      && state.readOnly < this.resolveStallThreshold();
  }

  private async applySuccessfulFix(
    scripts: VerificationScript[], repoDir: string, state: VerificationFixState
  ): Promise<void> {
    state.readOnly = 0;
    const next = await this.evaluateVerificationPass(scripts, repoDir, ++state.passNumber);
    state.outcomes = next.outcomes;
    state.codeFailures = next.codeFailures;
    state.stalled = checkVerificationStall(
      state.codeFailures.length, state.prevFails, state.stalled, CLI_ADAPTER_LABEL, this.resolveStallThreshold()
    );
    if (state.stalled < 0) state.exhausted = true;
    state.prevFails = state.codeFailures.length;
  }

  private async runVerificationFixIteration(
    p: ContinuationLoopParams, state: VerificationFixState
  ): Promise<void> {
    state.readOnly++;
    const { sessionId } = state;
    if (!sessionId) return;
    const fix = await this.attemptVerificationFix(p, state.passNumber, sessionId, state.codeFailures);
    state.sessionId = fix.sessionId;
    if (!state.sessionId || !fix.wrote) return;
    await this.applySuccessfulFix(p.verificationScripts, p.repoDir, state);
  }

  private async runProgrammaticVerificationLoop(
    p: ContinuationLoopParams, sessionId: string | undefined
  ): Promise<{ outcomes: VerificationOutcome[]; verificationPassCount: number }> {
    const state = await this.initVerificationFixState(p, sessionId);
    while (this.shouldRunFixIteration(state)) {
      await this.runVerificationFixIteration(p, state);
    }
    const verificationPassCount = state.passNumber - (p.verificationPassOffset ?? 0);
    return { outcomes: state.outcomes, verificationPassCount };
  }

  private async runContinuationLoop(p: ContinuationLoopParams): Promise<ContinuationLoopResult> {
    let previousWorkload = Infinity, stalledPasses = 0, passNumber = 0, noOpPasses = 0, sessionId = p.sessionId;
    const threshold = computeStallThreshold(p.repoFiles.filter(f => !isGlobPattern(f)).length);
    while (sessionId) {
      const currentUnvisited = computeUnvisitedFiles(p.repoFiles, p.repoName, p.touchedFiles, p.notApplicableFiles);
      stalledPasses = checkStallCondition({ previousWorkload, stalledPasses, currentUnvisited, threshold });
      if (currentUnvisited.length === 0 || stalledPasses === -1) break;
      previousWorkload = currentUnvisited.length;
      const pass = await this.executePassAndDiscover(p, ++passNumber, sessionId, currentUnvisited);
      sessionId = pass.sessionId;
      noOpPasses = pass.madeProgress ? 0 : noOpPasses + 1;
      if (hasReachedNoOpCutoff(noOpPasses)) break;
    }
    return { sessionId, passCount: passNumber };
  }

  private async executePassAndDiscover(
    p: ContinuationLoopParams, passNumber: number, sessionId: string, currentUnvisited: string[],
  ): Promise<ContinuationPassOutcome> {
    console.log(chalk.yellow(`\n  [${CLI_ADAPTER_LABEL}] Pass ${passNumber}: ${currentUnvisited.length} planned file(s) not touched — continuing`));
    const touchedBefore = p.touchedFiles.size;
    const pass = await this.runSinglePass(buildContinuationPassParams(p, { passNumber, sessionId, currentUnvisited }));
    await discoverChangedFiles(p.repoDir, p.touchedFiles);
    const accepted = acceptPassDeclarations(p, pass.resultText);
    collectPlanProblems(p.activityState.planProblems, pass.resultText, p.planStepCount);
    const madeProgress = pass.wrote || p.touchedFiles.size > touchedBefore || accepted > 0;
    return { sessionId: pass.sessionId, madeProgress };
  }

  private buildPassPrompt(p: SinglePassParams): string {
    if (!p.taskBriefParams) throw new ExecutionError('[claude-cli] taskBriefParams is required to build a continuation prompt');
    return buildContinuationPrompt({
      currentUnvisited: p.currentUnvisited, totalPlanned: p.totalPlanned ?? p.currentUnvisited.length,
      passNumber: p.passNumber, taskBriefParams: p.taskBriefParams,
    });
  }

  private async runSinglePass(p: SinglePassParams): Promise<SinglePassResult> {
    const continuationPrompt = p.promptOverride ?? this.buildPassPrompt(p);
    const continueArgs = buildPassCliArgs(p, continuationPrompt);
    const { timeoutMs, inactivityTimeoutMs } = this.resolveImplementTimeouts();
    const stream = spawnCli(continueArgs, p.repoDir, continuationPrompt, undefined, timeoutMs, inactivityTimeoutMs);
    const result: SinglePassResult = { sessionId: p.sessionId, wrote: false, resultText: '' };
    for await (const message of stream) this.applyPassMessage(p, message, result);
    return result;
  }

  private applyPassMessage(p: SinglePassParams, message: ClaudeCliMessage, result: SinglePassResult): void {
    if (this.logCliMessage(message, p.repoDir, p.activityState, p.touchedFiles)) result.wrote = true;
    result.sessionId = processCliStream(message, p.repoDir, result.sessionId, p.touchedFiles);
    logContinuationPassResult(p.passNumber, message);
    if (message.type === 'result' && !message.is_error) result.resultText = message.result ?? '';
  }

  private logCliMessage(
    message: ClaudeCliMessage,
    repoDir: string,
    activityState: ActivityState,
    touchedFiles?: Set<string>,
  ): boolean {
    if (logCliProgressEvent(message, repoDir, activityState)) return false;
    if (message.type === 'assistant') return this.logCliAssistantMessage(message, repoDir, activityState, touchedFiles);
    if (message.type === 'user') this.logCliToolResult(message, activityState);
    return false;
  }

  private logCliAssistantMessage(
    message: ClaudeCliMessage,
    repoDir: string,
    activityState: ActivityState,
    touchedFiles?: Set<string>
  ): boolean {
    const contentBlocks = (message.message as { content?: ToolBlock[] } | undefined)?.content;
    if (!Array.isArray(contentBlocks)) return false;
    let wrote = false;
    for (const block of contentBlocks) {
      if (this.logAssistantToolBlock({ block, repoDir, activityState, touchedFiles })) wrote = true;
    }
    return wrote;
  }

  private logAssistantToolBlock(p: ToolBlockLogParams): boolean {
    const { block, repoDir, activityState, touchedFiles } = p;
    if (block.type !== 'tool_use' || !block.name) return false;
    const input = block.input ?? {};
    if (block.name === 'Write' || block.name === 'Edit')
      return logWriteEditEvent(block.name, input, repoDir, touchedFiles);
    if (block.name === 'Bash') logBashEvent(input, activityState);
    if (block.name === 'Read' || block.name === 'Glob' || block.name === 'Grep') logReadEvent(block.name, input);
    if (block.name === 'Skill') this.logSkillBlock(input);
    return false;
  }

  private logSkillBlock(input: Record<string, unknown>): void {
    const skillName = typeof input['skill'] === 'string' ? input['skill'] : '';
    if (skillName) console.log(chalk.gray(`  [${CLI_ADAPTER_LABEL}] Skill: ${skillName}`));
  }

  private logCliToolResult(
    message: ClaudeCliMessage,
    activityState: ActivityState,
  ): void {
    const contentBlocks = (message.message as { content?: ResultBlock[] } | undefined)?.content;
    if (!Array.isArray(contentBlocks)) return;
    for (const block of contentBlocks) {
      if (block.type === 'tool_result') logToolResultVerification(block, activityState);
    }
  }
}
