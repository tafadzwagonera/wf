import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import * as path from 'node:path';
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
import { assertCodexCliAvailable, buildCodexCliArgs, spawnCodex, type CodexCliMessage } from './codex-cli-runner';
import {
  printVerificationReport, getEnforcedFailures,
  buildVerificationFixPrompt, runProgrammaticVerification,
  checkVerificationStall, partitionFailures,
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
};

/**
 * Builds the prior-stage preamble string from the options.
 * @param options - Implementer options potentially containing a prior stage summary.
 * @returns The preamble string, or an empty string if none.
 */
const buildPriorStagePreamble = (options: ImplementerOptions): string =>
  options.priorStageSummary
    ? `<prior-stage-context>\n${options.priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.\n\n`
    : '';

/**
 * Calls buildSystemPrompt with fields extracted from GenerateAndVerifyParams.
 * @param params - Ticket, plan, repo, and context parameters.
 * @param repoDir - Absolute path to the repository root.
 * @returns The raw system prompt string.
 */
const buildCodexRawSystemPrompt = (params: GenerateAndVerifyParams, repoDir: string): string =>
  buildSystemPrompt({
    ticketKey: params.ticket.ticketKey,
    repoDir,
    repoName: params.repoName,
    repoFiles: params.repoFiles,
    contextFiles: params.contextFiles,
    trackedFilePaths: params.trackedFilePaths,
    verificationScripts: params.verificationScripts,
    planSteps: params.planArtifact.plan.steps,
    planSummary: params.planArtifact.plan.summary,
    planRisks: params.planArtifact.plan.risks, planAction: params.planArtifact.plan.action,
    conventionsSection: params.conventionsSection,
    skillNames: params.skillNames,
  });

/**
 * Assembles the full implement prompt for the Codex CLI agent.
 * @param params - Ticket, plan, repo, and context parameters.
 * @param repoDir - Absolute path to the repository root.
 * @returns The complete prompt string to pass to Codex CLI.
 */
const buildCodexImplementPrompt = (params: GenerateAndVerifyParams, repoDir: string): string => {
  const systemPrompt = buildCodexRawSystemPrompt(params, repoDir);
  const preamble = buildPriorStagePreamble(params.options);
  return `${preamble}${systemPrompt}\n\nImplement the changes described above now. Read existing files, apply changes. After ALL edits are complete, run each command listed under "Verification commands:" exactly as written, in order. Do not modify or pipe the commands.`;
};

/**
 * Logs a command_execution item.started event.
 * @param message - The Codex CLI message.
 * @returns True if the message was handled.
 */
const logCommandStarted = (message: CodexCliMessage): boolean => {
  if (message.type !== 'item.started') return false;
  if (message.item?.type !== 'command_execution' || !message.item.command) return false;
  const raw = message.item.command;
  const cmd = raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
  console.log(chalk.cyan(`  [${CODEX_ADAPTER_LABEL}] Running: ${cmd}`));
  return true;
};

/**
 * Logs a command_execution item.completed event.
 * @param message - The Codex CLI message.
 * @returns True if the message was handled.
 */
const logCommandCompleted = (message: CodexCliMessage): boolean => {
  if (message.type !== 'item.completed') return false;
  if (message.item?.type !== 'command_execution') return false;
  const raw = message.item.command ?? 'unknown';
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

/**
 * Logs a command_execution item.started or item.completed event.
 * @param message - The Codex CLI message.
 * @returns True if the message was handled (caller should continue).
 */
const logCodexCommandEvent = (message: CodexCliMessage): boolean =>
  logCommandStarted(message) || logCommandCompleted(message);

/**
 * Resolves the file path from a tool_use block input object.
 * @param input - The block input record.
 * @returns The file path string, or empty string if not found.
 */
const resolveBlockFilePath = (input: Record<string, unknown>): string => {
  if (typeof input['file_path'] === 'string') return input['file_path'];
  if (typeof input['path'] === 'string') return input['path'];
  return '';
};

/**
 * Processes a single assistant tool_use block and records any touched file.
 * @param block - The assistant content block.
 * @param repoDir - Absolute path to the repository root.
 * @param touchedFiles - Set to accumulate relative paths of touched files.
 */
const processAssistantBlock = (block: AssistantBlock, repoDir: string, touchedFiles: Set<string>): void => {
  if (block.type !== 'tool_use' || !block.name) return;
  if (!['write', 'edit', 'Write', 'Edit'].includes(block.name)) return;
  const filePath = resolveBlockFilePath(block.input ?? {});
  if (!filePath) return;
  const relativePath = path.isAbsolute(filePath) ? path.relative(repoDir, filePath) : filePath;
  touchedFiles.add(relativePath);
  console.log(chalk.cyan(`  [${CODEX_ADAPTER_LABEL}] File updated: ${relativePath}`));
};

/**
 * Tracks file mutations from assistant tool_use blocks mid-session.
 * @param message - The Codex CLI message to inspect.
 * @param repoDir - Absolute path to the repository root.
 * @param touchedFiles - Set to accumulate relative paths of touched files.
 */
const logCodexAssistantBlocks = (message: CodexCliMessage, repoDir: string, touchedFiles: Set<string>): void => {
  if (message.type !== 'assistant') return;
  const innerMessage = message.message as { content?: AssistantBlock[] } | undefined;
  const blocks = innerMessage?.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) processAssistantBlock(block, repoDir, touchedFiles);
};

/**
 * Logs the agent summary message lines if present.
 * @param message - The Codex CLI message to inspect.
 */
const logAgentSummary = (message: CodexCliMessage): void => {
  if (message.type !== 'item.completed' || message.item?.type !== 'agent_message') return;
  const summary = message.item.text?.trim();
  if (!summary) return;
  console.log(chalk.bold('\n  Summary:'));
  for (const line of summary.split('\n')) {
    if (line.trim()) console.log(chalk.cyan(`    ${line}`));
  }
};

/**
 * Handles file tracking from message.files list.
 * @param message - The Codex CLI message.
 * @param repoDir - Absolute path to the repository root.
 * @param touchedFiles - Set to accumulate relative paths of touched files.
 */
const trackMessageFiles = (message: CodexCliMessage, repoDir: string, touchedFiles: Set<string>): void => {
  if (!message.files) return;
  for (const { filename } of message.files) {
    const absolutePath = path.isAbsolute(filename) ? filename : path.resolve(repoDir, filename);
    touchedFiles.add(path.relative(repoDir, absolutePath));
  }
};

/**
 * Logs the agent_message item.completed text snippet.
 * @param message - The Codex CLI message to inspect.
 * @returns True if the message was handled (caller should continue).
 */
const logAgentMessageText = (message: CodexCliMessage): boolean => {
  if (message.type !== 'item.completed' || message.item?.type !== 'agent_message') return false;
  if (!message.item.text) return false;
  const raw = message.item.text;
  const text = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  console.log(chalk.cyan(`  [${CODEX_ADAPTER_LABEL}] Agent: ${text}`));
  return true;
};

/**
 * Tracks verification outcomes from command_execution items.
 * @param message - The Codex CLI message to inspect.
 * @param activityState - Mutable state tracking outcomes.
 * @param verificationScripts - Configured verification scripts.
 */
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
 * Processes a single message from the Codex CLI stream.
 * @param message - The Codex CLI message to process.
 * @param ctx - Stream context containing repoDir and touchedFiles.
 * @returns The session ID from the message, if present.
 */
const processCodexMessage = (message: CodexCliMessage, ctx: StreamContext): string | undefined => {
  if (message.type === 'system' && message.summary) {
    console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] ${message.summary}`));
  }
  if (message.tool_name) console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] Tool: ${message.tool_name}`));
  if (logCodexCommandEvent(message)) return undefined;
  if (logAgentMessageText(message)) return undefined;
  logCodexAssistantBlocks(message, ctx.repoDir, ctx.touchedFiles);
  trackMessageFiles(message, ctx.repoDir, ctx.touchedFiles);
  logAgentSummary(message);
  applyCodexVerificationOutcome(message, ctx.activityState, ctx.verificationScripts);
  return message.type === 'thread.started' ? message.thread_id : undefined;
};

/**
 * Processes the Codex CLI stream, logging messages and collecting session/file state.
 * @param ctx - Stream context with CLI args, repoDir, prompt, and touchedFiles.
 * @param initialSessionId - Session ID to resume from, if any.
 * @returns The resolved session ID after streaming completes.
 */
const processCodexStream = async (
  ctx: StreamContext,
  initialSessionId: string | undefined,
): Promise<string | undefined> => {
  let sessionId = initialSessionId;
  for await (const message of spawnCodex(ctx.cliArgs, ctx.repoDir, ctx.implementPrompt)) {
    sessionId = processCodexMessage(message, ctx) ?? sessionId;
  }
  return sessionId;
};

/**
 * Calls resolveModelRouting with Codex-specific defaults.
 * @param options - Implementer options.
 * @param planArtifact - The plan artifact.
 * @param configService - The NestJS config service.
 * @returns The routing result object.
 */
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

/**
 * Resolves the model string and logs the routing decision.
 * @param options - Implementer options.
 * @param planArtifact - The plan artifact.
 * @param configService - The NestJS config service.
 * @returns The resolved model string.
 */
const resolveCodexModel = (
  options: ImplementerOptions,
  planArtifact: PlanArtifact,
  configService: ConfigService,
): string => {
  const result = resolveCodexModelRouting(options, planArtifact, configService);
  console.log(chalk.cyan(`  ${result.logMessage}`));
  return result.model;
};

/**
 * Logs the touched files summary to stdout.
 * @param touchedFiles - Set of relative file paths that were modified.
 */
const logTouchedFiles = (touchedFiles: Set<string>): void => {
  if (touchedFiles.size === 0) return;
  console.log(chalk.bold(`\n  Files touched (${touchedFiles.size}):`));
  for (const f of touchedFiles) console.log(chalk.gray(`    ${f}`));
};

/**
 * Builds the CodexCliArgs and runs the stream, returning sessionId and touchedFiles.
 * @param params - GenerateAndVerify parameters.
 * @param repoDir - Absolute path to the repository root.
 * @param model - Resolved model identifier.
 * @returns The session ID and set of touched file paths.
 */
type RunCodexStreamResult = { sessionId: string | undefined; touchedFiles: Set<string> };

const buildStreamContext = (
  params: GenerateAndVerifyParams, repoDir: string, model: string, activityState: ActivityState,
): StreamContext => {
  const implementPrompt = buildCodexImplementPrompt(params, repoDir);
  const cliArgs = buildCodexCliArgs({
    prompt: implementPrompt, model, cwd: repoDir,
    permissionMode: 'full-auto', sessionId: params.options.resumeProviderSessionId,
  });
  return {
    cliArgs, repoDir, implementPrompt,
    touchedFiles: new Set<string>(), activityState, verificationScripts: params.verificationScripts,
  };
};

const runCodexStream = async (
  params: GenerateAndVerifyParams, repoDir: string, model: string, activityState: ActivityState,
): Promise<RunCodexStreamResult> => {
  const ctx = buildStreamContext(params, repoDir, model, activityState);
  const sessionId = await processCodexStream(ctx, params.options.resumeProviderSessionId);
  return { sessionId, touchedFiles: ctx.touchedFiles };
};

/**
 * Codex CLI headless mode implementer backend.
 * Spawns the Codex CLI as a subprocess and streams progress messages.
 */
export class CodexCliAdapter implements ImplementerBackend {
  constructor(private readonly configService: ConfigService) {}

  async generateAndVerify(
    params: GenerateAndVerifyParams,
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }> {
    const repoDir = params.options.repoDir ?? process.cwd();
    assertCodexCliAvailable();
    const model = resolveCodexModel(params.options, params.planArtifact, this.configService);
    console.log(chalk.bold.cyan(`\n  [${CODEX_ADAPTER_LABEL}] Running Codex CLI agent in ${repoDir}...`));
    const activityState: ActivityState = { verificationOutcomes: [] };
    const { sessionId, touchedFiles } = await runCodexStream(params, repoDir, model, activityState);
    await discoverChangedFiles(repoDir, touchedFiles);
    return this.finalizeCodexSession(params, activityState, touchedFiles, sessionId, model);
  }

  private logSessionSummary(touchedFiles: Set<string>, sessionId: string | undefined): void {
    logTouchedFiles(touchedFiles);
    if (sessionId) console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] Provider session: ${sessionId}`));
  }

  private async finalizeCodexSession(
    params: GenerateAndVerifyParams, activityState: ActivityState,
    touchedFiles: Set<string>, sessionId: string | undefined, model: string,
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }> {
    this.logSessionSummary(touchedFiles, sessionId);
    const repoDir = params.options.repoDir ?? process.cwd();
    const verificationOutcomes = await this.runProgrammaticVerificationLoop({
      params, activityState, touchedFiles, sessionId, model, repoDir,
    });
    printVerificationReport(verificationOutcomes);
    return { sessionId, verificationOutcomes };
  }

  private logFixPassStart(passNumber: number, failureCount: number): void {
    console.log(chalk.yellow(
      `\n  [${CODEX_ADAPTER_LABEL}] Fix pass ${passNumber}: `
      + `${failureCount} enforced verification(s) failed — sending back for resolution`,
    ));
  }

  private async runCodexFixPass(p: {
    ctx: StreamContext; sessionId: string; model: string;
    codeFailures: VerificationOutcome[]; passNumber: number;
  }): Promise<string | undefined> {
    this.logFixPassStart(p.passNumber, p.codeFailures.length);
    const fixPrompt = buildVerificationFixPrompt(p.codeFailures);
    const fixArgs = buildCodexCliArgs(
      { prompt: fixPrompt, model: p.model, cwd: p.ctx.repoDir, permissionMode: 'full-auto', sessionId: p.sessionId },
    );
    const next = await processCodexStream({ ...p.ctx, cliArgs: fixArgs, implementPrompt: fixPrompt }, p.sessionId);
    if (next) await discoverChangedFiles(p.ctx.repoDir, p.ctx.touchedFiles);
    return next;
  }

  private evaluateVerificationPass(
    scripts: VerificationScript[], repoDir: string,
  ): { outcomes: VerificationOutcome[]; codeFailures: VerificationOutcome[] } {
    const outcomes = runProgrammaticVerification(scripts, repoDir);
    const { codeFailures, commandFailures } = partitionFailures(getEnforcedFailures(outcomes));
    for (const cf of commandFailures) {
      console.log(chalk.gray(`    [${CODEX_ADAPTER_LABEL}] Skipping unfixable command: ${cf.command}`));
    }
    return { outcomes, codeFailures };
  }

  private buildBaseStreamContext(
    params: GenerateAndVerifyParams, activityState: ActivityState, touchedFiles: Set<string>, repoDir: string,
  ): StreamContext {
    return {
      cliArgs: [], repoDir, implementPrompt: '', touchedFiles,
      activityState, verificationScripts: params.verificationScripts,
    };
  }

  private async runProgrammaticVerificationLoop(p: CodexVerificationLoopParams): Promise<VerificationOutcome[]> {
    let prevFails = Infinity, stalled = 0, passNumber = 0, { sessionId } = p;
    const ctx = this.buildBaseStreamContext(p.params, p.activityState, p.touchedFiles, p.repoDir);
    while (true) {
      console.log(chalk.bold(`\n  Running verification (pass ${++passNumber})...`));
      const { outcomes, codeFailures } = this.evaluateVerificationPass(p.params.verificationScripts, p.repoDir);
      if (codeFailures.length === 0 || !sessionId) return outcomes;
      stalled = checkVerificationStall(codeFailures.length, prevFails, stalled, CODEX_ADAPTER_LABEL);
      if (stalled === -1) return outcomes;
      prevFails = codeFailures.length;
      sessionId = await this.runCodexFixPass({ ctx, sessionId, model: p.model, codeFailures, passNumber });
    }
  }
}
