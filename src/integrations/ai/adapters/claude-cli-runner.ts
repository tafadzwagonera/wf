import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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
}

export const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const SIGKILL_GRACE_MS = 5000;
export const CLI_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const REQUIRED_CLAUDE_CLI_MAJOR = 2;
const REQUIRED_CLAUDE_CLI_MIN_MINOR = 1;
const REQUIRED_CLAUDE_CLI_MIN_PATCH = 219;
const SKIP_VERSION_CHECK_ENV = 'WF_SKIP_CLI_VERSION_CHECK';
const CLAUDE_INSTALL_URL = 'https://docs.anthropic.com/en/docs/claude-code';
const UPGRADE_CMD = 'brew upgrade --cask claude-code';

/** Return type for the child process setup bundle. */
interface ChildBundle {
  child: ReturnType<typeof spawn>;
  rl: ReturnType<typeof createInterface>;
  stderrChunks: Buffer[];
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

/** Context the kill function needs to record and report why the child died. */
interface KillContext {
  runId: string;
  state: TimeoutState;
  startedAtMs: number;
  timeoutMs: number;
  inactivityTimeoutMs: number;
}

/** Inputs for spawning the child process. */
interface SpawnChildParams {
  runId: string;
  args: string[];
  cwd: string;
  env: Record<string, string> | undefined;
  startedAtMs: number;
}

/** Inputs for spawning the child process and wiring its streams. */
interface SpawnChildProcessParams extends SpawnChildParams {
  prompt: string | undefined;
}

/** Return type for the timeout manager. */
interface TimeoutManager {
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  resetInactivity: () => void;
  clearInactivity: () => void;
}

/**
 * Parses a `claude --version` output string into major/minor/patch components.
 * Returns null when the string does not contain a recognisable semver triple.
 *
 * @param raw - Raw stdout from `claude --version` (e.g. "2.1.80 (Claude Code)")
 * @returns Parsed version object, or null if the format is unrecognizable
 */
export const parseClaudeCliVersion = (raw: string): { major: number; minor: number; patch: number } | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

/**
 * Asserts that a binary is available on PATH; throws with installation instructions if not.
 *
 * @param name - Binary name to check (e.g. "claude")
 * @param installUrl - URL shown in the error message when binary is missing
 */
const assertBinaryExists = (name: string, installUrl: string): void => {
  try {
    execSync(`command -v ${name}`, { stdio: 'pipe' });
  } catch {
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    throw new Error(`${displayName} CLI is not installed. Install it by following: ${installUrl}`);
  }
};

/**
 * Runs `<name> --version` and returns its stdout; throws with a diagnostic hint on failure.
 *
 * @param name - Binary name to query
 * @returns Raw stdout from the version command
 */
const getVersionOrThrow = (name: string): string => {
  try {
    return execSync(`${name} --version`, { stdio: 'pipe', encoding: 'utf-8' });
  } catch {
    throw new Error(`${name} CLI version check failed. Run \`${name} --version\` to diagnose.`);
  }
};

/**
 * Throws when the parsed version's major does not match the required major.
 *
 * @param vStr - Version string for display (e.g. "2.0.1")
 * @param reqStr - Requirement string for display (e.g. ">=2.1")
 * @param required - Required major and minimum minor numbers
 */
const assertMajorMatch = (vStr: string, reqStr: string, required: { major: number; minMinor: number }): void => {
  const bypass = `Or set ${SKIP_VERSION_CHECK_ENV}=1 to bypass.`;
  throw new Error(
    `Incompatible Claude CLI version ${vStr}. Required: major=${required.major} (${reqStr}). `
    + `Upgrade: ${UPGRADE_CMD}. ${bypass}`
  );
};

/**
 * Throws when the parsed version's minor is below the required minimum.
 *
 * @param vStr - Version string for display (e.g. "2.0.1")
 * @param reqStr - Requirement string for display (e.g. ">=2.1")
 */
const assertMinorSufficient = (vStr: string, reqStr: string): void => {
  const bypass = `Or set ${SKIP_VERSION_CHECK_ENV}=1 to bypass.`;
  throw new Error(`Claude CLI version ${vStr} is too old. Required: ${reqStr}. Upgrade: ${UPGRADE_CMD}. ${bypass}`);
};

const assertPatchSufficient = (vStr: string, reqStr: string): void => {
  const bypass = `Or set ${SKIP_VERSION_CHECK_ENV}=1 to bypass.`;
  throw new Error(`Claude CLI version ${vStr} is too old. Required: ${reqStr}. Upgrade: ${UPGRADE_CMD}. ${bypass}`);
};

/**
 * Validates a parsed version against required major/minor/patch constraints; throws with upgrade instructions.
 *
 * @param version - Parsed version object
 * @param required - Required major, minimum minor, and optional minimum patch version numbers
 */
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

/**
 * Renders the required version as a comparison string for error messages.
 *
 * @param required - Required major, minimum minor, and optional minimum patch
 * @returns Human-readable requirement such as `>=2.1.219`
 */
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

/**
 * Reads and parses the installed Claude CLI version.
 *
 * @returns The parsed version object
 * @throws When the reported version string cannot be parsed
 */
const readClaudeCliVersionOrThrow = (): { major: number; minor: number; patch: number } => {
  const raw = getVersionOrThrow('claude');
  const version = parseClaudeCliVersion(raw);
  if (!version) {
    throw new Error(
      `Unrecognised Claude CLI version format: "${raw.trim()}". Set ${SKIP_VERSION_CHECK_ENV}=1 to bypass this check.`
    );
  }
  return version;
};

/**
 * Asserts that the Claude CLI binary is installed and meets the minimum version requirement.
 * Throws with install/upgrade instructions when the binary is missing or incompatible.
 * Set WF_SKIP_CLI_VERSION_CHECK=1 to bypass the version check (e.g., in CI).
 */
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

/**
 * Appends a flag and its value to args when the value is defined and non-empty.
 *
 * @param args - Mutable argument array to append to
 * @param flag - CLI flag string (e.g. "--model")
 * @param value - Optional value; nothing is pushed when falsy
 */
const appendOptionalArg = (args: string[], flag: string, value: string | undefined): void => {
  if (value) args.push(flag, value);
};

/**
 * Appends `--add-dir <dir>` pairs for each entry in dirs.
 *
 * @param args - Mutable argument array to append to
 * @param dirs - Optional list of directories to add
 */
const appendAddDirs = (args: string[], dirs: string[] | undefined): void => {
  if (!dirs) return;
  for (const dir of dirs) args.push('--add-dir', dir);
};

/**
 * Builds the argument array for spawning the Claude CLI in headless mode.
 *
 * @param params - CLI runner parameters
 * @returns Argument array for the `claude` binary
 */
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
  return args;
};

/**
 * Parses a single NDJSON line from Claude CLI output.
 *
 * @param line - Raw NDJSON line string
 * @returns Parsed message or null for unparseable lines
 */
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

/**
 * Filters a readline interface's output into a stream of valid ClaudeCliMessage objects.
 *
 * @param rl - Readline interface to read lines from
 * @returns Async generator yielding parsed, non-null ClaudeCliMessage objects
 */
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
  const child = spawn('claude', params.args, {
    cwd: params.cwd,
    env: params.env ? { ...process.env, ...params.env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  attachExitListeners(child, exitRecord, params);
  return { child, exitRecord };
};

/**
 * Attaches passive listeners that record how the child terminated.
 *
 * @param child - Spawned child process
 * @param exitRecord - Mutable record the listeners populate
 * @param params - Run id and start timestamp used for correlation and elapsed time
 */
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

/**
 * Writes prompt to the child's stdin if provided, then closes stdin.
 *
 * @param child - Spawned child process whose stdin to write to
 * @param prompt - Optional prompt text to write
 */
const pipePrompt = (child: ReturnType<typeof spawn>, prompt: string | undefined): void => {
  if (!prompt || !child.stdin) return;
  child.stdin.write(prompt);
  child.stdin.end();
};

/**
 * Spawns the Claude CLI subprocess, wires stdin/stderr, and returns the child bundle.
 *
 * @param params - Run id, argv, cwd, prompt, env overrides, and the run start timestamp
 * @returns Bundle containing the child process, readline interface, stderr accumulator, and exit record
 */
const spawnChildProcess = (params: SpawnChildProcessParams): ChildBundle => {
  const { child, exitRecord } = spawnChild(params);
  pipePrompt(child, params.prompt);
  if (!child.stdout) throw new Error('claude child process stdout not available');
  if (!child.stderr) throw new Error('claude child process stderr not available');
  const rl = createInterface({ input: child.stdout });
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  return { child, rl, stderrChunks, exitRecord };
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
const makeKillChild = (child: ReturnType<typeof spawn>, ctx: KillContext): ((reason: CliKillReason) => void) => {
  let killed = false;
  return (reason: CliKillReason) => {
    ctx.state.killReason ??= reason;
    if (killed) return;
    killed = true;
    logCliKill({ ...ctx, reason, elapsedMs: Date.now() - ctx.startedAtMs });
    child.kill('SIGTERM');
    scheduleSigkill(child, ctx.runId, reason);
  };
};

/**
 * Escalates to SIGKILL if the child has not exited within the grace period.
 *
 * @param child - Spawned child process to escalate against
 * @param runId - Correlation id for the run
 * @param reason - Why the child was killed, recorded on escalation
 */
const scheduleSigkill = (child: ReturnType<typeof spawn>, runId: string, reason: CliKillReason): void => {
  setTimeout(() => {
    if (child.killed) return;
    logCliSigkillEscalation({ runId, reason });
    child.kill('SIGKILL');
  }, SIGKILL_GRACE_MS).unref();
};

/**
 * Schedules an inactivity timer that kills the child after inactivityMs of silence.
 *
 * @param killFn - Called with 'inactivity' when the timer fires
 * @param inactivityMs - Milliseconds of silence before killing; 0 disables
 * @returns Object with reset and clear functions
 */
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

/**
 * Creates wall-clock and inactivity timeout handles that kill the child on expiry.
 *
 * @param killFn - Callback invoked with the kill reason when either timeout fires
 * @param wallMs - Wall-clock timeout in ms; 0 disables
 * @param inactivityMs - Inactivity timeout in ms; 0 disables
 * @returns Manager with handles and a resetInactivity function
 */
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

/**
 * Builds a timeout ClaudeCliMessage for the given reason.
 *
 * @param reason - Human-readable timeout description shown in the result field
 * @returns A ClaudeCliMessage with type "error" and subtype "timeout"
 */
const buildTimeoutMessage = (reason: string): ClaudeCliMessage => ({
  type: 'error', subtype: 'timeout', is_error: true, result: reason,
});

/**
 * Clears timeout handles, closes the readline interface, and kills the child process.
 *
 * @param tm - Timeout manager whose handles should be cleared
 * @param rl - Readline interface to close
 * @param killFn - Kill function to invoke
 */
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

/**
 * Returns a timeout ClaudeCliMessage when the state indicates a timeout, or null otherwise.
 *
 * @param state - Timeout state from the generator run
 * @param inactivityMs - Inactivity timeout in ms (used to format the message)
 * @param wallMs - Wall-clock timeout in ms (used to format the message)
 * @returns A ClaudeCliMessage on timeout, or null when no timeout occurred
 */
const resolveTimeoutMessage = (
  state: TimeoutState,
  inactivityMs: number,
  wallMs: number
): ClaudeCliMessage | null => {
  if (state.killReason === 'inactivity') {
    const msg = `Claude CLI stalled — no output for ${Math.ceil(inactivityMs / 1000)}s. Increase stages.<stage>.inactivityTimeoutMs in wf.config.ts; models that think for long stretches can exceed the default.`;
    return buildTimeoutMessage(msg);
  }
  if (state.killReason === 'wall-clock') {
    const msg = `Claude CLI exceeded the ${Math.round(wallMs / 1000)}s wall-clock limit. Increase stages.<stage>.timeoutMs in wf.config.ts.`;
    return buildTimeoutMessage(msg);
  }
  return null;
};

/** Runtime context created at the start of a spawnCli call. */
interface CliSession {
  runId: string;
  startedAtMs: number;
  rl: ReturnType<typeof createInterface>;
  stderrChunks: Buffer[];
  exitRecord: CliExitRecord;
  killChild: (reason: CliKillReason) => void;
  state: TimeoutState;
  tm: TimeoutManager;
  timeoutMs: number;
  inactivityTimeoutMs: number;
  messageCount: number;
}

/** Inputs for initialising a CLI session. */
interface InitCliSessionParams {
  args: string[];
  cwd: string;
  prompt: string | undefined;
  env: Record<string, string> | undefined;
  timeoutMs: number;
  inactivityTimeoutMs: number;
}

/**
 * Builds the immutable identity of a run, capturing the facts needed to diagnose
 * a failure (model, resolved timeouts, argv) before anything can go wrong.
 *
 * @param runId - Correlation id for this run
 * @param params - Session inputs
 * @returns Identity record for logging
 */
const buildRunIdentity = (runId: string, params: InitCliSessionParams): CliRunIdentity => ({
  runId,
  binary: 'claude',
  model: extractArgValue(params.args, '--model'),
  cwd: params.cwd,
  args: params.args,
  envKeys: params.env ? Object.keys(params.env).sort() : [],
  promptChars: params.prompt?.length ?? 0,
  timeoutMs: params.timeoutMs,
  inactivityTimeoutMs: params.inactivityTimeoutMs,
});

/**
 * Initializes all runtime state needed by spawnCli and starts the timeout timers.
 *
 * @param params - argv, cwd, prompt, env overrides, and both resolved timeouts
 * @returns Initialised CliSession with timers running
 */
const initCliSession = (params: InitCliSessionParams): CliSession => {
  const runId = buildRunId();
  const startedAtMs = Date.now();
  const { timeoutMs, inactivityTimeoutMs } = params;
  const { child, rl, stderrChunks, exitRecord } = spawnChildProcess({ ...params, runId, startedAtMs });
  logCliSpawn(buildRunIdentity(runId, params));
  const state: TimeoutState = {};
  const killChild = makeKillChild(child, { runId, state, startedAtMs, timeoutMs, inactivityTimeoutMs });
  const tm = createTimeoutManager(killChild, timeoutMs, inactivityTimeoutMs);
  tm.resetInactivity();
  return {
    runId, startedAtMs, rl, stderrChunks, exitRecord, killChild,
    state, tm, timeoutMs, inactivityTimeoutMs, messageCount: 0,
  };
};

/**
 * Throws when the CLI produced no usable stdout, preferring the spawn failure when there was one.
 *
 * @param session - Completed CLI session
 */
const assertCliProducedOutput = (session: CliSession): void => {
  if (session.messageCount > 0) return;
  const { spawnError } = session.exitRecord;
  if (spawnError) throw new Error(`Failed to spawn claude: ${spawnError.message}`);
  const stderr = Buffer.concat(session.stderrChunks).toString('utf-8').trim();
  if (stderr) throw new Error(`Claude CLI failed to produce output: ${stderr}`);
};

/**
 * Runs the CLI stream loop with cleanup; yields parsed messages and returns the session for post-loop checks.
 *
 * @param session - Initialised CLI session (child process, readline, timers)
 * @returns Async generator yielding ClaudeCliMessage objects; returns the session on completion
 */
const installSigintHandler = (
  killChild: (reason: CliKillReason) => void,
  rl: ReturnType<typeof createInterface>
): () => void => {
  const onSigint = () => {
    killChild('sigint');
    rl.close();
  };
  process.on('SIGINT', onSigint);
  return onSigint;
};

async function* runCliStream(session: CliSession): AsyncGenerator<ClaudeCliMessage, CliSession, undefined> {
  const { rl, killChild, tm } = session;
  const onSigint = installSigintHandler(killChild, rl);
  try {
    for await (const message of parseLineMessages(rl)) {
      session.messageCount += 1;
      yield message;
      if (!isSystemChatter(message)) tm.resetInactivity();
    }
  } finally {
    teardownCliStream(session, onSigint);
  }
  return session;
}

/**
 * Detaches the SIGINT handler, stops the timers, and records the run summary.
 * Called from `finally` so the summary — and the stderr it carries — survives a
 * timeout kill, a consumer `break`, and a downstream throw unwinding the generator.
 *
 * @param session - The completed CLI session
 * @param onSigint - The SIGINT handler to detach
 */
const teardownCliStream = (session: CliSession, onSigint: () => void): void => {
  process.off('SIGINT', onSigint);
  cleanupCliStream(session.tm, session.rl, session.killChild);
  finalizeCliRun(session);
};

/**
 * Records the run summary for a completed session.
 *
 * @param session - The completed CLI session
 */
const finalizeCliRun = (session: CliSession): void => {
  logCliRunSummary({
    runId: session.runId,
    messageCount: session.messageCount,
    elapsedMs: Date.now() - session.startedAtMs,
    killReason: session.state.killReason,
    stderrChunks: session.stderrChunks,
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
  timeoutMs: number = CLI_TIMEOUT_MS, inactivityTimeoutMs: number = CLI_INACTIVITY_TIMEOUT_MS
): AsyncGenerator<ClaudeCliMessage, void, undefined> {
  const session = initCliSession({ args, cwd, prompt, env, timeoutMs, inactivityTimeoutMs });
  const s = yield* runCliStream(session);
  const timeoutMsg = resolveTimeoutMessage(s.state, s.inactivityTimeoutMs, s.timeoutMs);
  if (timeoutMsg) {
    yield timeoutMsg;
    return;
  }
  assertCliProducedOutput(s);
}
