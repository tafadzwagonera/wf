// src/integrations/ai/adapters/anthropic-agent.adapter.ts
import { ConfigService } from '@nestjs/config';
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
import { resolveSkippedSteps, printVerificationReport } from './verification-report';
import {
  resolveModelRouting,
  normalizeCommand,
  buildAllowedCommands,
  stripRepoPrefix,
  isGlobPattern,
  loadClaudeContext,
  discoverChangedFiles,
  buildPlanContext,
} from './shared-routing';

const CLAUDE_CODE_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'Task', 'Agent'] as const;
const DEFAULT_MECHANICAL_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_AGENT_LABEL = 'claude-agent-sdk';
const FALLBACK_VERIFICATION_LABEL = 'verification command';

type ActivityState = {
  lastVerificationCommand?: string;
  verificationScripts?: VerificationScript[];
  verificationOutcomes?: VerificationOutcome[];
};

/**
 * Return whether `toolName` is not a Bash tool and can be allowed unconditionally.
 *
 * @param toolName - The name of the SDK tool being requested
 * @returns True when the tool is not `Bash`
 */
const isReadOnlyTool = (toolName: string): boolean => toolName !== 'Bash';

/**
 * Return whether `command` is present in the verification whitelist.
 *
 * @param command - Normalized shell command string
 * @param allowedCommands - Set of permitted command names
 * @returns True when the command is allowed
 */
const isAllowedCommand = (command: string, allowedCommands: Set<string>): boolean =>
  allowedCommands.has(command);

/**
 * Build a deny response for a Bash command not on the verification whitelist.
 *
 * @param command - The command that was denied
 * @param allowedCommands - Set of permitted verification command names
 * @returns A `deny` tool-use response with an explanatory message
 */
const denyUnallowedCommand = (command: string, allowedCommands: Set<string>) => {
  console.log(chalk.red(`  [${ANTHROPIC_AGENT_LABEL}] Verification denied: ${command}`));
  const allowed = [...allowedCommands].join(', ') || '(none configured)';
  return {
    behavior: 'deny' as const,
    message: `Bash command "${command}" is not in the verification whitelist. Allowed commands: ${allowed}.`,
    interrupt: true,
  };
};

/**
 * Build a `CanUseTool` callback that restricts Bash to the verification whitelist.
 *
 * @param allowedCommands - Set of permitted verification command names
 * @param activityState - Mutable state used to track the last run command
 * @returns An async `CanUseTool` callback for the SDK
 */
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

/**
 * Track files written by the SDK from a `files_persisted` system message.
 *
 * @param message - SDK streamed message to inspect
 * @param repoDir - Absolute path to the repository root
 * @param touchedFiles - Mutable set that accumulates repo-relative file paths
 */
const collectPersistedFiles = (message: SDKMessage, repoDir: string, touchedFiles: Set<string>): void => {
  if (message.type !== 'system' || message.subtype !== 'files_persisted') return;
  for (const { filename } of message.files) {
    const absolutePath = resolveRepoPath(repoDir, filename);
    touchedFiles.add(path.relative(repoDir, absolutePath));
  }
};

type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

/**
 * Format a `task_progress` system message.
 *
 * @param message - A `task_progress` system message
 * @param label - Backend label for the log prefix
 * @returns A formatted progress line
 */
const formatTaskProgress = (message: Extract<SystemMessage, { subtype: 'task_progress' }>, label: string): string => {
  const summary = message.summary?.trim() || message.description.trim();
  const lastToolLabel = message.last_tool_name ? ` · last tool: ${message.last_tool_name}` : '';
  return `  [${label}] Task progress: ${summary}${lastToolLabel}`;
};

/**
 * Format an `api_retry` system message.
 *
 * @param message - An `api_retry` system message
 * @param label - Backend label for the log prefix
 * @returns A formatted retry line
 */
const formatApiRetry = (message: Extract<SystemMessage, { subtype: 'api_retry' }>, label: string): string => {
  const errorLabel = message.error_status ? `HTTP ${message.error_status}` : 'connection error';
  return `  [${label}] API retry: attempt ${message.attempt}/${message.max_retries} after ${errorLabel} (${message.retry_delay_ms}ms backoff)`;
};

/**
 * Format a `system`-type SDK message into a human-readable log line.
 *
 * @param message - An SDK message whose `type` is `'system'`
 * @param label - Backend label for the log prefix
 * @returns A formatted log line, or null when the subtype is unrecognised
 */
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

/**
 * Format a streamed progress event for console output.
 *
 * @param message - The SDK progress message to format
 * @param label - Backend label for the log prefix (defaults to `'claude-agent-sdk'`)
 * @returns A human-readable log line, or null when the message is not progress
 */
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

/**
 * Build file-updated log lines from a `files_persisted` system message.
 *
 * @param message - A `files_persisted` system message
 * @param repoDir - Repository root used for relative path rendering
 * @returns One log line per persisted file
 */
const formatFilesPersistedMessages = (
  message: Extract<SystemMessage, { subtype: 'files_persisted' }>,
  repoDir: string
): string[] =>
  message.files.map(({ filename }) => {
    const relativePath = path.relative(repoDir, resolveRepoPath(repoDir, filename));
    return `  [${ANTHROPIC_AGENT_LABEL}] File updated: ${relativePath}`;
  });

/**
 * Build a verification-outcome log line from a `tool_use_summary` message.
 *
 * @param message - A `tool_use_summary` SDK message
 * @param activityState - Mutable activity state; `lastVerificationCommand` is updated on match
 * @returns A one-element array with the log line, or an empty array when outcome is unknown
 */
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

/**
 * Derive stable file and verification activity logs from streamed SDK messages.
 *
 * @param message - The SDK message to inspect
 * @param repoDir - The primary repository root for relative path rendering
 * @param activityState - Mutable activity state shared across the stream
 * @returns Explicit terminal log lines for file or verification activity
 */
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

/**
 * Return whether a message should be styled as a warning in the console.
 *
 * @param message - The SDK message to classify
 * @returns True when the message represents an API retry or status event
 */
const isWarningMessage = (message: SDKMessage): boolean =>
  message.type === 'system' && (message.subtype === 'api_retry' || message.subtype === 'status');

/**
 * Print a streamed progress event when the SDK emits one.
 *
 * @param message - The SDK message to inspect
 * @returns True when the message was handled as progress
 */
const logProgressMessage = (message: SDKMessage): boolean => {
  const formattedMessage = formatProgressMessage(message);
  if (!formattedMessage) return false;
  const colorize = isWarningMessage(message) ? chalk.yellow : chalk.cyan;
  console.log(colorize(formattedMessage));
  return true;
};

const IMPLEMENTER_RULES_SECTION = `Available tools:
- Read(file_path, offset?, limit?): read a file with optional line range
- Write(file_path, content): write a full file into the primary repository only
- Edit(file_path, old_string, new_string): surgically replace a unique string in a file
- Glob(pattern, path?): find files by glob pattern
- Grep(pattern, path?, glob?): search file contents by regex
- Bash(command): run a verification command only if it is on the whitelist
- Skill(skill, args?): invoke a specialized skill (e.g. plan-quality, executing-plans) when one applies to the current task

Rules:
- NEVER output free-form text, commentary, or planning at any point during the run. Every response you produce MUST contain at least one tool call. The ONLY exception is the final summary (using the exact template below) which you output after ALL work is done and ALL verification passes. If you feel the urge to describe what you will do next, call a tool instead. Text output without a tool call terminates the run immediately.
- ALWAYS use Edit instead of Write for existing files. Write should only be used for creating new files. Using Write on existing files wastes context on unchanged lines.
- Use Grep to find relevant line numbers, then Read with offset/limit to read only the section you need. Avoid reading entire large files.
- For mechanical migrations (e.g. replacing Logger with PinoLogger across many files): use Grep to find all call sites, then apply Edit to each file without re-reading the full file — the search results show enough context.
- Use Glob to discover file paths instead of guessing.
- Bash is the only way to execute a shell command, and it will reject any command outside the verification whitelist.
- Never invent or call any other shell command tool.
- Never duplicate a function. To add a parameter, modify the existing function signature. To change behavior, edit the existing function body. This applies to constructors, methods, and standalone functions alike.
- You MUST implement ALL plan steps listed above. Do not stop after completing only the core infrastructure — continue through every step until all tasks are done.
- Treat the returned progress signal as a heuristic only — never use a 'complete' verdict as a reason to stop. The verdict reflects a single verification command, not overall plan completion.
- Use verification commands as intermediate checkpoints to catch regressions. After each passing verification, check whether ALL plan steps are done. If any migration or refactoring work remains, continue working.
- After verification passes, run Grep to count remaining instances of the patterns you are migrating (e.g. 'new Logger('). If the search returns ANY matches, you MUST continue editing those files — do NOT output a summary or any text. Producing a summary that says "remaining work needed" or "follow-up required" is a failure. Keep calling Edit until the search returns zero matches.
- Only stop when the migration search confirms zero remaining instances AND all verification commands pass (exit 0) — or when you determine no file changes are required. Then output ONLY the following summary, filled in with actual results. Do not add preamble or planning text.` as const;

const IMPLEMENTER_SUMMARY_TEMPLATE = `### What I changed
<Bullet list of actual edits made. If nothing was changed, write: "No file content changes were required.">

### Verification run
<Bullet list of commands run with ✅ (pass) or ❌ (fail). Omit if no commands ran.>

### Files
- **Updated:** <comma-separated list or "none">
- **New:** <comma-separated list or "none">
- **Deleted:** <comma-separated list or "none">

### Assumptions / risk note
<Any assumptions made or risks identified. Write "None." if there are none.>` as const;

type SystemPromptParams = {
  ticketKey: string;
  repoDir: string;
  repoName: string;
  repoFiles: string[];
  contextFiles?: string[];
  trackedFilePaths: string[];
  verificationScripts: VerificationScript[];
  ticketContext: string;
  planSteps: string[];
  planSummary?: string;
  planRisks?: string[];
  planAction?: 'fix' | 'feature' | 'investigate';
};

/**
 * Format the risks section of the system prompt.
 *
 * @param planRisks - Optional list of risk strings from the plan artifact
 * @returns A numbered list of risks, or a placeholder when none are present
 */
const formatRisksSection = (planRisks?: string[]): string =>
  planRisks && planRisks.length > 0
    ? planRisks.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
    : '  (none identified)';

/**
 * Assemble the full system prompt body from plan context and implementer rules.
 *
 * @param planContext - Pre-built plan context string from `buildPlanContext`
 * @param repoDir - Repository root used in scoping rules
 * @param planRisks - Optional risk list to render
 * @param ticketContext - Raw ticket context string appended at the end
 * @returns The full joined system prompt string
 */
const assembleSystemPrompt = (
  planContext: string,
  repoDir: string,
  planRisks: string[] | undefined,
  ticketContext: string
): string =>
  [
    planContext,
    `\nWrites must stay scoped to the primary repository (${repoDir}).`,
    `Reads may target ${repoDir} and any configured read-only sibling repositories.\n`,
    IMPLEMENTER_RULES_SECTION,
    IMPLEMENTER_SUMMARY_TEMPLATE,
    `Risks and guardrails:\n${formatRisksSection(planRisks)}`,
    `Ticket context:\n${ticketContext}`,
  ].join('\n\n');

export const buildSystemPrompt = (p: SystemPromptParams): string => {
  const planContext = buildPlanContext({
    ticketKey: p.ticketKey, repoDir: p.repoDir, repoName: p.repoName, repoFiles: p.repoFiles,
    contextFiles: p.contextFiles, trackedFilePaths: p.trackedFilePaths,
    verificationScripts: p.verificationScripts, planSteps: p.planSteps,
    planSummary: p.planSummary, planRisks: p.planRisks, planAction: p.planAction,
  });
  return assembleSystemPrompt(planContext, p.repoDir, p.planRisks, p.ticketContext);
};

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

/**
 * Build the `systemPrompt.append` string combining prior-stage context, repo AI context,
 * and the implementer prompt.
 *
 * @param priorStageSummary - Optional summary from a preceding workflow stage
 * @param claudeContext - Optional repo-level AI context loaded from CLAUDE.md
 * @param systemPromptBody - The implementer system prompt body
 * @returns A single concatenated append string
 */
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

/**
 * Build the sandbox configuration for the SDK session.
 *
 * @param repoDir - Primary repository root (read and write access)
 * @param additionalRepoDirs - Additional directories granted read access
 * @returns A sandbox config object
 */
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

/**
 * Build the full options object passed to each SDK `query` call.
 *
 * @param params - All configuration values required to construct SDK options
 * @returns A fully populated options object ready for the SDK `query` function
 */
/**
 * Build the Claude Code SDK settings object for a session.
 *
 * @param repoDir - Repository root used to exclude CLAUDE.md files from context loading
 * @returns A `Settings` object for the SDK
 */
const buildClaudeCodeSettings = (repoDir: string): Settings => ({
  claudeMdExcludes: [path.join(repoDir, 'CLAUDE.md'), path.join(repoDir, '.claude', 'CLAUDE.md')],
  autoCompactWindow: 20000,
});

/**
 * Build the preset system prompt object for the SDK session.
 *
 * @param priorStageSummary - Optional prior stage context
 * @param claudeContext - Optional repo-level AI context
 * @param systemPromptBody - The implementer system prompt body
 * @returns A `{ type, preset, append }` system prompt descriptor
 */
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

/**
 * Records a verification outcome into activityState.verificationOutcomes when the message is a tool_use_summary.
 * Uses activityState.lastVerificationCommand (set by formatToolUseSummaryMessage) for the command name.
 *
 * @param message - The SDK message to inspect
 * @param activityState - Mutable activity state containing verification tracking data
 */
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

/**
 * Process a single SDK message, logging progress and persisted files.
 *
 * @param message - The SDK message to handle
 * @param repoDir - Repository root for path resolution
 * @param touchedFiles - Mutable set of touched files
 * @param activityState - Mutable activity state
 * @returns The result message if it is a terminal `result`, otherwise undefined
 */
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

/**
 * Drain an SDK message stream until a terminal result is found.
 *
 * @param session - Async iterable of SDK messages
 * @param repoDir - Repository root for path resolution
 * @param touchedFiles - Mutable set of touched files
 * @param activityState - Mutable activity state
 * @returns The first terminal result message, or undefined if the stream ended
 */
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

/**
 * Log token usage and cost from an SDK result.
 *
 * @param result - The successful `SDKResultMessage` from the SDK
 */
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

/**
 * Log the agent's final text summary and the list of files touched.
 *
 * @param result - The successful `SDKResultMessage` from the SDK
 * @param touchedFiles - Set of repo-relative paths that were written during the session
 */
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

/**
 * Log completion details (turns, usage, cost, summary, file list) for a successful SDK result.
 *
 * @param result - The successful `SDKResultMessage` from the SDK
 * @param touchedFiles - Set of repo-relative paths that were written during the session
 */
const logSdkCompletion = (result: SDKResultMessage, touchedFiles: Set<string>): void => {
  console.log(chalk.green(`  [claude-agent-sdk] Agent completed in ${result.num_turns} turn(s).`));
  logSdkUsage(result);
  logSdkSummaryAndFiles(result, touchedFiles);
};

/**
 * Validate and log the result of a continuation pass, throwing on failure.
 *
 * @param iterationResult - The SDK result message from the continuation session
 * @param passNumber - The 0-based pass index (displayed as `passNumber + 1`)
 * @returns The session ID of the completed pass
 */
/**
 * Throw a descriptive error when an SDK pass result is not a success.
 *
 * @param result - The SDK result to validate
 * @param passLabel - Human-readable pass label used in the error message
 */
const assertPassSuccess = (result: SDKResultMessage, passLabel: string): void => {
  if (result.subtype !== 'success') {
    const errorSummary = 'errors' in result && result.errors.length > 0 ? result.errors.join('; ') : 'unknown error';
    throw new Error(`Claude Agent SDK ${passLabel} failed (${result.subtype}): ${errorSummary}`);
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

/**
 * Run one continuation pass, returning the updated sessionId.
 *
 * @param query - The SDK query function
 * @param sdkOptions - Base SDK options for continuation calls
 * @param sessionId - Current session ID to resume from
 * @param currentUnvisited - List of unvisited planned files for the prompt
 * @param touchedFiles - Mutable set of touched files
 * @param activityState - Mutable activity state
 * @param passNumber - 0-based pass index
 * @returns The new session ID after the pass completes
 */
/**
 * Build the continuation prompt listing files not yet touched.
 *
 * @param currentUnvisited - Repo-relative paths that are still unmodified
 * @returns A full prompt string for the continuation session
 */
const buildContinuationPrompt = (currentUnvisited: string[]): string => {
  const unvisitedLines = currentUnvisited.map(f => `- ${f}`).join('\n');
  return `Continue implementing the remaining plan steps. The following planned files are still unmodified:\n\n${unvisitedLines}\n\nFor each file listed above, read the full file first with Read, then apply Edit to complete the required changes. After addressing all listed files, use Grep to search for any remaining migration patterns and continue editing until zero matches remain. Do not output any text or plan before making your first tool call.`;
};

type ContinuationPassParams = {
  query: SdkQueryFn;
  sdkOptions: Record<string, unknown>;
  sessionId: string;
  currentUnvisited: string[];
  touchedFiles: Set<string>;
  activityState: ActivityState;
  passNumber: number;
};

const runContinuationPass = async (p: ContinuationPassParams): Promise<string> => {
  const repoDir = p.sdkOptions['cwd'] as string;
  console.log(chalk.yellow(`\n  [${ANTHROPIC_AGENT_LABEL}] Pass ${p.passNumber}: ${p.currentUnvisited.length} planned file(s) not touched — continuing`));
  const session = p.query({
    prompt: buildContinuationPrompt(p.currentUnvisited),
    options: { ...p.sdkOptions, resume: p.sessionId },
  });
  const result = await runSdkSession(session, repoDir, p.touchedFiles, p.activityState);
  await discoverChangedFiles(repoDir, p.touchedFiles);
  if (!result) throw new Error(`Claude Agent SDK pass ${p.passNumber} finished without returning a result.`);
  return validateAndLogPassResult(result, p.passNumber - 1);
};

/**
 * Resume the SDK session in a loop until all planned files are touched or progress stalls.
 *
 * @param query - The SDK `query` function used to start continuation sessions
 * @param sdkOptions - Base SDK options (model and session settings) for continuation calls
 * @param repoFiles - Full list of files the plan expects to touch
 * @param repoName - Repository name used to strip path prefixes
 * @param touchedFiles - Mutable set of already-touched repo-relative file paths
 * @param activityState - Mutable activity state shared across the stream
 * @param initialSessionId - Session ID from the initial SDK run used to resume context
 * @returns The final session ID after the loop completes
 */
/**
 * Compute unvisited planned files excluding glob patterns.
 *
 * @param repoFiles - Full list of files from the plan
 * @param repoName - Repository name used for prefix stripping
 * @param touchedFiles - Set of already-touched repo-relative file paths
 * @returns List of repo-relative file paths not yet touched
 */
const computeUnvisited = (repoFiles: string[], repoName: string, touchedFiles: Set<string>): string[] =>
  repoFiles.map(f => stripRepoPrefix(f, repoName)).filter(f => !touchedFiles.has(f) && !isGlobPattern(f));

/**
 * Log the stall warning and the list of remaining untouched files.
 *
 * @param currentUnvisited - Files still not touched after stall detection
 */
const logStallWarning = (currentUnvisited: string[]): void => {
  console.log(chalk.yellow(`\n  [${ANTHROPIC_AGENT_LABEL}] Workload not decreasing after 2 passes — stopping`));
  const remaining = currentUnvisited.join(', ');
  console.log(chalk.yellow(`  [${ANTHROPIC_AGENT_LABEL}] Remaining: ${currentUnvisited.length} planned file(s) not touched: ${remaining}`));
};

type ContinuationLoopState = {
  previousWorkload: number;
  stalledPasses: number;
  passNumber: number;
  sessionId: string;
};

/**
 * Advance one iteration of the continuation loop state machine.
 * Returns false when the loop should stop (all done or stalled).
 *
 * @param state - Mutable loop counters (updated in-place)
 * @param currentUnvisited - Files not yet touched in this iteration
 * @returns True when the loop should continue, false to stop
 */
const advanceContinuationState = (state: ContinuationLoopState, currentUnvisited: string[]): boolean => {
  if (currentUnvisited.length === 0) return false;
  state.stalledPasses = currentUnvisited.length < state.previousWorkload ? 0 : state.stalledPasses + 1;
  state.previousWorkload = currentUnvisited.length;
  if (state.stalledPasses >= 2) {
    logStallWarning(currentUnvisited);
    return false;
  }
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
};

const runSdkContinuationLoop = async (p: ContinuationLoopParams): Promise<string> => {
  const state: ContinuationLoopState = {
    previousWorkload: Infinity, stalledPasses: 0, passNumber: 0, sessionId: p.initialSessionId,
  };
  while (true) {
    const currentUnvisited = computeUnvisited(p.repoFiles, p.repoName, p.touchedFiles);
    if (!advanceContinuationState(state, currentUnvisited)) break;
    state.sessionId = await runContinuationPass({
      query: p.query, sdkOptions: p.sdkOptions, sessionId: state.sessionId,
      currentUnvisited, touchedFiles: p.touchedFiles, activityState: p.activityState, passNumber: state.passNumber,
    });
  }
  return state.sessionId;
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

/**
 * Resolve model routing and build the SDK options object for a session.
 *
 * @param params - Generate-and-verify call params
 * @param configService - NestJS config service for model and key resolution
 * @param allowedCommands - Verification whitelist
 * @param activityState - Mutable activity state for the session
 * @param apiKey - Anthropic API key
 * @returns Resolved SDK options and query function
 */
/**
 * Resolve model routing and build the implementer system prompt body.
 *
 * @param params - Generate-and-verify call params
 * @param configService - NestJS config service for model resolution
 * @param repoDir - Primary repository root
 * @returns Resolved model name and system prompt body string
 */
/**
 * Build the `SystemPromptParams` object from generate-and-verify params.
 *
 * @param params - Generate-and-verify call params
 * @param repoDir - Resolved primary repository root
 * @returns A fully populated `SystemPromptParams` object
 */
const buildSystemPromptParams = (params: GenerateAndVerifyParams, repoDir: string): SystemPromptParams => ({
  ticketKey: params.ticket.ticketKey,
  repoDir, repoName: params.repoName, repoFiles: params.repoFiles,
  contextFiles: params.contextFiles, trackedFilePaths: params.trackedFilePaths,
  verificationScripts: params.verificationScripts, ticketContext: params.ticketContext,
  planSteps: params.planArtifact.plan.steps, planSummary: params.planArtifact.plan.summary,
  planRisks: params.planArtifact.plan.risks, planAction: params.planArtifact.plan.action,
});

const resolveModelAndPrompt = (
  params: GenerateAndVerifyParams,
  configService: ConfigService,
  repoDir: string
): { model: string; systemPromptBody: string } => {
  const fallbackDefaultModel = configService.get<string>('ai.model') || 'claude-sonnet-4-6';
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

/**
 * Run the initial SDK session and validate the result.
 *
 * @param query - The SDK query function
 * @param sdkOptions - Fully built SDK options
 * @param resumeSessionId - Optional prior session ID to resume from
 * @param repoDir - Repository root for file discovery
 * @param touchedFiles - Mutable set of touched files
 * @param activityState - Mutable activity state
 * @returns The validated final SDK result message
 */
const INITIAL_SESSION_PROMPT = 'Implement the changes described in your instructions now. Use Read to inspect existing files, then Write or Edit to apply changes, then Bash for each verification step. Do not output any text or plan before making your first tool call.' as const;

type InitialSessionParams = {
  query: SdkQueryFn;
  sdkOptions: Record<string, unknown>;
  resumeSessionId: string | undefined;
  repoDir: string;
  touchedFiles: Set<string>;
  activityState: ActivityState;
};

/**
 * Throw if the initial SDK result indicates an agent-level error.
 *
 * @param result - Validated success result from the initial session
 */
const assertNoAgentError = (result: SDKResultMessage): void => {
  if (!result.is_error) return;
  const errorSummary = 'errors' in result && result.errors.length > 0 ? result.errors.join('; ') : 'unknown error';
  throw new Error(`Claude Agent SDK failed: ${errorSummary}`);
};

const runInitialSdkSession = async (p: InitialSessionParams): Promise<SDKResultMessage> => {
  const resumeOption = p.resumeSessionId ? { resume: p.resumeSessionId } : {};
  console.log(chalk.bold.cyan(`\n  [claude-agent-sdk] Running agent loop in ${p.repoDir}...`));
  const session = p.query({ prompt: INITIAL_SESSION_PROMPT, options: { ...p.sdkOptions, ...resumeOption } });
  const finalResult = await runSdkSession(session, p.repoDir, p.touchedFiles, p.activityState);
  // Supplement files_persisted tracking with git-based discovery since
  // the SDK may not emit files_persisted for all writes in acceptEdits mode.
  await discoverChangedFiles(p.repoDir, p.touchedFiles);
  if (!finalResult) throw new Error('Claude Agent SDK finished without returning a result.');
  assertPassSuccess(finalResult, 'initial session');
  assertNoAgentError(finalResult);
  return finalResult;
};

/**
 * Execute the agent session: run the initial pass, log completion, then run the continuation loop.
 *
 * @param query - The SDK query function
 * @param sdkOptions - Fully built SDK options
 * @param params - Generate-and-verify params (for repoFiles, repoName, resumeSessionId)
 * @param repoDir - Resolved primary repo directory
 * @param touchedFiles - Mutable set of touched files
 * @param activityState - Mutable activity state
 * @returns The final session ID
 */
type AgentSessionParams = {
  query: SdkQueryFn;
  sdkOptions: Record<string, unknown>;
  params: GenerateAndVerifyParams;
  repoDir: string;
  touchedFiles: Set<string>;
  activityState: ActivityState;
};

const executeAgentSession = async (s: AgentSessionParams): Promise<string> => {
  const finalResult = await runInitialSdkSession({
    query: s.query, sdkOptions: s.sdkOptions, resumeSessionId: s.params.options.resumeProviderSessionId,
    repoDir: s.repoDir, touchedFiles: s.touchedFiles, activityState: s.activityState,
  });
  logSdkCompletion(finalResult, s.touchedFiles);
  return runSdkContinuationLoop({
    query: s.query, sdkOptions: s.sdkOptions, repoFiles: s.params.repoFiles, repoName: s.params.repoName,
    touchedFiles: s.touchedFiles, activityState: s.activityState, initialSessionId: finalResult.session_id,
  });
};

/**
 * Claude Agent SDK-backed implementer backend.
 * The SDK drives the edit loop directly with built-in Read / Write / Edit / Bash
 * tools while this adapter constrains the working directory, filesystem access,
 * and Bash verification commands.
 */
export class AnthropicAgentAdapter implements ImplementerBackend {
  constructor(private configService: ConfigService) {}

  private resolveApiKey(): string {
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    if (!apiKey) throw new Error('Anthropic Agent SDK backend requires `ai.anthropicApiKey` to be configured.');
    return apiKey;
  }

  async generateAndVerify(
    params: GenerateAndVerifyParams,
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }> {
    const allowedCommands = buildAllowedCommands(params.verificationScripts);
    const activityState: ActivityState = {
      verificationScripts: params.verificationScripts,
      verificationOutcomes: [],
    };
    const { repoDir, sdkOptions } = await resolveSessionOptions(
      { params, configService: this.configService, allowedCommands, activityState, apiKey: this.resolveApiKey() }
    );
    const { query } = await loadAnthropicAgentSdk();
    const touchedFiles = new Set<string>();
    const sessionId = await executeAgentSession({
      query: query as SdkQueryFn, sdkOptions: sdkOptions as Record<string, unknown>,
      params, repoDir, touchedFiles, activityState,
    });
    const verificationOutcomes = resolveSkippedSteps(
      params.verificationScripts, activityState.verificationOutcomes ?? []
    );
    printVerificationReport(verificationOutcomes);
    return { sessionId, verificationOutcomes };
  }
}
