import { ConfigService } from '@nestjs/config';
import { AiProviderError, ConfigurationError } from '../../../shared/utils/errors';
import {
  type CanUseTool,
  type SDKResultMessage,
  type Settings,
  type SettingSource,
  SDKMessage
} from '@anthropic-ai/claude-agent-sdk';
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
import { loadAnthropicAgentSdk } from './load-anthropic-agent-sdk';
import { resolveSkippedSteps, printVerificationReport, DEFAULT_STALL_THRESHOLD } from './verification-report';
import {
  resolveModelRouting,
  resolveProviderModel,
  normalizeCommand,
  buildAllowedCommands,
  stripRepoPrefix,
  isGlobPattern,
  loadClaudeContext,
  discoverChangedFiles,
  buildBehavioralContext,
  buildTaskBrief,
  buildInitialUserPrompt,
  buildImplementerRulesSection,
  type BuildTaskBriefParams,
} from './shared-routing';

const CLAUDE_CODE_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'Task', 'Agent'] as const;
const DEFAULT_MECHANICAL_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_AGENT_LABEL = 'claude-agent-sdk';
const MAX_CONTINUATION_PASSES = 15;
const MAX_CONSECUTIVE_IDLE_PASSES = 3;
const FALLBACK_VERIFICATION_LABEL = 'verification command';

type ActivityState = {
  lastVerificationCommand?: string;
  verificationScripts?: VerificationScript[];
  verificationOutcomes?: VerificationOutcome[];
};

const isReadOnlyTool = (toolName: string): boolean => toolName !== 'Bash';

const isAllowedCommand = (command: string, allowedCommands: Set<string>): boolean =>
  allowedCommands.has(command);

const denyUnallowedCommand = (command: string, allowedCommands: Set<string>) => {
  console.log(chalk.red(`  [${ANTHROPIC_AGENT_LABEL}] Verification denied: ${command}`));
  const allowed = [...allowedCommands].join(', ') || '(none configured)';
  return {
    behavior: 'deny' as const,
    message: `Bash command "${command}" is not in the verification whitelist. Allowed commands: ${allowed}.`,
    interrupt: true,
  };
};

const buildCanUseTool = (allowedCommands: Set<string>, activityState: ActivityState): CanUseTool =>
  async (toolName, input) => {
    if (isReadOnlyTool(toolName)) return { behavior: 'allow' };
    const command = normalizeCommand(input['command']);
    if (!command) return { behavior: 'deny', message: 'Bash command missing a command string.', interrupt: true };
    if (!isAllowedCommand(command, allowedCommands)) return denyUnallowedCommand(command, allowedCommands);
    activityState.lastVerificationCommand = command;
    console.log(chalk.cyan(`  [${ANTHROPIC_AGENT_LABEL}] Verification running: ${command}`));
    return { behavior: 'allow' };
  };

const resolveRepoPath = (repoDir: string, rawPath: string): string =>
  path.isAbsolute(rawPath) ? rawPath : path.resolve(repoDir, rawPath);

const collectPersistedFiles = (message: SDKMessage, repoDir: string, touchedFiles: Set<string>): void => {
  if (message.type !== 'system' || message.subtype !== 'files_persisted') return;
  for (const { filename } of message.files) {
    const absolutePath = resolveRepoPath(repoDir, filename);
    touchedFiles.add(path.relative(repoDir, absolutePath));
  }
};

type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

const formatTaskProgress = (message: Extract<SystemMessage, { subtype: 'task_progress' }>, label: string): string => {
  const summary = message.summary?.trim() || message.description.trim();
  const lastToolLabel = message.last_tool_name ? ` · last tool: ${message.last_tool_name}` : '';
  return `  [${label}] Task progress: ${summary}${lastToolLabel}`;
};

const formatApiRetry = (message: Extract<SystemMessage, { subtype: 'api_retry' }>, label: string): string => {
  const errorLabel = message.error_status ? `HTTP ${message.error_status}` : 'connection error';
  return `  [${label}] API retry: attempt ${message.attempt}/${message.max_retries} after ${errorLabel} (${message.retry_delay_ms}ms backoff)`;
};

const formatSystemEvent = (message: SystemMessage, label: string): string | null => {
  if (message.subtype === 'task_progress') return formatTaskProgress(message, label);
  if (message.subtype === 'api_retry') return formatApiRetry(message, label);
  if (message.subtype === 'status') return message.status ? `  [${label}] Status: ${message.status}` : null;
  if (message.subtype === 'compact_boundary') {
    const meta = message.compact_metadata;
    return `  [${label}] Context compacted (${meta.trigger}, ${meta.pre_tokens} tokens before)`;
  }
  if (message.subtype === 'session_state_changed') return `  [${label}] Session state: ${message.state}`;
  return null;
};

export const formatProgressMessage = (message: SDKMessage, label: string = ANTHROPIC_AGENT_LABEL): string | null => {
  if (message.type === 'system') return formatSystemEvent(message, label);

  if (message.type === 'tool_progress') {
    const elapsedSeconds = message.elapsed_time_seconds.toFixed(1);
    const taskLabel = message.task_id ? ` · task: ${message.task_id}` : '';
    return `  [${label}] Tool progress: ${message.tool_name} (${elapsedSeconds}s)${taskLabel}`;
  }

  if (message.type === 'rate_limit_event') {
    return `  [${label}] Rate limit: updated`;
  }

  return null;
};

const extractVerificationCommand = (summary: string, fallbackCommand?: string): string => {
  const backtickMatch = new RegExp(/`([^`]+)`/).exec(summary);
  if (backtickMatch?.[1]) {
    return backtickMatch[1].trim();
  }

  const quoteMatch = new RegExp(/["']([^"']+)["']/).exec(summary);
  if (quoteMatch?.[1]) {
    return quoteMatch[1].trim();
  }

  const ranMatch = new RegExp(/(?:ran|run|executed)\s+([a-z0-9:_./@=-]+(?:\s+[a-z0-9:_./@=-]+)*)/i).exec(summary);
  if (ranMatch?.[1]) {
    return ranMatch[1].trim().replace(/[.]+$/, '');
  }

  return fallbackCommand ?? FALLBACK_VERIFICATION_LABEL;
};

const extractVerificationOutcome = (summary: string): 'passed' | 'failed' | null => {
  if (/(failed|failure|exit code [1-9]\d*|non-zero exit|error\b|errors\b)/i.test(summary)) {
    return 'failed';
  }

  if (/(passed|success|succeeded|completed successfully|exit code 0)/i.test(summary)) {
    return 'passed';
  }

  return null;
};

const formatFilesPersistedMessages = (
  message: Extract<SystemMessage, { subtype: 'files_persisted' }>,
  repoDir: string
): string[] =>
  message.files.map(({ filename }) => {
    const relativePath = path.relative(repoDir, resolveRepoPath(repoDir, filename));
    return `  [${ANTHROPIC_AGENT_LABEL}] File updated: ${relativePath}`;
  });

const formatToolUseSummaryMessage = (
  message: Extract<SDKMessage, { type: 'tool_use_summary' }>,
  activityState: ActivityState
): string[] => {
  const outcome = extractVerificationOutcome(message.summary);
  if (!outcome) return [];
  const command = extractVerificationCommand(message.summary, activityState.lastVerificationCommand);
  activityState.lastVerificationCommand = command;
  return [`  [${ANTHROPIC_AGENT_LABEL}] Verification ${outcome}: ${command}`];
};

export const formatActivityMessages = (
  message: SDKMessage,
  repoDir: string,
  activityState: ActivityState
): string[] => {
  if (message.type === 'system' && message.subtype === 'files_persisted') {
    return formatFilesPersistedMessages(message, repoDir);
  }
  if (message.type === 'tool_use_summary') return formatToolUseSummaryMessage(message, activityState);
  return [];
};

const isWarningMessage = (message: SDKMessage): boolean =>
  message.type === 'system' && (message.subtype === 'api_retry' || message.subtype === 'status');

const logProgressMessage = (message: SDKMessage): boolean => {
  const formattedMessage = formatProgressMessage(message);
  if (!formattedMessage) return false;
  const colorize = isWarningMessage(message) ? chalk.yellow : chalk.cyan;
  console.log(colorize(formattedMessage));
  return true;
};

const anthropicToolsBlock = `Available tools:
- Read(file_path, offset?, limit?): read a file with optional line range
- Write(file_path, content): write a full file into the primary repository only
- Edit(file_path, old_string, new_string): surgically replace a unique string in a file
- Glob(pattern, path?): find files by glob pattern
- Grep(pattern, path?, glob?): search file contents by regex
- Bash(command): run a verification command only if it is on the whitelist
- Skill(skill, args?): invoke a specialized skill (e.g. plan-quality, executing-plans) when one applies to the current task`;

const implementerRulesSection = buildImplementerRulesSection({
  read: 'Read', write: 'Write', edit: 'Edit', search: 'Grep', glob: 'Glob', verify: 'Bash',
});

const implementerSummaryTemplate = `### What I changed
<Bullet list of actual edits made. If nothing was changed, write: "No file content changes were required.">

### Verification run
<Bullet list of commands run with ✔ (pass) or ✖ (fail). Omit if no commands ran.>

### Files
- **Updated:** <comma-separated list or "none">
- **New:** <comma-separated list or "none">
- **Deleted:** <comma-separated list or "none">

### Assumptions / risk note
<Any assumptions made or risks identified. Write "None." if there are none.>` as const;

const assembleSystemPrompt = (
  behavioralContext: string,
  repoDir: string,
  conventionsSection?: string,
): string =>
  [
    behavioralContext,
    conventionsSection ?? '',
    `\nWrites must stay scoped to the primary repository (${repoDir}).`,
    `Reads may target ${repoDir} and any configured read-only sibling repositories.\n`,
    `${anthropicToolsBlock}\n\n${implementerRulesSection}`,
    implementerSummaryTemplate,
  ].join('\n\n');

type SystemPromptParams = {
  repoDir: string;
  conventionsSection?: string;
};

export const buildSystemPrompt = (p: SystemPromptParams): string =>
  assembleSystemPrompt(buildBehavioralContext(p.repoDir), p.repoDir, p.conventionsSection);

type SdkOptionsParams = {
  repoDir: string;
  additionalRepoDirs: string[];
  model: string;
  apiKey: string;
  claudeContext: string | null;
  priorStageSummary?: string;
  systemPromptBody: string;
  allowedCommands: Set<string>;
  activityState: ActivityState;
};

const buildSystemPromptAppend = (
  priorStageSummary: string | undefined,
  claudeContext: string | null,
  systemPromptBody: string
): string => {
  const priorStagePreamble = priorStageSummary
    ? `<prior-stage-context>\n${priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.`
    : '';
  return [
    priorStagePreamble ? `\n\n${priorStagePreamble}` : '',
    claudeContext ? `\n\nRepo AI context:\n${claudeContext}` : '',
    `\n\n${systemPromptBody}`,
  ].join('');
};

const buildSandboxConfig = (repoDir: string, additionalRepoDirs: string[]) => ({
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: true,
  filesystem: {
    allowRead: [resolveRepoPath(repoDir, '.'), ...additionalRepoDirs.map(dir => resolveRepoPath(repoDir, dir))],
    allowWrite: [resolveRepoPath(repoDir, '.')],
  },
});

const buildClaudeCodeSettings = (repoDir: string): Settings => ({
  claudeMdExcludes: [path.join(repoDir, 'CLAUDE.md'), path.join(repoDir, '.claude', 'CLAUDE.md')],
  autoCompactWindow: 20000,
});

const buildSdkSystemPrompt = (
  priorStageSummary: string | undefined,
  claudeContext: string | null,
  systemPromptBody: string
) => ({
  type: 'preset' as const,
  preset: 'claude_code' as const,
  append: buildSystemPromptAppend(priorStageSummary, claudeContext, systemPromptBody),
});

const buildSdkOptions = (params: SdkOptionsParams) => {
  const { repoDir, additionalRepoDirs, model, apiKey, claudeContext, priorStageSummary, systemPromptBody } = params;
  const { allowedCommands, activityState } = params;
  return {
    cwd: repoDir, model,
    tools: [...CLAUDE_CODE_TOOLS], allowedTools: [...CLAUDE_CODE_TOOLS],
    permissionMode: 'acceptEdits' as const, agentProgressSummaries: true,
    settingSources: ['project'] as SettingSource[], settings: buildClaudeCodeSettings(repoDir),
    systemPrompt: buildSdkSystemPrompt(priorStageSummary, claudeContext, systemPromptBody),
    canUseTool: buildCanUseTool(allowedCommands, activityState),
    env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
    sandbox: buildSandboxConfig(repoDir, additionalRepoDirs),
  };
};

const trackVerificationOutcome = (message: SDKMessage, activityState: ActivityState): void => {
  if (message.type !== 'tool_use_summary') return;
  if (!activityState.verificationOutcomes) return;
  const summary = (message as { summary?: string }).summary ?? '';
  const status = extractVerificationOutcome(summary);
  if (!status) return;
  const command = activityState.lastVerificationCommand ?? 'unknown command';
  const script = activityState.verificationScripts?.find(
    s => command.includes(s.command) || s.command.includes(command),
  );
  if (!script) return;
  activityState.verificationOutcomes.push({
    id: script.id, command, policy: script.policy, status,
  });
};

const handleSdkMessage = (
  message: SDKMessage,
  repoDir: string,
  touchedFiles: Set<string>,
  activityState: ActivityState
): SDKResultMessage | undefined => {
  if (logProgressMessage(message)) return undefined;
  collectPersistedFiles(message, repoDir, touchedFiles);
  for (const m of formatActivityMessages(message, repoDir, activityState)) console.log(chalk.cyan(m));
  trackVerificationOutcome(message, activityState);
  return message.type === 'result' ? message : undefined;
};

const drainSdkMessages = async (
  session: AsyncIterable<SDKMessage>,
  repoDir: string,
  touchedFiles: Set<string>,
  activityState: ActivityState
): Promise<SDKResultMessage | undefined> => {
  for await (const message of session) {
    const result = handleSdkMessage(message, repoDir, touchedFiles, activityState);
    if (result) return result;
  }
  return undefined;
};

const runSdkSession = async (
  session: AsyncIterable<SDKMessage> & { close(): void },
  repoDir: string,
  touchedFiles: Set<string>,
  activityState: ActivityState
): Promise<SDKResultMessage | undefined> => {
  try {
    return await drainSdkMessages(session, repoDir, touchedFiles, activityState);
  } finally {
    session.close();
  }
};

const logSdkUsage = (result: SDKResultMessage): void => {
  const usage = result.usage;
  if (usage) {
    const cachedLabel = usage.cache_read_input_tokens == null ? '' : ` (${usage.cache_read_input_tokens} cached)`;
    console.log(chalk.cyan(`  [${ANTHROPIC_AGENT_LABEL}] Usage: ${usage.input_tokens} input${cachedLabel} / ${usage.output_tokens} output tokens`));
  }
  if (result.total_cost_usd > 0) {
    console.log(chalk.cyan(`  [${ANTHROPIC_AGENT_LABEL}] Cost: $${result.total_cost_usd.toFixed(4)} USD`));
  }
};

const logSdkSummaryAndFiles = (result: SDKResultMessage, touchedFiles: Set<string>): void => {
  const summary = result.subtype === 'success' ? result.result.trim() : '';
  if (summary) {
    console.log(chalk.bold('\n  Summary:'));
    for (const line of summary.split('\n')) {
      if (line.trim()) console.log(chalk.cyan(`    ${line}`));
    }
  }
  if (touchedFiles.size > 0) {
    console.log(chalk.bold('\n  File summary:'));
    for (const f of [...touchedFiles].sort((a, b) => a.localeCompare(b))) console.log(chalk.cyan(`    - updated: ${f}`));
  } else {
    console.log(chalk.gray('\n  File summary: no file changes were made.'));
  }
};

const logSdkCompletion = (result: SDKResultMessage, touchedFiles: Set<string>): void => {
  console.log(chalk.green(`  [claude-agent-sdk] Agent completed in ${result.num_turns} turn(s).`));
  logSdkUsage(result);
  logSdkSummaryAndFiles(result, touchedFiles);
};

const assertPassSuccess = (result: SDKResultMessage, passLabel: string): void => {
  if (result.subtype !== 'success') {
    const errorSummary = 'errors' in result && result.errors.length > 0 ? result.errors.join('; ') : 'unknown error';
    throw new AiProviderError(`Claude Agent SDK ${passLabel} failed (${result.subtype}): ${errorSummary}`);
  }
};

const validateAndLogPassResult = (iterationResult: SDKResultMessage, passNumber: number): string => {
  const label = `pass ${passNumber + 1}`;
  assertPassSuccess(iterationResult, label);
  if (iterationResult.is_error) {
    console.log(chalk.yellow(`  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber + 1} completed with errors — continuing to next pass`));
  }
  console.log(chalk.green(`  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber + 1} completed in ${iterationResult.num_turns} turn(s).`));
  if (iterationResult.total_cost_usd > 0) {
    console.log(chalk.cyan(`  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber + 1} cost: $${iterationResult.total_cost_usd.toFixed(4)} USD`));
  }
  return iterationResult.session_id;
};

type SdkQueryFn = (
  opts: { prompt: string; options: Record<string, unknown> }
) => AsyncIterable<SDKMessage> & { close(): void };

type ContinuationPromptParams = {
  currentUnvisited: string[];
  totalPlanned: number;
  passNumber: number;
  taskBriefParams: BuildTaskBriefParams;
  conventionsSection?: string;
};

const buildContinuationPrompt = (p: ContinuationPromptParams): string => {
  const completed = p.totalPlanned - p.currentUnvisited.length;
  const unvisitedLines = p.currentUnvisited.map(f => `- ${f}`).join('\n');
  return [
    `Progress: ${completed}/${p.totalPlanned} files modified (pass ${p.passNumber})`,
    buildTaskBrief(p.taskBriefParams),
    p.conventionsSection ? `\n${p.conventionsSection}` : '',
    `\nContinue implementing the remaining plan steps. The following planned files are still unmodified (listed in recommended implementation order):\n\n${unvisitedLines}`,
    `\nFor each file listed above, read the full file first with Read, then apply Edit to complete the required changes. After addressing all listed files, run each verification command above exactly as written. Then use Grep to search for any remaining migration patterns and continue editing until zero matches remain. Begin by taking action: read the first listed file and apply its edit. Save narration for after you've made the changes.`,
  ].join('\n');
};

const logIdlePassDiagnostic = (result: SDKResultMessage, passNumber: number): void => {
  const text = result.subtype === 'success' ? result.result?.slice(0, 200) : '';
  console.log(chalk.yellow(`  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber} produced no tool calls (idle). AI response: ${text || '(none)'}`));
};

type ContinuationPassResult = { sessionId: string; numTurns: number };

type ContinuationPassParams = {
  query: SdkQueryFn;
  sdkOptions: Record<string, unknown>;
  sessionId: string;
  currentUnvisited: string[];
  touchedFiles: Set<string>;
  activityState: ActivityState;
  passNumber: number;
  totalPlanned: number;
  taskBriefParams: BuildTaskBriefParams;
  conventionsSection?: string;
};

const buildPassPromptParams = (p: ContinuationPassParams): ContinuationPromptParams => ({
  currentUnvisited: p.currentUnvisited, totalPlanned: p.totalPlanned, passNumber: p.passNumber,
  taskBriefParams: p.taskBriefParams, conventionsSection: p.conventionsSection,
});

const finalizeContinuationResult = (
  result: SDKResultMessage | undefined, passNumber: number
): ContinuationPassResult => {
  if (!result) throw new AiProviderError(`Claude Agent SDK pass ${passNumber} finished without returning a result.`);
  if (result.num_turns !== undefined && result.num_turns <= 1) logIdlePassDiagnostic(result, passNumber);
  return { sessionId: validateAndLogPassResult(result, passNumber - 1), numTurns: result.num_turns ?? 2 };
};

const runContinuationPass = async (p: ContinuationPassParams): Promise<ContinuationPassResult> => {
  const repoDir = p.sdkOptions['cwd'] as string;
  console.log(chalk.yellow(`\n  [${ANTHROPIC_AGENT_LABEL}] Pass ${p.passNumber}: ${p.currentUnvisited.length} planned file(s) not touched — continuing`));
  const session = p.query({
    prompt: buildContinuationPrompt(buildPassPromptParams(p)),
    options: { ...p.sdkOptions, resume: p.sessionId },
  });
  const result = await runSdkSession(session, repoDir, p.touchedFiles, p.activityState);
  await discoverChangedFiles(repoDir, p.touchedFiles);
  return finalizeContinuationResult(result, p.passNumber);
};

const computeUnvisited = (repoFiles: string[], repoName: string, touchedFiles: Set<string>): string[] =>
  repoFiles.map(f => stripRepoPrefix(f, repoName)).filter(f => !touchedFiles.has(f) && !isGlobPattern(f));

const computeStallThreshold = (concreteFileCount: number, configOverride?: number): number =>
  configOverride ?? Math.max(DEFAULT_STALL_THRESHOLD, Math.ceil(concreteFileCount / 5));

const logStallWarning = (currentUnvisited: string[], threshold: number): void => {
  console.log(chalk.yellow(`\n  [${ANTHROPIC_AGENT_LABEL}] Workload not decreasing after ${threshold} passes — stopping`));
  const remaining = currentUnvisited.join(', ');
  console.log(chalk.yellow(`  [${ANTHROPIC_AGENT_LABEL}] Remaining: ${currentUnvisited.length} planned file(s) not touched: ${remaining}`));
};

type ContinuationLoopState = {
  previousWorkload: number;
  stalledPasses: number;
  passNumber: number;
  sessionId: string;
  lastPassNumTurns?: number;
  consecutiveIdlePasses: number;
  stallThreshold: number;
};

const handleIdlePass = (state: ContinuationLoopState): boolean => {
  state.consecutiveIdlePasses++;
  if (state.consecutiveIdlePasses < MAX_CONSECUTIVE_IDLE_PASSES) return true;
  console.log(chalk.yellow(`\n  [${ANTHROPIC_AGENT_LABEL}] Stopping after ${MAX_CONSECUTIVE_IDLE_PASSES} consecutive idle passes`));
  return false;
};

const handleActivePass = (state: ContinuationLoopState, currentUnvisited: string[]): boolean => {
  state.consecutiveIdlePasses = 0;
  state.stalledPasses = currentUnvisited.length < state.previousWorkload ? 0 : state.stalledPasses + 1;
  state.previousWorkload = currentUnvisited.length;
  if (state.stalledPasses < state.stallThreshold) return true;
  logStallWarning(currentUnvisited, state.stallThreshold);
  return false;
};

const advanceContinuationState = (state: ContinuationLoopState, currentUnvisited: string[]): boolean => {
  if (currentUnvisited.length === 0) return false;
  const isIdle = state.lastPassNumTurns !== undefined && state.lastPassNumTurns <= 1;
  const shouldContinue = isIdle ? handleIdlePass(state) : handleActivePass(state, currentUnvisited);
  if (!shouldContinue) return false;
  state.passNumber++;
  return true;
};

type ContinuationLoopParams = {
  query: SdkQueryFn;
  sdkOptions: Record<string, unknown>;
  repoFiles: string[];
  repoName: string;
  touchedFiles: Set<string>;
  activityState: ActivityState;
  initialSessionId: string;
  taskBriefParams: BuildTaskBriefParams;
  conventionsSection?: string;
  stallThresholdOverride?: number;
};

const hasReachedHardCap = (passNumber: number): boolean => {
  if (passNumber < MAX_CONTINUATION_PASSES) return false;
  console.log(chalk.yellow(`\n  [${ANTHROPIC_AGENT_LABEL}] Reached hard cap of ${MAX_CONTINUATION_PASSES} continuation passes — stopping`));
  return true;
};

const initContinuationState = (p: ContinuationLoopParams, stallThreshold: number): ContinuationLoopState => ({
  previousWorkload: Infinity, stalledPasses: 0, passNumber: 0, sessionId: p.initialSessionId,
  consecutiveIdlePasses: 0, stallThreshold,
});

const applyContinuationPassResult = (state: ContinuationLoopState, result: ContinuationPassResult): void => {
  state.sessionId = result.sessionId;
  state.lastPassNumTurns = result.numTurns;
};

const buildContinuationPassParams = (
  p: ContinuationLoopParams, state: ContinuationLoopState, unvisited: string[], fileCount: number,
): ContinuationPassParams => ({
  query: p.query, sdkOptions: p.sdkOptions,
  sessionId: state.sessionId, currentUnvisited: unvisited,
  touchedFiles: p.touchedFiles, activityState: p.activityState,
  passNumber: state.passNumber, totalPlanned: fileCount,
  taskBriefParams: p.taskBriefParams, conventionsSection: p.conventionsSection,
});

const runSdkContinuationLoop = async (p: ContinuationLoopParams): Promise<string> => {
  const fileCount = p.repoFiles.filter(f => !isGlobPattern(f)).length;
  const stallThreshold = computeStallThreshold(fileCount, p.stallThresholdOverride);
  const state = initContinuationState(p, stallThreshold);
  while (!hasReachedHardCap(state.passNumber)) {
    const unvisited = computeUnvisited(p.repoFiles, p.repoName, p.touchedFiles);
    if (!advanceContinuationState(state, unvisited)) break;
    const passParams = buildContinuationPassParams(p, state, unvisited, fileCount);
    applyContinuationPassResult(state, await runContinuationPass(passParams));
  }
  return state.sessionId;
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
  figmaSkillHint?: string;
};

const buildSystemPromptParams = (params: GenerateAndVerifyParams, repoDir: string): SystemPromptParams => ({
  repoDir, conventionsSection: params.conventionsSection,
});

const resolveModelAndPrompt = (
  params: GenerateAndVerifyParams,
  configService: ConfigService,
  repoDir: string
): { model: string; systemPromptBody: string } => {
  const fallbackDefaultModel = resolveProviderModel(configService, 'anthropic', 'claude-sonnet-4-6');
  const modelRoutingResult = resolveModelRouting({
    routing: params.options.modelRouting ?? 'auto', fallbackDefaultModel,
    defaultMechanicalModel: DEFAULT_MECHANICAL_MODEL, configService,
    plan: params.planArtifact.plan, adapterLabel: ANTHROPIC_AGENT_LABEL,
  });
  console.log(chalk.cyan(`  ${modelRoutingResult.logMessage}`));
  const systemPromptBody = buildSystemPrompt(buildSystemPromptParams(params, repoDir));
  return { model: modelRoutingResult.model, systemPromptBody };
};

type SessionOptionsInput = {
  params: GenerateAndVerifyParams;
  configService: ConfigService;
  allowedCommands: Set<string>;
  activityState: ActivityState;
  apiKey: string;
};

const resolveSessionOptions = async (input: SessionOptionsInput) => {
  const { params, configService, allowedCommands, activityState, apiKey } = input;
  const repoDir = params.options.repoDir ?? process.cwd();
  const additionalRepoDirs = params.options.additionalRepoDirs ?? [];
  const claudeContext = await loadClaudeContext(repoDir);
  const { model, systemPromptBody } = resolveModelAndPrompt(params, configService, repoDir);
  return {
    repoDir,
    sdkOptions: buildSdkOptions({
      repoDir, additionalRepoDirs, model, apiKey, claudeContext,
      priorStageSummary: params.options.priorStageSummary, systemPromptBody, allowedCommands, activityState,
    }),
  };
};

type InitialSessionParams = {
  query: SdkQueryFn;
  sdkOptions: Record<string, unknown>;
  resumeSessionId: string | undefined;
  repoDir: string;
  touchedFiles: Set<string>;
  activityState: ActivityState;
  taskBriefParams: BuildTaskBriefParams;
  promptOverride?: string;
};

const assertNoAgentError = (result: SDKResultMessage): void => {
  if (!result.is_error) return;
  const errorSummary = 'errors' in result && result.errors.length > 0 ? result.errors.join('; ') : 'unknown error';
  throw new AiProviderError(`Claude Agent SDK failed: ${errorSummary}`);
};

const runInitialSdkSession = async (p: InitialSessionParams): Promise<SDKResultMessage> => {
  const resumeOption = p.resumeSessionId ? { resume: p.resumeSessionId } : {};
  console.log(chalk.bold.cyan(`\n  [claude-agent-sdk] Running agent loop in ${p.repoDir}...`));
  const sessionOptions = { ...p.sdkOptions, ...resumeOption };
  const prompt = p.promptOverride ?? buildInitialUserPrompt(p.taskBriefParams);
  const session = p.query({ prompt, options: sessionOptions });
  const finalResult = await runSdkSession(session, p.repoDir, p.touchedFiles, p.activityState);
  // Supplement files_persisted tracking with git-based discovery since
  // the SDK may not emit files_persisted for all writes in acceptEdits mode.
  await discoverChangedFiles(p.repoDir, p.touchedFiles);
  if (!finalResult) throw new AiProviderError('Claude Agent SDK finished without returning a result.');
  assertPassSuccess(finalResult, 'initial session');
  assertNoAgentError(finalResult);
  return finalResult;
};

type AgentSessionParams = {
  query: SdkQueryFn;
  sdkOptions: Record<string, unknown>;
  params: GenerateAndVerifyParams;
  repoDir: string;
  touchedFiles: Set<string>;
  activityState: ActivityState;
};

const buildAgentSessionTaskBriefParams = (s: AgentSessionParams): BuildTaskBriefParams => ({
  ticketKey: s.params.ticket.ticketKey, repoName: s.params.repoName,
  repoFiles: s.params.repoFiles, contextFiles: s.params.contextFiles,
  trackedFilePaths: s.params.trackedFilePaths, verificationScripts: s.params.verificationScripts,
  planSteps: s.params.planArtifact.plan.steps, planSummary: s.params.planArtifact.plan.summary,
  planRisks: s.params.planArtifact.plan.risks, planAction: s.params.planArtifact.plan.action,
  skillNames: s.params.skillNames, figmaSkillHint: s.params.figmaSkillHint,
  phases: s.params.planArtifact.plan.phases,
});

const buildSdkContinuationParams = (
  s: AgentSessionParams, finalResult: SDKResultMessage, taskBriefParams: BuildTaskBriefParams,
): ContinuationLoopParams => ({
  query: s.query, sdkOptions: s.sdkOptions, repoFiles: s.params.repoFiles, repoName: s.params.repoName,
  touchedFiles: s.touchedFiles, activityState: s.activityState, initialSessionId: finalResult.session_id,
  taskBriefParams, conventionsSection: s.params.conventionsSection,
});

const executeAgentSession = async (s: AgentSessionParams): Promise<string> => {
  const taskBriefParams = buildAgentSessionTaskBriefParams(s);
  const finalResult = await runInitialSdkSession({
    query: s.query, sdkOptions: s.sdkOptions, resumeSessionId: s.params.options.resumeProviderSessionId,
    repoDir: s.repoDir, touchedFiles: s.touchedFiles, activityState: s.activityState, taskBriefParams,
    promptOverride: s.params.options.initialPromptOverride,
  });
  logSdkCompletion(finalResult, s.touchedFiles);
  return runSdkContinuationLoop(buildSdkContinuationParams(s, finalResult, taskBriefParams));
};

/**
 * Claude Agent SDK-backed implementer backend.
 * The SDK drives the edit loop directly with built-in Read / Write / Edit / Bash
 * tools while this adapter constrains the working directory, filesystem access,
 * and Bash verification commands.
 */
export class AnthropicAgentAdapter implements ImplementerBackend {
  constructor(private readonly configService: ConfigService) {}

  private resolveApiKey(): string {
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    if (!apiKey) throw new ConfigurationError('Anthropic Agent SDK backend requires `ai.anthropicApiKey` to be configured.');
    return apiKey;
  }

  private buildActivityState(params: GenerateAndVerifyParams): ActivityState {
    return { verificationScripts: params.verificationScripts, verificationOutcomes: [] };
  }

  private async buildAndExecuteSession(
    params: GenerateAndVerifyParams,
  ): Promise<{ sessionId: string; activityState: ActivityState }> {
    const activityState = this.buildActivityState(params);
    const allowedCommands = buildAllowedCommands(params.verificationScripts);
    const { repoDir, sdkOptions } = await resolveSessionOptions(
      { params, configService: this.configService, allowedCommands, activityState, apiKey: this.resolveApiKey() }
    );
    const { query } = await loadAnthropicAgentSdk();
    const sessionId = await executeAgentSession({
      query: query as SdkQueryFn, sdkOptions: sdkOptions as Record<string, unknown>,
      params, repoDir, touchedFiles: new Set<string>(), activityState,
    });
    return { sessionId, activityState };
  }

  async generateAndVerify(
    params: GenerateAndVerifyParams,
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }> {
    const { sessionId, activityState } = await this.buildAndExecuteSession(params);
    const verificationOutcomes = resolveSkippedSteps(
      params.verificationScripts, activityState.verificationOutcomes ?? []
    );
    printVerificationReport(verificationOutcomes);
    return { sessionId, verificationOutcomes };
  }
}
