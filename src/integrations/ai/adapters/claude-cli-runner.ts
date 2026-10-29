import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGitShimEnvOverrides } from '../../../common/utils/git-shim-path';
import { stripProviderAuthEnv } from '../../../common/utils/strip-provider-auth-env';
import { extractRuntimeAsset, isSeaRuntime } from '../../../common/utils/runtime-assets';
import { formatUiDesignScreenshotPathsPromptSection } from '../prompt-fragments';
import type { UiDesignScreenshot } from '../../../common/types/ui-design-screenshot';
import { AiProviderError, ConfigurationError, ExecutionError } from '../../../common/utils/errors';
import { signalProcessTree } from '../../../common/utils/signal-process-tree';
import { registerSigintHandler } from '../../../common/utils/sigint-registry';
import { type BoundedStderr, createBoundedStderr } from '../../../common/utils/bounded-stderr';
import {
  buildRunId,
  extractArgValue,
  logCliExit,
  logCliKill,
  logCliRunSummary,
  logCliSigkillEscalation,
  logCliSpawn,
  logCliSpawnError,
  type CliExitRecord,
  type CliKillReason,
  type CliRunIdentity,
} from './cli-run-logger';

export interface ClaudeCliMessage {
  type: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
  };
  tool_name?: string;
  last_tool_name?: string;
  files?: Array<{ filename: string }>;
  summary?: string;
  description?: string;
  // An errored result carries no `result` string — the SDK's SDKResultError puts the
  // detail in `errors` and names the cause in `terminal_reason` (e.g. 'max_turns',
  // 'stop_hook_prevented', 'aborted_tools'). Without these, every failure reads
  // as "unknown error".
  errors?: string[];
  terminal_reason?: string;
  rate_limit_info?: { status?: string; resetsAt?: number };
  structured_output?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Config keys named in timeout guidance when a run's limits come from non-default settings. */
export interface CliTimeoutConfigKeys {
  wallClock?: string;
  inactivity?: string;
}

export interface CliRunnerParams {
  prompt: string;
  appendSystemPrompt?: string;
  model: string;
  sessionId?: string;
  cwd: string;
  tools?: string[];
  permissionMode?: 'plan' | 'acceptEdits';
  addDirs?: string[];
  env?: Record<string, string>;
  jsonSchema?: string;
  forkSession?: boolean;
  screenshots?: UiDesignScreenshot[];
}

export const CLI_TIMEOUT_MS = 15 * 60 * 1000;
const SIGKILL_GRACE_MS = 5000;
export const CLI_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const REQUIRED_CLAUDE_CLI_MAJOR = 2;
const REQUIRED_CLAUDE_CLI_MIN_MINOR = 1;
const REQUIRED_CLAUDE_CLI_MIN_PATCH = 219;
const SKIP_VERSION_CHECK_ENV = 'WF_SKIP_CLI_VERSION_CHECK';
const CLAUDE_INSTALL_URL = 'https://docs.anthropic.com/en/docs/claude-code';
const UPGRADE_CMD = 'brew upgrade --cask claude-code';

interface ChildBundle {
  child: ReturnType<typeof spawn>;
  rl: ReturnType<typeof createInterface>;
  stderr: BoundedStderr;
  exitRecord: CliExitRecord;
}

/**
 * Mutable kill state threaded through the generator.
 * A single reason makes the impossible "both timers fired" state unrepresentable,
 * and records why the child died for SIGINT and normal cleanup too.
 */
interface TimeoutState {
  killReason?: CliKillReason;
}

interface KillContext {
  runId: string;
  state: TimeoutState;
  startedAtMs: number;
  timeoutMs: number;
  inactivityTimeoutMs: number;
}

interface SpawnChildParams {
  runId: string;
  args: string[];
  cwd: string;
  env: Record<string, string> | undefined;
  startedAtMs: number;
}

interface SpawnChildProcessParams extends SpawnChildParams {
  prompt: string | undefined;
}

interface ScheduleSigkillParams {
  child: ReturnType<typeof spawn>;
  exitRecord: CliExitRecord;
  runId: string;
  reason: CliKillReason;
}

interface TimeoutManager {
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  resetInactivity: () => void;
  clearInactivity: () => void;
}

export const parseClaudeCliVersion = (raw: string): { major: number; minor: number; patch: number } | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

const assertBinaryExists = (name: string, installUrl: string): void => {
  try {
    execSync(`command -v ${name}`, { stdio: 'pipe' });
  } catch {
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    throw new ConfigurationError(`${displayName} CLI is not installed. Install it by following: ${installUrl}`);
  }
};

const getVersionOrThrow = (name: string): string => {
  try {
    return execSync(`${name} --version`, { stdio: 'pipe', encoding: 'utf-8' });
  } catch {
    throw new ConfigurationError(`${name} CLI version check failed. Run \`${name} --version\` to diagnose.`);
  }
};

const assertMajorMatch = (vStr: string, reqStr: string, required: { major: number; minMinor: number }): void => {
  const bypass = `Or set ${SKIP_VERSION_CHECK_ENV}=1 to bypass.`;
  throw new ConfigurationError(
    `Incompatible Claude CLI version ${vStr}. Required: major=${required.major} (${reqStr}). `
    + `Upgrade: ${UPGRADE_CMD}. ${bypass}`
  );
};

const assertMinorSufficient = (vStr: string, reqStr: string): void => {
  const bypass = `Or set ${SKIP_VERSION_CHECK_ENV}=1 to bypass.`;
  throw new ConfigurationError(`Claude CLI version ${vStr} is too old. Required: ${reqStr}. Upgrade: ${UPGRADE_CMD}. ${bypass}`);
};

const assertPatchSufficient = (vStr: string, reqStr: string): void => {
  const bypass = `Or set ${SKIP_VERSION_CHECK_ENV}=1 to bypass.`;
  throw new ConfigurationError(`Claude CLI version ${vStr} is too old. Required: ${reqStr}. Upgrade: ${UPGRADE_CMD}. ${bypass}`);
};

const validateVersionRange = (
  version: { major: number; minor: number; patch: number },
  required: { major: number; minMinor: number; minPatch?: number },
): void => {
  const vStr = `${version.major}.${version.minor}.${version.patch}`;
  const reqStr = formatRequiredVersion(required);
  if (version.major !== required.major) assertMajorMatch(vStr, reqStr, required);
  if (version.minor < required.minMinor) assertMinorSufficient(vStr, reqStr);
  if (isPatchTooOld(version, required)) assertPatchSufficient(vStr, reqStr);
};

const formatRequiredVersion = (required: { major: number; minMinor: number; minPatch?: number }): string =>
  required.minPatch === undefined
    ? `>=${required.major}.${required.minMinor}`
    : `>=${required.major}.${required.minMinor}.${required.minPatch}`;

/**
 * Reports whether the patch level is below the minimum. Only meaningful on the
 * boundary minor version — higher minors satisfy the requirement regardless of patch.
 *
 * @param version - Parsed version object
 * @param required - Required major, minimum minor, and optional minimum patch
 * @returns True when the patch level is too old
 */
const isPatchTooOld = (
  version: { major: number; minor: number; patch: number },
  required: { major: number; minMinor: number; minPatch?: number }
): boolean =>
  required.minPatch !== undefined
  && version.minor === required.minMinor
  && version.patch < required.minPatch;

const readClaudeCliVersionOrThrow = (): { major: number; minor: number; patch: number } => {
  const raw = getVersionOrThrow('claude');
  const version = parseClaudeCliVersion(raw);
  if (!version) {
    throw new ConfigurationError(
      `Unrecognised Claude CLI version format: "${raw.trim()}". Set ${SKIP_VERSION_CHECK_ENV}=1 to bypass this check.`
    );
  }
  return version;
};

export const assertClaudeCliAvailable = (): void => {
  assertBinaryExists('claude', CLAUDE_INSTALL_URL);
  if (process.env[SKIP_VERSION_CHECK_ENV] === '1') return;

  const version = readClaudeCliVersionOrThrow();
  validateVersionRange(version, {
    major: REQUIRED_CLAUDE_CLI_MAJOR,
    minMinor: REQUIRED_CLAUDE_CLI_MIN_MINOR,
    minPatch: REQUIRED_CLAUDE_CLI_MIN_PATCH,
  });
};

const appendOptionalArg = (args: string[], flag: string, value: string | undefined): void => {
  if (value) args.push(flag, value);
};

const appendAddDirs = (args: string[], dirs: string[] | undefined): void => {
  if (!dirs) return;
  for (const dir of dirs) args.push('--add-dir', dir);
};

const appendScreenshotDirs = (args: string[], screenshots: UiDesignScreenshot[] | undefined): void => {
  if (!screenshots?.length) return;
  appendAddDirs(args, [...new Set(screenshots.map(s => path.dirname(s.path)))]);
};

const resolveNoMcpConfigPath = (): string =>
  isSeaRuntime()
    ? extractRuntimeAsset({
        assetKey: 'no-mcp.json',
        destPath: path.join(os.homedir(), '.wf', 'bin', 'no-mcp.json'),
        mode: 0o644,
      })
    : path.join(__dirname, '..', '..', '..', 'bootstrap', 'no-mcp.json');

export const buildCliArgs = (params: CliRunnerParams): string[] => {
  const args: string[] = ['-p', '--verbose', '--output-format', 'stream-json'];
  args.push('--model', params.model);
  appendOptionalArg(args, '--permission-mode', params.permissionMode);
  appendOptionalArg(args, '--append-system-prompt', params.appendSystemPrompt);
  appendOptionalArg(args, '--resume', params.sessionId);
  if (params.forkSession && params.sessionId) args.push('--fork-session');
  if (params.tools?.length) args.push('--allowedTools', params.tools.join(','));
  appendAddDirs(args, params.addDirs);
  appendOptionalArg(args, '--json-schema', params.jsonSchema);
  appendScreenshotDirs(args, params.screenshots);
  args.push('--mcp-config', resolveNoMcpConfigPath(), '--strict-mcp-config');
  return args;
};

export const buildClaudeStdinPrompt = (params: Pick<CliRunnerParams, 'prompt' | 'screenshots'>): string => {
  if (!params.screenshots?.length) return params.prompt;
  const section = formatUiDesignScreenshotPathsPromptSection(params.screenshots.map(s => s.path));
  return `${params.prompt}\n\n${section}`;
};

export const parseNdjsonLine = (line: string): ClaudeCliMessage | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeCliMessage;
  } catch {
    return null;
  }
};

/**
 * Returns true for system housekeeping messages that should not reset
 * the inactivity timer -- compaction, status updates, API retries,
 * and rate-limit events.
 *
 * @param message - Parsed NDJSON message from the Claude CLI
 * @returns True when the message is non-progress system chatter
 */
export const isSystemChatter = (message: ClaudeCliMessage): boolean =>
  message.type === 'rate_limit_event'
  || (message.type === 'system'
    && (message.subtype === 'status'
      || message.subtype === 'compact_boundary'
      || message.subtype === 'api_retry'));

async function* parseLineMessages(
  rl: ReturnType<typeof createInterface>
): AsyncGenerator<ClaudeCliMessage, void, undefined> {
  for await (const line of rl) {
    const message = parseNdjsonLine(line);
    if (message) yield message;
  }
}

/**
 * Spawns the `claude` child process with the given args and cwd.
 *
 * Attaches passive `exit` and `error` listeners that only record and log: they never
 * resolve, yield, or close the stream, so completion remains driven solely by stdout EOF.
 * The `error` listener also suppresses Node's unhandled-'error' throw, so
 * `assertCliProducedOutput` is what turns a spawn failure into an explicit error.
 *
 * @param params - Run id, argv, cwd, env overrides, and the run start timestamp
 * @returns The spawned child process and the record its listeners populate
 */
const spawnChild = (params: SpawnChildParams): { child: ReturnType<typeof spawn>; exitRecord: CliExitRecord } => {
  const exitRecord: CliExitRecord = { exited: false, code: null, signal: null };
  const mergedEnv = { ...process.env, ...params.env };
  const child = spawn('claude', params.args, {
    cwd: params.cwd,
    env: stripProviderAuthEnv({ ...mergedEnv, ...buildGitShimEnvOverrides(mergedEnv), WF_MANAGED_SESSION: '1' }),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  attachExitListeners(child, exitRecord, params);
  return { child, exitRecord };
};

const attachExitListeners = (
  child: ReturnType<typeof spawn>,
  exitRecord: CliExitRecord,
  params: SpawnChildParams
): void => {
  child.once('exit', (code, signal) => {
    Object.assign(exitRecord, { exited: true, code, signal });
    logCliExit({ runId: params.runId, exitRecord, elapsedMs: Date.now() - params.startedAtMs });
  });
  child.once('error', (error: Error) => {
    exitRecord.spawnError = error;
    logCliSpawnError({ runId: params.runId, error });
  });
};

const pipePrompt = (child: ReturnType<typeof spawn>, prompt: string | undefined): void => {
  if (!prompt || !child.stdin) return;
  child.stdin.write(prompt);
  child.stdin.end();
};

const spawnChildProcess = (params: SpawnChildProcessParams): ChildBundle => {
  const { child, exitRecord } = spawnChild(params);
  pipePrompt(child, params.prompt);
  if (!child.stdout) throw new ExecutionError('claude child process stdout not available');
  if (!child.stderr) throw new ExecutionError('claude child process stderr not available');
  const rl = createInterface({ input: child.stdout });
  const stderr = createBoundedStderr();
  child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));
  return { child, rl, stderr, exitRecord };
};

/**
 * Returns a kill function that records why the child died, then sends SIGTERM
 * followed by SIGKILL after a grace period.
 *
 * The first reason wins: the kill is idempotent, so whichever cause fires first
 * is the true cause. `cleanup` is the normal post-EOF kill and is never logged.
 *
 * @param child - Spawned child process to kill
 * @param ctx - Run id, mutable kill state, and the timeouts reported on kill
 * @returns Idempotent kill function taking the reason for the kill
 */
const makeKillChild = (
  child: ReturnType<typeof spawn>,
  ctx: KillContext,
  exitRecord: CliExitRecord
): ((reason: CliKillReason) => void) => {
  let killed = false;
  return (reason: CliKillReason) => {
    ctx.state.killReason ??= reason;
    if (killed) return;
    killed = true;
    logCliKill({ ...ctx, reason, elapsedMs: Date.now() - ctx.startedAtMs });
    signalProcessTree(child, 'SIGTERM');
    scheduleSigkill({ child, exitRecord, runId: ctx.runId, reason });
  };
};

/**
 * Escalates to SIGKILL on the process group when SIGTERM did not land within the grace period.
 *
 * Liveness comes from `exitRecord`, which the child's own `exit` listener populates. The
 * previous guard read `child.killed`, which only reports that a signal was *sent* — it was
 * always true here, so the escalation never ran.
 *
 * @param params - Child, its exit record, run id, and the reason recorded for the kill
 */
const scheduleSigkill = (params: ScheduleSigkillParams): void => {
  const { child, exitRecord, runId, reason } = params;
  setTimeout(() => {
    if (exitRecord.exited) return;
    logCliSigkillEscalation({ runId, reason });
    signalProcessTree(child, 'SIGKILL');
  }, SIGKILL_GRACE_MS).unref();
};

const makeInactivityTimer = (
  killFn: (reason: CliKillReason) => void,
  inactivityMs: number
): { reset: () => void; clear: () => void } => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    if (handle) clearTimeout(handle);
    handle = inactivityMs > 0 ? setTimeout(() => killFn('inactivity'), inactivityMs) : undefined;
  };
  const clear = () => clearTimeout(handle);
  return { reset, clear };
};

const createTimeoutManager = (
  killFn: (reason: CliKillReason) => void,
  wallMs: number,
  inactivityMs: number
): TimeoutManager => {
  const timeoutHandle = wallMs > 0 ? setTimeout(() => killFn('wall-clock'), wallMs) : undefined;
  const inactivity = makeInactivityTimer(killFn, inactivityMs);
  const resetInactivity = () => inactivity.reset();
  const clearInactivity = () => inactivity.clear();
  return { timeoutHandle, resetInactivity, clearInactivity };
};

const buildTimeoutMessage = (reason: string): ClaudeCliMessage => ({
  type: 'error', subtype: 'timeout', is_error: true, result: reason,
});

const cleanupCliStream = (
  tm: TimeoutManager,
  rl: ReturnType<typeof createInterface>,
  killFn: (reason: CliKillReason) => void
): void => {
  if (tm.timeoutHandle) clearTimeout(tm.timeoutHandle);
  tm.clearInactivity();
  rl.close();
  killFn('cleanup');
};

const resolveTimeoutMessage = (
  state: TimeoutState, inactivityMs: number, wallMs: number, timeoutConfigKeys?: CliTimeoutConfigKeys
): ClaudeCliMessage | null => {
  if (state.killReason === 'inactivity') {
    const key = timeoutConfigKeys?.inactivity ?? 'stages.<stage>.inactivityTimeoutMs';
    const msg = `Claude CLI stalled — no output for ${Math.ceil(inactivityMs / 1000)}s. Increase ${key} in wf.config.ts; models that think for long stretches can exceed the default.`;
    return buildTimeoutMessage(msg);
  }
  if (state.killReason === 'wall-clock') {
    const key = timeoutConfigKeys?.wallClock ?? 'stages.<stage>.timeoutMs';
    const msg = `Claude CLI exceeded the ${Math.round(wallMs / 1000)}s wall-clock limit. Increase ${key} in wf.config.ts.`;
    return buildTimeoutMessage(msg);
  }
  return null;
};

interface CliSession {
  runId: string;
  startedAtMs: number;
  rl: ReturnType<typeof createInterface>;
  stderr: BoundedStderr;
  exitRecord: CliExitRecord;
  killChild: (reason: CliKillReason) => void;
  state: TimeoutState;
  tm: TimeoutManager;
  timeoutMs: number;
  inactivityTimeoutMs: number;
  messageCount: number;
}

interface InitCliSessionParams {
  args: string[];
  cwd: string;
  prompt: string | undefined;
  env: Record<string, string> | undefined;
  timeoutMs: number;
  inactivityTimeoutMs: number;
}

const buildRunIdentity = (runId: string, params: InitCliSessionParams): CliRunIdentity => ({
  runId,
  binary: 'claude',
  model: extractArgValue(params.args, '--model'),
  cwd: params.cwd,
  args: params.args,
  envKeys: params.env ? Object.keys(params.env).sort((a, b) => a.localeCompare(b)) : [],
  promptChars: params.prompt?.length ?? 0,
  timeoutMs: params.timeoutMs,
  inactivityTimeoutMs: params.inactivityTimeoutMs,
});

const initCliSession = (params: InitCliSessionParams): CliSession => {
  const runId = buildRunId();
  const startedAtMs = Date.now();
  const { timeoutMs, inactivityTimeoutMs } = params;
  const { child, rl, stderr, exitRecord } = spawnChildProcess({ ...params, runId, startedAtMs });
  logCliSpawn(buildRunIdentity(runId, params));
  const state: TimeoutState = {};
  const killChild = makeKillChild(child, { runId, state, startedAtMs, timeoutMs, inactivityTimeoutMs }, exitRecord);
  const tm = createTimeoutManager(killChild, timeoutMs, inactivityTimeoutMs);
  tm.resetInactivity();
  return {
    runId, startedAtMs, rl, stderr, exitRecord, killChild,
    state, tm, timeoutMs, inactivityTimeoutMs, messageCount: 0,
  };
};

const assertCliProducedOutput = (session: CliSession): void => {
  if (session.messageCount > 0) return;
  const { spawnError } = session.exitRecord;
  if (spawnError) throw new ExecutionError(`Failed to spawn claude: ${spawnError.message}`);
  const stderr = session.stderr.text().trim();
  if (stderr) throw new AiProviderError(`Claude CLI failed to produce output: ${stderr}`);
};

const installSigintHandler = (
  killChild: (reason: CliKillReason) => void,
  rl: ReturnType<typeof createInterface>
): () => void =>
  registerSigintHandler(() => {
    killChild('sigint');
    rl.close();
  });

async function* runCliStream(session: CliSession): AsyncGenerator<ClaudeCliMessage, CliSession, undefined> {
  const { rl, killChild, tm } = session;
  const disposeSigint = installSigintHandler(killChild, rl);
  try {
    for await (const message of parseLineMessages(rl)) {
      session.messageCount += 1;
      yield message;
      if (!isSystemChatter(message)) tm.resetInactivity();
    }
  } finally {
    teardownCliStream(session, disposeSigint);
  }
  return session;
}

/**
 * Detaches the SIGINT handler, stops the timers, and records the run summary.
 * Called from `finally` so the summary — and the stderr it carries — survives a
 * timeout kill, a consumer `break`, and a downstream throw unwinding the generator.
 *
 * @param session - The completed CLI session
 * @param disposeSigint - Disposer that unregisters the run's SIGINT handler
 */
const teardownCliStream = (session: CliSession, disposeSigint: () => void): void => {
  disposeSigint();
  cleanupCliStream(session.tm, session.rl, session.killChild);
  finalizeCliRun(session);
};

const finalizeCliRun = (session: CliSession): void => {
  logCliRunSummary({
    runId: session.runId,
    messageCount: session.messageCount,
    elapsedMs: Date.now() - session.startedAtMs,
    killReason: session.state.killReason,
    stderr: session.stderr,
  });
};

/**
 * Spawns the Claude CLI as a subprocess and yields parsed NDJSON messages.
 * The prompt is written to stdin, and the stream is closed, since positional
 * arguments can be misinterpreted when `--allowedTools` is present.
 *
 * @param args - CLI arguments (built via `buildCliArgs`)
 * @param cwd - Working directory for the subprocess
 * @param prompt - Prompt text piped to the subprocess via stdin
 * @param env - Optional environment variable overrides
 * @param timeoutMs - Wall-clock timeout in milliseconds (default: 10 minutes)
 * @param inactivityTimeoutMs - Inactivity timeout in milliseconds; reset on each non-system-chatter
 *   yielded message (default: 2 minutes)
 * @returns Async generator yielding `ClaudeCliMessage` objects
 */
export async function* spawnCli(
  args: string[], cwd: string,
  prompt?: string, env?: Record<string, string>,
  timeoutMs: number = CLI_TIMEOUT_MS, inactivityTimeoutMs: number = CLI_INACTIVITY_TIMEOUT_MS,
  timeoutConfigKeys?: CliTimeoutConfigKeys
): AsyncGenerator<ClaudeCliMessage, void, undefined> {
  const session = initCliSession({ args, cwd, prompt, env, timeoutMs, inactivityTimeoutMs });
  const s = yield* runCliStream(session);
  const timeoutMsg = resolveTimeoutMessage(s.state, s.inactivityTimeoutMs, s.timeoutMs, timeoutConfigKeys);
  if (timeoutMsg) {
    yield timeoutMsg;
    return;
  }
  assertCliProducedOutput(s);
}
