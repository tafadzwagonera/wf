import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline';

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
}

const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const SIGKILL_GRACE_MS = 5000;
const CLI_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const REQUIRED_CLAUDE_CLI_MAJOR = 2;
const REQUIRED_CLAUDE_CLI_MIN_MINOR = 1;
const SKIP_VERSION_CHECK_ENV = 'WF_SKIP_CLI_VERSION_CHECK';
const CLAUDE_INSTALL_URL = 'https://docs.anthropic.com/en/docs/claude-code';
const UPGRADE_CMD = 'npm install -g @anthropic-ai/claude-code@latest';

/** Return type for the child process setup bundle. */
interface ChildBundle {
  child: ReturnType<typeof spawn>;
  rl: ReturnType<typeof createInterface>;
  stderrChunks: Buffer[];
}

/** Mutable timeout state threaded through the generator. */
interface TimeoutState {
  wallClockTimedOut: boolean;
  inactivityTimedOut: boolean;
}

/** Return type for the timeout manager. */
interface TimeoutManager {
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  inactivityHandle: ReturnType<typeof setTimeout> | undefined;
  resetInactivity: () => void;
}

/**
 * Parses a `claude --version` output string into major/minor/patch components.
 * Returns null when the string does not contain a recognisable semver triple.
 *
 * @param raw - Raw stdout from `claude --version` (e.g. "2.1.80 (Claude Code)")
 * @returns Parsed version object, or null if the format is unrecognisable
 */
export const parseClaudeCliVersion = (raw: string): { major: number; minor: number; patch: number } | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

/**
 * Asserts that a binary is available on PATH; throws with install instructions if not.
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

/**
 * Validates a parsed version against required major/minor constraints; throws with upgrade instructions.
 *
 * @param version - Parsed version object
 * @param required - Required major and minimum minor version numbers
 */
const validateVersionRange = (
  version: { major: number; minor: number; patch: number },
  required: { major: number; minMinor: number }
): void => {
  const vStr = `${version.major}.${version.minor}.${version.patch}`;
  const reqStr = `>=${required.major}.${required.minMinor}`;
  if (version.major !== required.major) assertMajorMatch(vStr, reqStr, required);
  if (version.minor < required.minMinor) assertMinorSufficient(vStr, reqStr);
};

/**
 * Asserts that the Claude CLI binary is installed and meets the minimum version requirement.
 * Throws with install/upgrade instructions when the binary is missing or incompatible.
 * Set WF_SKIP_CLI_VERSION_CHECK=1 to bypass the version check (e.g. in CI).
 */
export const assertClaudeCliAvailable = (): void => {
  assertBinaryExists('claude', CLAUDE_INSTALL_URL);
  if (process.env[SKIP_VERSION_CHECK_ENV] === '1') return;

  const raw = getVersionOrThrow('claude');
  const version = parseClaudeCliVersion(raw);
  if (!version) {
    throw new Error(
      `Unrecognised Claude CLI version format: "${raw.trim()}". Set ${SKIP_VERSION_CHECK_ENV}=1 to bypass this check.`
    );
  }
  validateVersionRange(version, { major: REQUIRED_CLAUDE_CLI_MAJOR, minMinor: REQUIRED_CLAUDE_CLI_MIN_MINOR });
};

/**
 * Appends a flag and its value to args when value is defined and non-empty.
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
  dirs?.forEach(dir => args.push('--add-dir', dir));
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
 * @param args - CLI argument array
 * @param cwd - Working directory for the subprocess
 * @param env - Optional environment variable overrides merged over process.env
 * @returns The spawned child process
 */
const spawnChild = (
  args: string[],
  cwd: string,
  env: Record<string, string> | undefined
): ReturnType<typeof spawn> =>
  spawn('claude', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/**
 * Writes prompt to the child's stdin if provided, then closes stdin.
 *
 * @param child - Spawned child process whose stdin to write to
 * @param prompt - Optional prompt text to write
 */
const pipePrompt = (child: ReturnType<typeof spawn>, prompt: string | undefined): void => {
  if (!prompt) return;
  child.stdin.write(prompt);
  child.stdin.end();
};

/**
 * Spawns the Claude CLI subprocess, wires stdin/stderr, and returns the child bundle.
 *
 * @param args - CLI argument array
 * @param cwd - Working directory for the subprocess
 * @param prompt - Optional prompt written to stdin
 * @param env - Optional environment variable overrides
 * @returns Bundle containing the child process, readline interface, and stderr accumulator
 */
const spawnChildProcess = (
  args: string[],
  cwd: string,
  prompt: string | undefined,
  env: Record<string, string> | undefined
): ChildBundle => {
  const child = spawnChild(args, cwd, env);
  pipePrompt(child, prompt);
  const rl = createInterface({ input: child.stdout });
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  return { child, rl, stderrChunks };
};

/**
 * Returns a kill function that sends SIGTERM then SIGKILL after a grace period.
 *
 * @param child - Spawned child process to kill
 * @returns Idempotent kill function
 */
const makeKillChild = (child: ReturnType<typeof spawn>): (() => void) => {
  let killed = false;
  return () => {
    if (killed) return;
    killed = true;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, SIGKILL_GRACE_MS).unref();
  };
};

/**
 * Sets the inactivity timeout flag and invokes the kill function.
 *
 * @param state - Mutable timeout state to mark as inactivity-timed-out
 * @param killFn - Kill function to invoke
 */
const fireInactivity = (state: TimeoutState, killFn: () => void): void => {
  state.inactivityTimedOut = true;
  killFn();
};

/**
 * Schedules an inactivity timer that fires killFn after inactivityMs of silence.
 *
 * @param killFn - Called when the inactivity timer fires
 * @param state - Mutable state object whose inactivityTimedOut flag is set on fire
 * @param inactivityMs - Milliseconds of silence before killing; 0 disables
 * @returns Object with the handle (for clearTimeout) and a reset function
 */
const makeInactivityTimer = (
  killFn: () => void,
  state: TimeoutState,
  inactivityMs: number
): { handle: ReturnType<typeof setTimeout> | undefined; reset: () => void } => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    if (handle) clearTimeout(handle);
    handle = inactivityMs > 0 ? setTimeout(() => fireInactivity(state, killFn), inactivityMs) : undefined;
  };
  return { handle, reset };
};

/**
 * Sets the wall-clock timeout flag and invokes the kill function.
 *
 * @param state - Mutable timeout state to mark as wall-clock-timed-out
 * @param killFn - Kill function to invoke
 */
const fireWallClock = (state: TimeoutState, killFn: () => void): void => {
  state.wallClockTimedOut = true;
  killFn();
};

/**
 * Creates wall-clock and inactivity timeout handles that call killFn on expiry.
 *
 * @param killFn - Callback invoked when either timeout fires
 * @param state - Mutable timeout state updated by the timers
 * @param wallMs - Wall-clock timeout in ms; 0 disables
 * @param inactivityMs - Inactivity timeout in ms; 0 disables
 * @returns Manager with handles and a resetInactivity function
 */
const createTimeoutManager = (
  killFn: () => void,
  state: TimeoutState,
  wallMs: number,
  inactivityMs: number
): TimeoutManager => {
  const timeoutHandle = wallMs > 0 ? setTimeout(() => fireWallClock(state, killFn), wallMs) : undefined;
  const inactivity = makeInactivityTimer(killFn, state, inactivityMs);
  const resetInactivity = () => inactivity.reset();
  return { timeoutHandle, inactivityHandle: inactivity.handle, resetInactivity };
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
  killFn: () => void
): void => {
  if (tm.timeoutHandle) clearTimeout(tm.timeoutHandle);
  if (tm.inactivityHandle) clearTimeout(tm.inactivityHandle);
  rl.close();
  killFn();
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
  if (state.inactivityTimedOut) {
    return buildTimeoutMessage(`Claude CLI stalled — no output for ${Math.ceil(inactivityMs / 1000)}s.`);
  }
  if (state.wallClockTimedOut) {
    const msg = `Claude CLI exceeded the ${Math.round(wallMs / 1000)}s wall-clock limit. Increase stages.<stage>.timeoutMs in wf.config.ts.`;
    return buildTimeoutMessage(msg);
  }
  return null;
};

/** Runtime context created at the start of a spawnCli call. */
interface CliSession {
  rl: ReturnType<typeof createInterface>;
  stderrChunks: Buffer[];
  killChild: () => void;
  state: TimeoutState;
  tm: TimeoutManager;
  timeoutMs: number;
  inactivityTimeoutMs: number;
  yieldedAny: boolean;
}

/**
 * Initialises all runtime state needed by spawnCli and starts the timeout timers.
 *
 * @param args - CLI argument array
 * @param cwd - Working directory for the subprocess
 * @param prompt - Optional prompt written to stdin
 * @param env - Optional environment variable overrides
 * @param timeoutMs - Wall-clock timeout in ms
 * @param inactivityMs - Inactivity timeout in ms
 * @returns Initialised CliSession with timers running
 */
const initCliSession = (
  args: string[],
  cwd: string,
  prompt: string | undefined,
  env: Record<string, string> | undefined,
  timeoutMs: number,
  inactivityTimeoutMs: number
): CliSession => {
  const { child, rl, stderrChunks } = spawnChildProcess(args, cwd, prompt, env);
  const killChild = makeKillChild(child);
  const state: TimeoutState = { wallClockTimedOut: false, inactivityTimedOut: false };
  const tm = createTimeoutManager(killChild, state, timeoutMs, inactivityTimeoutMs);
  tm.resetInactivity();
  return { rl, stderrChunks, killChild, state, tm, timeoutMs, inactivityTimeoutMs, yieldedAny: false };
};

/**
 * Throws when the CLI produced no stdout but stderr was non-empty.
 *
 * @param yieldedAny - Whether any message was yielded from the generator
 * @param stderrChunks - Accumulated stderr buffers
 */
const throwIfStderrOnly = (yieldedAny: boolean, stderrChunks: Buffer[]): void => {
  if (yieldedAny || stderrChunks.length === 0) return;
  const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
  if (stderr) throw new Error(`Claude CLI failed to produce output: ${stderr}`);
};

/**
 * Runs the CLI stream loop with cleanup; yields parsed messages and returns the session for post-loop checks.
 *
 * @param session - Initialised CLI session (child process, readline, timers)
 * @returns Async generator yielding ClaudeCliMessage objects; returns the session on completion
 */
async function* runCliStream(session: CliSession): AsyncGenerator<ClaudeCliMessage, CliSession, undefined> {
  const { rl, killChild, tm } = session;
  try {
    for await (const message of parseLineMessages(rl)) {
      session.yieldedAny = true;
      yield message;
      tm.resetInactivity();
    }
  } finally {
    cleanupCliStream(tm, rl, killChild);
  }
  return session;
}

/**
 * Spawns the Claude CLI as a subprocess and yields parsed NDJSON messages.
 * The prompt is written to stdin and the stream is closed, since positional
 * arguments can be misinterpreted when `--allowedTools` is present.
 *
 * @param args - CLI arguments (built via `buildCliArgs`)
 * @param cwd - Working directory for the subprocess
 * @param prompt - Prompt text piped to the subprocess via stdin
 * @param env - Optional environment variable overrides
 * @param timeoutMs - Wall-clock timeout in milliseconds (default: 10 minutes)
 * @param inactivityTimeoutMs - Inactivity timeout in milliseconds; reset on each yielded message (default: 2 minutes)
 * @returns Async generator yielding `ClaudeCliMessage` objects
 */
export async function* spawnCli(
  args: string[], cwd: string,
  prompt?: string, env?: Record<string, string>,
  timeoutMs: number = CLI_TIMEOUT_MS, inactivityTimeoutMs: number = CLI_INACTIVITY_TIMEOUT_MS
): AsyncGenerator<ClaudeCliMessage, void, undefined> {
  const session = initCliSession(args, cwd, prompt, env, timeoutMs, inactivityTimeoutMs);
  const s = yield* runCliStream(session);
  const timeoutMsg = resolveTimeoutMessage(s.state, s.inactivityTimeoutMs, s.timeoutMs);
  if (timeoutMsg) {
    yield timeoutMsg;
    return;
  }
  throwIfStderrOnly(s.yieldedAny, s.stderrChunks);
}
