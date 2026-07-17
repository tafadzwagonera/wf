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
import {
  printVerificationReport, getEnforcedFailures,
  buildVerificationFixPrompt, runProgrammaticVerification,
  checkVerificationStall, partitionFailures,
} from './verification-report';
import {
  resolveModelRouting,
  stripRepoPrefix,
  isGlobPattern,
  loadClaudeContext,
  discoverChangedFiles,
} from './shared-routing';
import { buildSystemPrompt, formatProgressMessage, formatActivityMessages } from './anthropic-agent.adapter';
import { assertClaudeCliAvailable, buildCliArgs, spawnCli, type ClaudeCliMessage } from './claude-cli-runner';

const DEFAULT_MECHANICAL_MODEL = 'claude-haiku-4-5-20251001';
const CLI_ADAPTER_LABEL = 'claude-cli';
const IMPLEMENT_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill'];
const IMPLEMENT_PROMPT
  = 'Implement the changes described in your instructions now. Use Read to inspect existing files, then Write or Edit to apply changes. After ALL edits are complete, run each command listed under "Verification commands:" exactly as written, in order, using Bash. Do not modify or pipe the commands. Do not output any text or plan before making your first tool call.';

type ActivityState = {
  lastVerificationCommand?: string;
  verificationOutcomes: VerificationOutcome[];
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
  ticketContext: string;
  repoFiles: string[];
  contextFiles?: string[];
  repoName: string;
  trackedFilePaths: string[];
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
};

type ContinuationLoopParams = {
  sessionId: string | undefined;
  repoFiles: string[];
  repoName: string;
  touchedFiles: Set<string>;
  appendSystemPrompt: string;
  model: string;
  repoDir: string;
  additionalRepoDirs: string[];
  activityState: ActivityState;
  verificationScripts: VerificationScript[];
};

type SinglePassParams = {
  passNumber: number;
  sessionId: string;
  currentUnvisited: string[];
  promptOverride?: string;
  appendSystemPrompt: string;
  model: string;
  repoDir: string;
  additionalRepoDirs: string[];
  touchedFiles: Set<string>;
  activityState: ActivityState;
};

type ToolBlockLogParams = {
  block: ToolBlock;
  repoDir: string;
  activityState: ActivityState;
  touchedFiles?: Set<string>;
};

/**
 * Builds the combined append-system-prompt string from prior stage context, Claude context, and the main system prompt.
 * @param priorStageSummary - Optional summary from a prior workflow stage.
 * @param claudeContext - Optional repo AI context loaded from disk.
 * @param systemPrompt - The main system prompt for the implementer.
 * @returns The joined append-system-prompt string.
 */
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

/**
 * Collects touched files from a CLI message's file list.
 * @param message - The CLI message to inspect.
 * @param repoDir - Absolute path to the repository directory.
 * @param touchedFiles - Set of relative file paths to update.
 */
const collectTouchedFiles = (message: ClaudeCliMessage, repoDir: string, touchedFiles: Set<string>): void => {
  if (!message.files) return;
  for (const { filename } of message.files) {
    const absolutePath = path.isAbsolute(filename) ? filename : path.resolve(repoDir, filename);
    touchedFiles.add(path.relative(repoDir, absolutePath));
  }
};

/**
 * Logs the summary lines from a CLI result message.
 * @param message - A result-type CLI message.
 */
const logCliResultSummary = (message: ClaudeCliMessage): void => {
  const summary = message.result?.trim();
  if (!summary) return;
  console.log(chalk.bold('\n  Summary:'));
  for (const line of summary.split('\n')) {
    if (line.trim()) console.log(chalk.cyan(`    ${line}`));
  }
};

/**
 * Logs the final result of the initial CLI run (summary, turns, cost, session).
 * @param message - A result-type CLI message.
 * @param sessionId - The resolved session ID to display.
 */
const logCliResult = (message: ClaudeCliMessage, sessionId: string | undefined): void => {
  if (message.is_error) throw new Error(`Claude CLI failed: ${message.result ?? 'unknown error'}`);
  logCliResultSummary(message);
  if (message.num_turns) {
    console.log(chalk.green(`  [${CLI_ADAPTER_LABEL}] Completed in ${message.num_turns} turn(s).`));
  }
  if (message.total_cost_usd && message.total_cost_usd > 0) {
    console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] Cost: $${message.total_cost_usd.toFixed(4)} USD`));
  }
  if (sessionId) {
    console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] Provider session: ${sessionId}`));
  }
};

/**
 * Processes a single CLI stream message: updates session ID, collects touched files, and handles result output.
 * @param message - The CLI message to process.
 * @param repoDir - Absolute path to the repository directory.
 * @param sessionId - Current session ID (may be updated).
 * @param touchedFiles - Set of relative file paths modified so far.
 * @returns Updated session ID after processing.
 */
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

/**
 * Builds the continuation prompt listing unvisited planned files.
 * @param currentUnvisited - List of planned file paths not yet touched.
 * @returns The continuation prompt string.
 */
const buildContinuationPrompt = (currentUnvisited: string[]): string => {
  const unvisitedLines = currentUnvisited.map(f => `- ${f}`).join('\n');
  return (
    `Continue implementing the remaining plan steps. The following planned files are still unmodified:\n\n${unvisitedLines}\n\n`
    + `For each file listed above, read the full file first with Read, then apply Edit to complete the required changes. `
    + `After addressing all listed files, use Grep to search for any remaining migration patterns and continue editing until zero matches remain. `
    + `Do not output any text or plan before making your first tool call.`
  );
};

/**
 * Logs the result of a single continuation pass.
 * @param passNumber - 1-based pass index.
 * @param message - The CLI result message for this pass.
 */
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

/**
 * Checks whether the continuation loop has stalled and logs a warning if so.
 * @param currentWorkload - Number of unvisited files in this pass.
 * @param previousWorkload - Number of unvisited files in the prior pass.
 * @param stalledPasses - Running count of non-decreasing passes.
 * @param currentUnvisited - List of unvisited file paths (for the warning message).
 * @returns Updated stalledPasses count, or -1 to signal the loop should break.
 */
const checkStallCondition = (
  currentWorkload: number,
  previousWorkload: number,
  stalledPasses: number,
  currentUnvisited: string[]
): number => {
  const updated = currentWorkload < previousWorkload ? 0 : stalledPasses + 1;
  if (updated < 2) return updated;
  console.log(chalk.yellow(`\n  [${CLI_ADAPTER_LABEL}] Workload not decreasing after 2 passes — stopping`));
  const remaining = `  [${CLI_ADAPTER_LABEL}] Remaining: ${currentUnvisited.length} planned file(s) not touched: ${currentUnvisited.join(', ')}`;
  console.log(chalk.yellow(remaining));
  return -1;
};

/**
 * Logs SDK-compatible progress or activity events for a CLI message.
 * @param message - The CLI message to evaluate.
 * @param repoDir - Absolute path to the repository directory.
 * @param activityState - Mutable state tracking the last verification command.
 * @returns True if the message was handled, false otherwise.
 */
const logSdkProgressEvent = (message: ClaudeCliMessage, repoDir: string, activityState: ActivityState): boolean => {
  const progressLine = formatProgressMessage(message as never);
  if (!progressLine) return false;
  const label = progressLine.replace(/\[claude-agent-sdk]/, `[${CLI_ADAPTER_LABEL}]`);
  const isWarning
    = (message.type === 'system' && message.subtype === 'api_retry')
      || (message.type === 'system' && message.subtype === 'status');
  console.log(isWarning ? chalk.yellow(label) : chalk.cyan(label));
  for (const line of formatActivityMessages(message as never, repoDir, activityState)) {
    console.log(chalk.cyan(line.replace(/\[claude-agent-sdk]/, `[${CLI_ADAPTER_LABEL}]`)));
  }
  return true;
};

/**
 * Logs a CLI progress event (Skill task_progress, SDK progress line, or SDK activity lines).
 * @param message - The CLI message to evaluate.
 * @param repoDir - Absolute path to the repository directory.
 * @param activityState - Mutable state tracking the last verification command.
 * @returns True if the message was handled as a progress event, false otherwise.
 */
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
    console.log(chalk.cyan(line.replace(/\[claude-agent-sdk]/, `[${CLI_ADAPTER_LABEL}]`)));
  }
  return activityLines.length > 0;
};

/**
 * Logs a Write or Edit tool invocation.
 * @param toolName - Either 'Write' or 'Edit'.
 * @param input - The tool input block.
 * @param repoDir - Absolute path to the repository directory.
 * @param touchedFiles - Set of relative file paths to update.
 */
const logWriteEditEvent = (
  toolName: string,
  input: Record<string, unknown>,
  repoDir: string,
  touchedFiles: Set<string> | undefined
): void => {
  const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '';
  if (!filePath) return;
  const relativePath = path.isAbsolute(filePath) ? path.relative(repoDir, filePath) : filePath;
  const action = toolName === 'Write' ? 'created' : 'updated';
  console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] File ${action}: ${relativePath}`));
  touchedFiles?.add(relativePath);
};

/**
 * Logs a Bash tool invocation and records it as the last verification command.
 * @param input - The tool input block.
 * @param activityState - Mutable state tracking the last verification command.
 */
const logBashEvent = (input: Record<string, unknown>, activityState: ActivityState): void => {
  const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
  if (!command) return;
  activityState.lastVerificationCommand = command;
  console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] Verification running: ${command}`));
};

/**
 * Resolves the target string for a Read, Glob, or Grep tool input.
 * @param input - The tool input block.
 * @returns The resolved target string, or empty string if not found.
 */
const resolveReadTarget = (input: Record<string, unknown>): string => {
  if (typeof input['file_path'] === 'string') return input['file_path'];
  if (typeof input['pattern'] === 'string') return input['pattern'];
  return '';
};

/**
 * Logs a Read, Glob, or Grep tool invocation.
 * @param toolName - One of 'Read', 'Glob', or 'Grep'.
 * @param input - The tool input block.
 */
const logReadEvent = (toolName: string, input: Record<string, unknown>): void => {
  const target = resolveReadTarget(input);
  if (!target) return;
  const short = target.length > 60 ? `${target.slice(0, 57)}...` : target;
  console.log(chalk.gray(`  [${CLI_ADAPTER_LABEL}] ${toolName}: ${short}`));
};

/**
 * Logs verification pass/fail for observability during the AI session.
 * Does NOT record outcomes — programmatic verification after the session is authoritative.
 *
 * @param block - The result block to evaluate.
 * @param activityState - Mutable state tracking the last verification command.
 */
const logToolResultVerification = (
  block: ResultBlock,
  activityState: ActivityState,
): void => {
  const content = typeof block.content === 'string' ? block.content : '';
  if (!content || !activityState.lastVerificationCommand) return;
  const command = activityState.lastVerificationCommand;
  const hasFailure = block.is_error
    || /(failed|failure|exit code [1-9]\d*|non-zero exit|error\b|errors\b)/i.test(content);
  const hasSuccess = /(passed|success|succeeded|completed successfully|exit code 0)/i.test(content);
  if (hasFailure) {
    console.log(chalk.red(`  [${CLI_ADAPTER_LABEL}] Verification failed: ${command}`));
    activityState.lastVerificationCommand = undefined;
    return;
  }
  if (hasSuccess) {
    console.log(chalk.green(`  [${CLI_ADAPTER_LABEL}] Verification passed: ${command}`));
    activityState.lastVerificationCommand = undefined;
  }
};

/**
 * Computes the list of planned files not yet touched in the current pass.
 * @param repoFiles - All planned file entries for the repo.
 * @param repoName - Repository name prefix to strip.
 * @param touchedFiles - Set of relative paths already modified.
 * @returns Filtered list of unvisited non-glob file paths.
 */
const computeUnvisitedFiles = (repoFiles: string[], repoName: string, touchedFiles: Set<string>): string[] =>
  repoFiles.map(f => stripRepoPrefix(f, repoName)).filter(f => !touchedFiles.has(f) && !isGlobPattern(f));

/**
 * Builds CLI args for the initial implement pass.
 * @param p - Session parameters including model, paths, and session state.
 * @returns CLI argument array for spawnCli.
 */
const buildImplementCliArgs = (p: CliSessionParams) =>
  buildCliArgs({
    prompt: IMPLEMENT_PROMPT,
    appendSystemPrompt: p.appendSystemPrompt,
    model: p.model,
    cwd: p.repoDir,
    tools: IMPLEMENT_TOOLS,
    permissionMode: 'acceptEdits',
    addDirs: p.additionalRepoDirs.length > 0 ? p.additionalRepoDirs : undefined,
    sessionId: p.options.resumeProviderSessionId,
  });

/**
 * Builds CLI args for a single continuation pass.
 * @param p - Pass parameters including session ID, model, and paths.
 * @param continuationPrompt
 * @returns CLI argument array for spawnCli.
 */
const buildPassCliArgs = (p: SinglePassParams, continuationPrompt: string) =>
  buildCliArgs({
    prompt: continuationPrompt,
    appendSystemPrompt: p.appendSystemPrompt,
    model: p.model,
    cwd: p.repoDir,
    sessionId: p.sessionId,
    tools: IMPLEMENT_TOOLS,
    permissionMode: 'acceptEdits',
    addDirs: p.additionalRepoDirs.length > 0 ? p.additionalRepoDirs : undefined,
  });

/**
 * Claude CLI headless mode (`claude -p`) implementer backend.
 * Spawns the Claude CLI as a subprocess with `--permission-mode acceptEdits`
 * and streams NDJSON progress messages.
 */
export class ClaudeCliAdapter implements ImplementerBackend {
  constructor(private readonly configService: ConfigService) {}

  async generateAndVerify(
    params: GenerateAndVerifyParams,
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }> {
    const { options, repoFiles, repoName, verificationScripts } = params;
    const repoDir = options.repoDir ?? process.cwd();
    assertClaudeCliAvailable();
    const modelRoutingResult = this.resolveCliModelRouting(options, params.planArtifact);
    console.log(chalk.cyan(`  ${modelRoutingResult.logMessage}`));
    const appendSystemPrompt = buildCliSystemPrompt(
      options.priorStageSummary, await loadClaudeContext(repoDir), this.buildCliImplementerPrompt(params)
    );
    return this.runCliSession({
      options, repoFiles, repoName, repoDir,
      appendSystemPrompt, model: modelRoutingResult.model,
      additionalRepoDirs: options.additionalRepoDirs ?? [],
      verificationScripts,
    });
  }

  private resolveCliModelRouting(options: ImplementerOptions, planArtifact: PlanArtifact) {
    return resolveModelRouting({
      routing: options.modelRouting ?? 'auto',
      fallbackDefaultModel: this.configService.get<string>('ai.model') || 'claude-sonnet-4-6',
      defaultMechanicalModel: DEFAULT_MECHANICAL_MODEL,
      configService: this.configService,
      plan: planArtifact.plan,
      adapterLabel: CLI_ADAPTER_LABEL,
    });
  }

  private buildCliImplementerPrompt(params: GenerateAndVerifyParams): string {
    const { ticket, planArtifact, options, verificationScripts, ticketContext } = params;
    const { repoFiles, contextFiles, repoName, trackedFilePaths } = params;
    return buildSystemPrompt({
      ticketKey: ticket.ticketKey,
      repoDir: options.repoDir ?? process.cwd(),
      repoName, repoFiles, contextFiles, trackedFilePaths,
      verificationScripts, ticketContext,
      planSteps: planArtifact.plan.steps,
      planSummary: planArtifact.plan.summary,
      planRisks: planArtifact.plan.risks,
      planAction: planArtifact.plan.action,
    });
  }

  private async runCliSession(
    p: CliSessionParams,
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }> {
    const cliArgs = buildImplementCliArgs(p);
    console.log(chalk.bold.cyan(`\n  [${CLI_ADAPTER_LABEL}] Running CLI agent in ${p.repoDir}...`));
    const touchedFiles = new Set<string>();
    const activityState: ActivityState = { verificationOutcomes: [] };
    let sessionId: string | undefined = p.options.resumeProviderSessionId;
    for await (const message of spawnCli(cliArgs, p.repoDir, IMPLEMENT_PROMPT)) {
      this.logCliMessage(message, p.repoDir, activityState, touchedFiles);
      sessionId = processCliStream(message, p.repoDir, sessionId, touchedFiles);
    }
    await discoverChangedFiles(p.repoDir, touchedFiles);
    return this.finalizeCliSession({ ...p, sessionId, touchedFiles, activityState });
  }

  private async finalizeCliSession(
    p: ContinuationLoopParams,
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }> {
    const sessionId = await this.runContinuationLoop(p);
    this.logFileSummary(p.touchedFiles);
    const verificationOutcomes = await this.runProgrammaticVerificationLoop(p, sessionId);
    printVerificationReport(verificationOutcomes);
    return { sessionId, verificationOutcomes };
  }

  private logFileSummary(touchedFiles: Set<string>): void {
    if (touchedFiles.size > 0) {
      console.log(chalk.bold('\n  File summary:'));
      for (const f of [...touchedFiles].sort((a, b) => a.localeCompare(b))) console.log(chalk.cyan(`    - updated: ${f}`));
    } else {
      console.log(chalk.gray('\n  File summary: no file changes were made.'));
    }
  }

  private async runProgrammaticVerificationLoop(
    p: ContinuationLoopParams, sessionId: string | undefined,
  ): Promise<VerificationOutcome[]> {
    let previousFailureCount = Infinity;
    let stalledPasses = 0;
    let passNumber = 0;
    while (true) {
      console.log(chalk.bold(`\n  Running verification (pass ${++passNumber})...`));
      const outcomes = runProgrammaticVerification(p.verificationScripts, p.repoDir);
      const failures = getEnforcedFailures(outcomes);
      if (failures.length === 0) return outcomes;
      if (!sessionId) return outcomes;
      const { codeFailures, commandFailures } = partitionFailures(failures);
      for (const cf of commandFailures) {
        console.log(chalk.gray(`    [${CLI_ADAPTER_LABEL}] Skipping unfixable command: ${cf.command}`));
      }
      if (codeFailures.length === 0) return outcomes;
      stalledPasses = checkVerificationStall(
        codeFailures.length, previousFailureCount, stalledPasses, CLI_ADAPTER_LABEL,
      );
      if (stalledPasses === -1) return outcomes;
      previousFailureCount = codeFailures.length;
      console.log(chalk.yellow(
        `\n  [${CLI_ADAPTER_LABEL}] Fix pass ${passNumber}: `
        + `${codeFailures.length} enforced verification(s) failed — sending back for resolution`,
      ));
      sessionId = await this.runSinglePass({
        passNumber: 100 + passNumber, sessionId,
        currentUnvisited: [],
        promptOverride: buildVerificationFixPrompt(codeFailures),
        appendSystemPrompt: p.appendSystemPrompt, model: p.model,
        repoDir: p.repoDir, additionalRepoDirs: p.additionalRepoDirs,
        touchedFiles: p.touchedFiles, activityState: p.activityState,
      });
      if (sessionId) await discoverChangedFiles(p.repoDir, p.touchedFiles);
    }
  }

  private async runContinuationLoop(p: ContinuationLoopParams): Promise<string | undefined> {
    let previousWorkload = Infinity;
    let stalledPasses = 0;
    let passNumber = 0;
    let sessionId = p.sessionId;
    while (sessionId) {
      const currentUnvisited = computeUnvisitedFiles(p.repoFiles, p.repoName, p.touchedFiles);
      if (currentUnvisited.length === 0) break;
      stalledPasses = checkStallCondition(currentUnvisited.length, previousWorkload, stalledPasses, currentUnvisited);
      if (stalledPasses === -1) break;
      previousWorkload = currentUnvisited.length;
      sessionId = await this.executePassAndDiscover(p, ++passNumber, sessionId, currentUnvisited);
    }
    return sessionId;
  }

  private async executePassAndDiscover(
    p: ContinuationLoopParams,
    passNumber: number,
    sessionId: string,
    currentUnvisited: string[]
  ): Promise<string | undefined> {
    const {
      appendSystemPrompt, model, repoDir, additionalRepoDirs, touchedFiles, activityState,
    } = p;
    console.log(chalk.yellow(`\n  [${CLI_ADAPTER_LABEL}] Pass ${passNumber}: ${currentUnvisited.length} planned file(s) not touched — continuing`));
    const nextSession = await this.runSinglePass({
      passNumber, sessionId, currentUnvisited,
      appendSystemPrompt, model, repoDir, additionalRepoDirs, touchedFiles, activityState,
    });
    await discoverChangedFiles(repoDir, touchedFiles);
    return nextSession;
  }

  private async runSinglePass(p: SinglePassParams): Promise<string | undefined> {
    const { passNumber, currentUnvisited, repoDir, touchedFiles, activityState } = p;
    const continuationPrompt = p.promptOverride ?? buildContinuationPrompt(currentUnvisited);
    const continueArgs = buildPassCliArgs(p, continuationPrompt);
    let sessionId: string | undefined = p.sessionId;
    for await (const message of spawnCli(continueArgs, repoDir, continuationPrompt)) {
      this.logCliMessage(message, repoDir, activityState, touchedFiles);
      sessionId = processCliStream(message, repoDir, sessionId, touchedFiles);
      logContinuationPassResult(passNumber, message);
    }
    return sessionId;
  }

  private logCliMessage(
    message: ClaudeCliMessage,
    repoDir: string,
    activityState: ActivityState,
    touchedFiles?: Set<string>,
  ): void {
    if (logCliProgressEvent(message, repoDir, activityState)) return;
    if (message.type === 'assistant') {
      this.logCliAssistantMessage(message, repoDir, activityState, touchedFiles);
      return;
    }
    if (message.type === 'user') this.logCliToolResult(message, activityState);
  }

  private logCliAssistantMessage(
    message: ClaudeCliMessage,
    repoDir: string,
    activityState: ActivityState,
    touchedFiles?: Set<string>
  ): void {
    const contentBlocks = (message.message as { content?: ToolBlock[] } | undefined)?.content;
    if (!Array.isArray(contentBlocks)) return;
    for (const block of contentBlocks) {
      this.logAssistantToolBlock({ block, repoDir, activityState, touchedFiles });
    }
  }

  private logAssistantToolBlock(p: ToolBlockLogParams): void {
    const { block, repoDir, activityState, touchedFiles } = p;
    if (block.type !== 'tool_use' || !block.name) return;
    const input = block.input ?? {};
    if (block.name === 'Write' || block.name === 'Edit') return logWriteEditEvent(block.name, input, repoDir, touchedFiles);
    if (block.name === 'Bash') return logBashEvent(input, activityState);
    if (block.name === 'Read' || block.name === 'Glob' || block.name === 'Grep') return logReadEvent(block.name, input);
    if (block.name === 'Skill') this.logSkillBlock(input);
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
