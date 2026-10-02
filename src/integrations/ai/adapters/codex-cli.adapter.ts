import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import * as path from 'node:path';
import { AiProviderError } from '../../../shared/utils/errors';
import type {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  ImplementerBackend,
  VerificationScript,
  VerificationOutcome,
} from '../../../agents/interfaces';
import { resolveModelRouting, resolveProviderModel, discoverChangedFiles } from './shared-routing';
import { buildSystemPrompt } from './anthropic-agent.adapter';
import { assertCodexCliAvailable, buildCodexCliArgs, CLI_INACTIVITY_TIMEOUT_MS, CLI_TIMEOUT_MS, getCodexCliVersion, spawnCodex, type CodexCliMessage } from './codex-cli-runner';
import {
  printVerificationReport, getEnforcedFailures,
  buildVerificationFixPrompt, runProgrammaticVerification,
  checkVerificationStall, partitionFailures, DEFAULT_STALL_THRESHOLD,
} from './verification-report';

const DEFAULT_MECHANICAL_MODEL = 'gpt-5.4-mini';
const CODEX_ADAPTER_LABEL = 'codex-cli';

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
  uiDesignScreenshotPaths?: string[];
  verificationPassOffset?: number;
};

type CodexSessionResult = {
  sessionId?: string;
  verificationOutcomes: VerificationOutcome[];
  modelsUsed: string[];
  verificationPassCount: number;
};

type AssistantBlock = { type: string; name?: string; input?: Record<string, unknown> };

type ActivityState = {
  lastVerificationCommand?: string;
  verificationOutcomes: VerificationOutcome[];
};

type CodexVerificationLoopParams = {
  params: GenerateAndVerifyParams;
  activityState: ActivityState;
  touchedFiles: Set<string>;
  sessionId: string | undefined;
  model: string;
  repoDir: string;
};

type StreamContext = {
  cliArgs: string[];
  repoDir: string;
  implementPrompt: string;
  touchedFiles: Set<string>;
  activityState: ActivityState;
  verificationScripts: VerificationScript[];
  timeoutMs: number;
  inactivityTimeoutMs: number;
};

const buildPriorStagePreamble = (options: ImplementerOptions): string =>
  options.priorStageSummary
    ? `<prior-stage-context>\n${options.priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.\n\n`
    : '';

const buildCodexRawSystemPrompt = (params: GenerateAndVerifyParams, repoDir: string): string =>
  buildSystemPrompt({ repoDir, conventionsSection: params.conventionsSection });

const buildCodexImplementPrompt = (params: GenerateAndVerifyParams, repoDir: string): string => {
  const systemPrompt = buildCodexRawSystemPrompt(params, repoDir);
  const preamble = buildPriorStagePreamble(params.options);
  const screenshotPaths = params.uiDesignScreenshotPaths?.length
    ? '\n\nDesign screenshots (accessible via filesystem):\n' + params.uiDesignScreenshotPaths.map(p => `- ${p}`).join('\n')
    : '';
  return `${preamble}${systemPrompt}${screenshotPaths}\n\nImplement the changes described above now. Read existing files, apply changes. After ALL edits are complete, run each command listed under "Verification commands:" exactly as written, in order. Do not modify or pipe the commands.`;
};

const logCommandStarted = (message: CodexCliMessage): boolean => {
  if (message.type !== 'item.started') return false;
  if (message.item?.type !== 'command_execution' || !message.item.command) return false;
  const raw = message.item.command.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
  const cmd = raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
  console.log(chalk.cyan(`  [${CODEX_ADAPTER_LABEL}] Running: ${cmd}`));
  return true;
};

const logCommandCompleted = (message: CodexCliMessage): boolean => {
  if (message.type !== 'item.completed') return false;
  if (message.item?.type !== 'command_execution') return false;
  const raw = (message.item.command ?? 'unknown').replaceAll('\r', '\\r').replaceAll('\n', '\\n');
  const shortCmd = raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
  if (message.item.exit_code === 0) {
    console.log(chalk.green(`  [${CODEX_ADAPTER_LABEL}] Command completed: ${shortCmd}`));
  } else if (message.item.exit_code == null) {
    console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] Command status unknown: ${shortCmd}`));
  } else {
    console.log(chalk.red(`  [${CODEX_ADAPTER_LABEL}] Command failed (exit ${message.item.exit_code}): ${shortCmd}`));
  }
  return true;
};

const logCodexCommandEvent = (message: CodexCliMessage): boolean =>
  logCommandStarted(message) || logCommandCompleted(message);

const resolveBlockFilePath = (input: Record<string, unknown>): string => {
  if (typeof input['file_path'] === 'string') return input['file_path'];
  if (typeof input['path'] === 'string') return input['path'];
  return '';
};

const processAssistantBlock = (block: AssistantBlock, repoDir: string, touchedFiles: Set<string>): boolean => {
  if (block.type !== 'tool_use' || !block.name) return false;
  if (!['write', 'edit', 'Write', 'Edit'].includes(block.name)) return false;
  const filePath = resolveBlockFilePath(block.input ?? {});
  if (!filePath) return false;
  const relativePath = path.isAbsolute(filePath) ? path.relative(repoDir, filePath) : filePath;
  touchedFiles.add(relativePath);
  console.log(chalk.cyan(`  [${CODEX_ADAPTER_LABEL}] File updated: ${relativePath}`));
  return true;
};

const logCodexAssistantBlocks = (message: CodexCliMessage, repoDir: string, touchedFiles: Set<string>): boolean => {
  if (message.type !== 'assistant') return false;
  const innerMessage = message.message as { content?: AssistantBlock[] } | undefined;
  const blocks = innerMessage?.content;
  if (!Array.isArray(blocks)) return false;
  let wrote = false;
  for (const block of blocks) if (processAssistantBlock(block, repoDir, touchedFiles)) wrote = true;
  return wrote;
};

const logAgentSummary = (message: CodexCliMessage): void => {
  if (message.type !== 'item.completed' || message.item?.type !== 'agent_message') return;
  const summary = message.item.text?.trim();
  if (!summary) return;
  console.log(chalk.bold('\n  Summary:'));
  for (const line of summary.split('\n')) {
    if (line.trim()) console.log(chalk.cyan(`    ${line}`));
  }
};

const trackMessageFiles = (message: CodexCliMessage, repoDir: string, touchedFiles: Set<string>): boolean => {
  if (!message.files || message.files.length === 0) return false;
  for (const { filename } of message.files) {
    const absolutePath = path.isAbsolute(filename) ? filename : path.resolve(repoDir, filename);
    touchedFiles.add(path.relative(repoDir, absolutePath));
  }
  return true;
};

const logAgentMessageText = (message: CodexCliMessage): boolean => {
  if (message.type !== 'item.completed' || message.item?.type !== 'agent_message') return false;
  if (!message.item.text) return false;
  const raw = message.item.text;
  const text = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  console.log(chalk.cyan(`  [${CODEX_ADAPTER_LABEL}] Agent: ${text}`));
  return true;
};

const matchVerificationScript = (
  command: string, scripts: VerificationScript[],
): VerificationScript | undefined =>
  scripts.find(s => command.includes(s.command) || s.command.includes(command));

const applyCodexVerificationOutcome = (
  message: CodexCliMessage,
  activityState: ActivityState,
  verificationScripts: VerificationScript[],
): void => {
  if (message.type !== 'item.completed' || message.item?.type !== 'command_execution') return;
  const command = message.item.command;
  if (!command || message.item.exit_code == null) return;
  const script = matchVerificationScript(command, verificationScripts);
  if (!script) return;
  const status = message.item.exit_code === 0 ? 'passed' : 'failed';
  activityState.verificationOutcomes.push({ id: script.id, command, policy: script.policy, status });
};

/**
 * A terminal error from the codex runner (timeout, inactivity_timeout, no_progress) ends
 * the message stream with no further activity — silently continuing here would let the
 * implement stage report success on a killed, incomplete run.
 */
const describeTerminalCodexMessage = (message: CodexCliMessage): string => {
  const subtypeSuffix = message.subtype ? ` (${message.subtype})` : '';
  return `Codex CLI returned ${message.type}${subtypeSuffix}.`;
};

const throwOnTerminalCodexError = (message: CodexCliMessage): void => {
  if (!message.is_error) return;
  const detail = message.result ?? describeTerminalCodexMessage(message);
  throw new AiProviderError(`Codex CLI returned an error: ${detail}`, { subtype: message.subtype }, true, 'stall');
};

const processCodexMessage = (
  message: CodexCliMessage, ctx: StreamContext,
): { sessionId?: string; wrote: boolean } => {
  if (message.type === 'system' && message.summary)
    console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] ${message.summary}`));
  if (message.tool_name) console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] Tool: ${message.tool_name}`));
  if (logCodexCommandEvent(message)) return { wrote: false };
  if (logAgentMessageText(message)) return { wrote: false };
  const wrote = [logCodexAssistantBlocks(message, ctx.repoDir, ctx.touchedFiles),
    trackMessageFiles(message, ctx.repoDir, ctx.touchedFiles)].some(Boolean);
  logAgentSummary(message);
  applyCodexVerificationOutcome(message, ctx.activityState, ctx.verificationScripts);
  const sessionId = message.type === 'thread.started' ? message.thread_id : undefined;
  return { sessionId, wrote };
};

const applyCodexMessage = (
  message: CodexCliMessage, ctx: StreamContext, state: { sessionId: string | undefined; wrote: boolean },
): void => {
  throwOnTerminalCodexError(message);
  const result = processCodexMessage(message, ctx);
  if (result.sessionId) state.sessionId = result.sessionId;
  if (result.wrote) state.wrote = true;
};

const processCodexStream = async (
  ctx: StreamContext,
  initialSessionId: string | undefined,
): Promise<{ sessionId: string | undefined; wrote: boolean }> => {
  const state = { sessionId: initialSessionId, wrote: false };
  for await (const message of spawnCodex(
    ctx.cliArgs, ctx.repoDir, ctx.implementPrompt, undefined, ctx.timeoutMs, ctx.inactivityTimeoutMs,
  )) {
    applyCodexMessage(message, ctx, state);
  }
  return state;
};

const resolveCodexModelRouting = (
  options: ImplementerOptions,
  planArtifact: PlanArtifact,
  configService: ConfigService,
) =>
  resolveModelRouting({
    routing: options.modelRouting ?? 'auto',
    fallbackDefaultModel: resolveProviderModel(configService, 'openai', 'gpt-4.1'),
    defaultMechanicalModel: DEFAULT_MECHANICAL_MODEL,
    configService,
    plan: planArtifact.plan,
    adapterLabel: CODEX_ADAPTER_LABEL,
  });

const resolveCodexModel = (
  options: ImplementerOptions,
  planArtifact: PlanArtifact,
  configService: ConfigService,
): string => {
  const result = resolveCodexModelRouting(options, planArtifact, configService);
  console.log(chalk.cyan(`  ${result.logMessage}`));
  return result.model;
};

const logTouchedFiles = (touchedFiles: Set<string>): void => {
  if (touchedFiles.size === 0) return;
  console.log(chalk.bold(`\n  Files touched (${touchedFiles.size}):`));
  for (const f of touchedFiles) console.log(chalk.gray(`    ${f}`));
};

type RunCodexStreamResult = { sessionId: string | undefined; touchedFiles: Set<string> };

const buildStreamContext = (
  params: GenerateAndVerifyParams, repoDir: string, model: string, activityState: ActivityState,
  timeoutMs: number, inactivityTimeoutMs: number,
): StreamContext => {
  const implementPrompt = params.options.initialPromptOverride ?? buildCodexImplementPrompt(params, repoDir);
  const cliArgs = buildCodexCliArgs({
    prompt: implementPrompt, model, cwd: repoDir,
    permissionMode: 'full-auto', sessionId: params.options.resumeProviderSessionId,
    codexVersion: getCodexCliVersion(),
  });
  return {
    cliArgs, repoDir, implementPrompt, timeoutMs, inactivityTimeoutMs,
    touchedFiles: new Set<string>(), activityState, verificationScripts: params.verificationScripts,
  };
};

const runCodexStream = async (
  params: GenerateAndVerifyParams, repoDir: string, model: string, activityState: ActivityState,
  timeoutMs: number, inactivityTimeoutMs: number,
): Promise<RunCodexStreamResult> => {
  const ctx = buildStreamContext(params, repoDir, model, activityState, timeoutMs, inactivityTimeoutMs);
  const { sessionId } = await processCodexStream(ctx, params.options.resumeProviderSessionId);
  return { sessionId, touchedFiles: ctx.touchedFiles };
};

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

export class CodexCliAdapter implements ImplementerBackend {
  constructor(private readonly configService: ConfigService) {}

  private resolveImplementTimeouts(): { timeoutMs: number; inactivityTimeoutMs: number } {
    return {
      timeoutMs: this.configService.get<number>('stages.implement.timeoutMs', CLI_TIMEOUT_MS),
      inactivityTimeoutMs: this.configService.get<number>(
        'stages.implement.inactivityTimeoutMs', CLI_INACTIVITY_TIMEOUT_MS,
      ),
    };
  }

  async generateAndVerify(
    params: GenerateAndVerifyParams,
  ): Promise<{
    sessionId?: string; verificationOutcomes: VerificationOutcome[];
    modelsUsed?: string[]; verificationPassCount: number;
  }> {
    const repoDir = params.options.repoDir ?? process.cwd();
    assertCodexCliAvailable();
    const model = resolveCodexModel(params.options, params.planArtifact, this.configService);
    return this.runCodexSession(params, model, repoDir);
  }

  private async runCodexSession(
    params: GenerateAndVerifyParams, model: string, repoDir: string,
  ): Promise<CodexSessionResult> {
    console.log(chalk.bold.cyan(`\n  [${CODEX_ADAPTER_LABEL}] Running Codex CLI agent in ${repoDir}...`));
    const activityState: ActivityState = { verificationOutcomes: [] };
    const { timeoutMs, inactivityTimeoutMs } = this.resolveImplementTimeouts();
    const { sessionId, touchedFiles } = await runCodexStream(
      params, repoDir, model, activityState, timeoutMs, inactivityTimeoutMs,
    );
    await discoverChangedFiles(repoDir, touchedFiles);
    const finalized = await this.finalizeCodexSession(params, activityState, touchedFiles, sessionId, model);
    return { ...finalized, modelsUsed: [model] };
  }

  private logSessionSummary(touchedFiles: Set<string>, sessionId: string | undefined): void {
    logTouchedFiles(touchedFiles);
    if (sessionId) console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] Provider session: ${sessionId}`));
  }

  private async finalizeCodexSession(
    params: GenerateAndVerifyParams, activityState: ActivityState,
    touchedFiles: Set<string>, sessionId: string | undefined, model: string,
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[]; verificationPassCount: number }> {
    this.logSessionSummary(touchedFiles, sessionId);
    const repoDir = params.options.repoDir ?? process.cwd();
    const { outcomes, verificationPassCount } = await this.runProgrammaticVerificationLoop({
      params, activityState, touchedFiles, sessionId, model, repoDir,
    });
    printVerificationReport(outcomes);
    return { sessionId, verificationOutcomes: outcomes, verificationPassCount };
  }

  private logFixPassStart(passNumber: number, failureCount: number): void {
    console.log(chalk.yellow(
      `\n  [${CODEX_ADAPTER_LABEL}] Fix pass ${passNumber}: `
      + `${failureCount} enforced verification(s) failed — sending back for resolution`,
    ));
  }

  private async runCodexFixPass(p: {
    ctx: StreamContext; sessionId: string; model: string;
    codeFailures: VerificationOutcome[]; passNumber: number; repoFiles: string[];
  }): Promise<{ sessionId: string | undefined; wrote: boolean }> {
    this.logFixPassStart(p.passNumber, p.codeFailures.length);
    const fixPrompt = buildVerificationFixPrompt(p.codeFailures, p.repoFiles);
    const fixArgs = buildCodexCliArgs(
      { prompt: fixPrompt, model: p.model, cwd: p.ctx.repoDir, permissionMode: 'full-auto', sessionId: p.sessionId,
        codexVersion: getCodexCliVersion() },
    );
    const fixCtx = { ...p.ctx, cliArgs: fixArgs, implementPrompt: fixPrompt };
    const { sessionId, wrote } = await processCodexStream(fixCtx, p.sessionId);
    if (sessionId) await discoverChangedFiles(p.ctx.repoDir, p.ctx.touchedFiles);
    return { sessionId, wrote };
  }

  private async evaluateVerificationPass(
    scripts: VerificationScript[], repoDir: string, passNumber: number,
  ): Promise<{ outcomes: VerificationOutcome[]; codeFailures: VerificationOutcome[] }> {
    console.log(chalk.bold(`\n  Running verification (pass ${passNumber})...`));
    const outcomes = await runProgrammaticVerification(scripts, repoDir);
    const { codeFailures, commandFailures } = partitionFailures(getEnforcedFailures(outcomes));
    for (const cf of commandFailures) {
      console.log(chalk.gray(`    [${CODEX_ADAPTER_LABEL}] Skipping unfixable command: ${cf.command}`));
    }
    return { outcomes, codeFailures };
  }

  private buildBaseStreamContext(
    params: GenerateAndVerifyParams, activityState: ActivityState, touchedFiles: Set<string>, repoDir: string,
  ): StreamContext {
    const { timeoutMs, inactivityTimeoutMs } = this.resolveImplementTimeouts();
    return {
      cliArgs: [], repoDir, implementPrompt: '', touchedFiles,
      activityState, verificationScripts: params.verificationScripts,
      timeoutMs, inactivityTimeoutMs,
    };
  }

  private async attemptCodexFix(
    ctx: StreamContext, p: CodexVerificationLoopParams,
    passNumber: number, sessionId: string, codeFailures: VerificationOutcome[],
  ): Promise<{ sessionId: string | undefined; wrote: boolean }> {
    const fix = await this.runCodexFixPass({
      ctx, sessionId, model: p.model, codeFailures, passNumber, repoFiles: p.params.repoFiles,
    });
    if (!fix.wrote) console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] No files written during fix pass — skipping re-verification`));
    return fix;
  }

  private async initVerificationFixState(p: CodexVerificationLoopParams): Promise<VerificationFixState> {
    const passNumber = (p.params.verificationPassOffset ?? 0) + 1;
    const { outcomes, codeFailures } = await this.evaluateVerificationPass(
      p.params.verificationScripts, p.repoDir, passNumber
    );
    return {
      outcomes, codeFailures, sessionId: p.sessionId,
      prevFails: Infinity, stalled: 0, readOnly: 0, passNumber, exhausted: false,
    };
  }

  private shouldRunFixIteration(state: VerificationFixState): boolean {
    return !state.exhausted
      && state.codeFailures.length > 0
      && state.sessionId !== undefined
      && state.readOnly < DEFAULT_STALL_THRESHOLD;
  }

  private async applySuccessfulFix(
    scripts: VerificationScript[], repoDir: string, state: VerificationFixState
  ): Promise<void> {
    state.readOnly = 0;
    const next = await this.evaluateVerificationPass(scripts, repoDir, ++state.passNumber);
    state.outcomes = next.outcomes;
    state.codeFailures = next.codeFailures;
    state.stalled = checkVerificationStall(
      state.codeFailures.length, state.prevFails, state.stalled, CODEX_ADAPTER_LABEL
    );
    if (state.stalled < 0) state.exhausted = true;
    state.prevFails = state.codeFailures.length;
  }

  private async runVerificationFixIteration(
    ctx: StreamContext, p: CodexVerificationLoopParams, state: VerificationFixState
  ): Promise<void> {
    state.readOnly++;
    const { sessionId } = state;
    if (!sessionId) return;
    const fix = await this.attemptCodexFix(ctx, p, state.passNumber, sessionId, state.codeFailures);
    state.sessionId = fix.sessionId;
    if (!state.sessionId || !fix.wrote) return;
    await this.applySuccessfulFix(p.params.verificationScripts, p.repoDir, state);
  }

  private async runProgrammaticVerificationLoop(
    p: CodexVerificationLoopParams,
  ): Promise<{ outcomes: VerificationOutcome[]; verificationPassCount: number }> {
    const ctx = this.buildBaseStreamContext(p.params, p.activityState, p.touchedFiles, p.repoDir);
    const state = await this.initVerificationFixState(p);
    while (this.shouldRunFixIteration(state)) {
      await this.runVerificationFixIteration(ctx, p, state);
    }
    const verificationPassCount = state.passNumber - (p.params.verificationPassOffset ?? 0);
    return { outcomes: state.outcomes, verificationPassCount };
  }
}
