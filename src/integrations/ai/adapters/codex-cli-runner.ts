import { ChildProcess, execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseNdjsonLine } from './claude-cli-runner';

export interface CodexCliMessage {
  type: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
  num_turns?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  tool_name?: string;
  files?: Array<{ filename: string }>;
  summary?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    exit_code?: number | null;
    status?: string;
    aggregated_output?: string;
  };
  [key: string]: unknown;
}

export interface CodexCliRunnerParams {
  prompt: string;
  appendSystemPrompt?: string;
  model: string;
  sessionId?: string;
  cwd: string;
  tools?: string[];
  permissionMode?: string;
  env?: Record<string, string>;
  codexVersion?: { major: number; minor: number; patch: number };
}

export const CLI_TIMEOUT_MS = 15 * 60 * 1000;
export const CLI_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

const CODEX_ERROR_LINE_PATTERN = /^ERROR:\s*(.+)$/;

const SIGKILL_GRACE_MS = 5000;
const REQUIRED_CODEX_CLI_MAJOR = 0;
const REQUIRED_CODEX_CLI_MIN_MINOR = 142;
// SHIM: remove when 0.142-0.146 support is dropped — always use --sandbox workspace-write.
const SANDBOX_WRITE_MIN_MINOR = 147;
const SKIP_VERSION_CHECK_ENV = 'WF_SKIP_CLI_VERSION_CHECK';

/**
 * Attempts to parse a raw ERROR line as JSON and extract its error message.
 *
 * @param raw - Raw text captured after the `ERROR:` prefix
 * @returns Parsed error message string, or the original raw value if parsing fails
 */
const parseErrorMessageJson = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed?.error?.message ?? raw;
  } catch {
    return raw;
  }
};

/**
 * Extracts meaningful error messages from Codex CLI stderr noise.
 *
 * @param stderr - Raw stderr output from the Codex CLI
 * @returns Extracted error message(s) or full stderr if no `ERROR:` lines found
 */
export const extractCodexErrorMessages = (stderr: string): string => {
  const errorLines = stderr
    .split('\n')
    .map(line => CODEX_ERROR_LINE_PATTERN.exec(line)?.[1])
    .filter((match): match is string => match !== undefined);

  if (errorLines.length === 0) return stderr;

  const unique = [...new Set(errorLines.map(parseErrorMessageJson))];
  return unique.join('; ');
};

/**
 * Parses a `codex --version` output string into major/minor/patch components.
 * Returns null when the string does not contain a recognisable semver triple.
 *
 * @param raw - Raw stdout from `codex --version` (e.g. "codex-cli 0.142.5")
 * @returns Parsed version object, or null if the format is unrecognisable
 */
export const parseCodexCliVersion = (raw: string): { major: number; minor: number; patch: number } | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

let cachedCodexVersion: { major: number; minor: number; patch: number } | undefined;

/**
 * Returns the Codex CLI version detected by the last `assertCodexCliAvailable` call.
 * Returns `undefined` when the version check was skipped or has not run yet.
 */
export const getCodexCliVersion = (): { major: number; minor: number; patch: number } | undefined =>
  cachedCodexVersion;

/** @internal Test-only — resets the cached version for test isolation. */
export const resetCodexCliVersionCache = (): void => {
  cachedCodexVersion = undefined;
};

/**
 * Asserts that a binary is present on the PATH by running `command -v <name>`.
 * Throws with an install URL when the binary is not found.
 *
 * @param name - Binary name to check (e.g. "codex")
 * @param installUrl - URL shown in the error message if the binary is missing
 */
const assertBinaryExists = (name: string, installUrl: string): void => {
  try {
    execSync(`command -v ${name}`, { stdio: 'pipe' });
  } catch {
    throw new Error(`${name} CLI is not installed. Install it by following: ${installUrl}`);
  }
};

/**
 * Runs `<name> --version` and returns the raw stdout string.
 * Throws a diagnostic error when the command itself fails.
 *
 * @param name - Binary name whose version to query
 * @returns Raw version string printed by the binary
 */
const getVersionOrThrow = (name: string): string => {
  try {
    return execSync(`${name} --version`, { stdio: 'pipe', encoding: 'utf-8' });
  } catch {
    throw new Error(`${name} CLI version check failed. Run \`${name} --version\` to diagnose.`);
  }
};

const CODEX_UPGRADE_HINT = 'Upgrade: npm install -g @openai/codex@latest. Or set WF_SKIP_CLI_VERSION_CHECK=1 to bypass.';

/**
 * Throws when the installed Codex CLI major version does not match the required one.
 *
 * @param vStr - Version string for display (e.g. "1.0.0")
 * @param requiredMajor - Expected major version
 * @param minMinor - Minimum minor version shown in the error
 */
const throwMajorMismatch = (vStr: string, requiredMajor: number, minMinor: number): never => {
  throw new Error(
    `Incompatible Codex CLI version ${vStr}. `
    + `Required: major=${requiredMajor} (>=${requiredMajor}.${minMinor}). ${CODEX_UPGRADE_HINT}`
  );
};

/**
 * Throws when the installed Codex CLI minor version is below the required minimum.
 *
 * @param vStr - Version string for display (e.g. "0.100.0")
 * @param requiredMajor - Required major version shown in the error
 * @param minMinor - Minimum required minor version
 */
const throwMinorTooOld = (vStr: string, requiredMajor: number, minMinor: number): never => {
  throw new Error(
    `Codex CLI version ${vStr} is too old. Required: >=${requiredMajor}.${minMinor}. ${CODEX_UPGRADE_HINT}`
  );
};

/**
 * Validates that a parsed semver satisfies the required major and minimum minor constraints.
 * Throws a descriptive upgrade error when either constraint is violated.
 *
 * @param version - Parsed semver object to validate
 * @param requiredMajor - Exact major version required
 * @param minMinor - Minimum minor version required when major matches
 */
const validateVersionRange = (
  version: { major: number; minor: number; patch: number },
  requiredMajor: number,
  minMinor: number,
): void => {
  const vStr = `${version.major}.${version.minor}.${version.patch}`;
  if (version.major !== requiredMajor) throwMajorMismatch(vStr, requiredMajor, minMinor);
  if (version.minor < minMinor) throwMinorTooOld(vStr, requiredMajor, minMinor);
};

/**
 * Asserts that the Codex CLI binary is installed and meets the minimum version requirement.
 * Throws with install/upgrade instructions when the binary is missing or incompatible.
 * Set WF_SKIP_CLI_VERSION_CHECK=1 to bypass the version check (e.g. in CI).
 */
export const assertCodexCliAvailable = (): void => {
  assertBinaryExists('Codex', 'https://github.com/openai/codex');

  if (process.env[SKIP_VERSION_CHECK_ENV] === '1') return;

  const raw = getVersionOrThrow('codex');
  const version = parseCodexCliVersion(raw);

  if (!version) {
    throw new Error(
      `Unrecognised Codex CLI version format: "${raw.trim()}". Set ${SKIP_VERSION_CHECK_ENV}=1 to bypass this check.`
    );
  }

  validateVersionRange(version, REQUIRED_CODEX_CLI_MAJOR, REQUIRED_CODEX_CLI_MIN_MINOR);
  cachedCodexVersion = version;
};

/**
 * Returns the CLI flag(s) that grant full file-system autonomy.
 * Before 0.147 Codex accepted `--full-auto`; from 0.147 onward it
 * requires `--sandbox workspace-write`.
 *
 * SHIM: remove when 0.142-0.146 support is dropped — always use `--sandbox workspace-write`.
 *
 * @param version - Parsed Codex CLI version; `undefined` falls back to `--full-auto`
 * @returns Argument tokens for the auto-approval mode
 */
const resolveAutoApprovalArgs = (version?: { minor: number }): string[] =>
  version && version.minor >= SANDBOX_WRITE_MIN_MINOR
    ? ['--sandbox', 'workspace-write']
    : ['--full-auto'];

/**
 * Builds the argument array for spawning the Codex CLI.
 * Always includes `--json` so the CLI emits NDJSON on stdout;
 * removing it breaks `parseNdjsonLine` and causes the review stage to throw.
 *
 * @param params - CLI runner parameters
 * @returns Argument array for the `codex` binary
 */
export const buildCodexCliArgs = (params: CodexCliRunnerParams): string[] => {
  if (params.sessionId) {
    const args = ['exec', '--json', 'resume', params.sessionId];
    if (params.model) args.push('--model', params.model);
    return args;
  }

  const args: string[] = ['exec', '--json'];
  if (params.model) args.push('--model', params.model);
  if (params.permissionMode === 'full-auto') args.push(...resolveAutoApprovalArgs(params.codexVersion));
  return args;
};

interface KillState {
  killed: boolean;
  timedOut: boolean;
  inactivityTimedOut: boolean;
  inactivityHandle: ReturnType<typeof setTimeout> | undefined;
}

interface KillController {
  kill: () => void;
  timedOut: () => boolean;
  inactivityTimedOut: () => boolean;
  resetInactivity: () => void;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Spawns the codex binary with the given args and writes the optional prompt to stdin.
 *
 * @param args - Arguments passed to the codex binary
 * @param cwd - Working directory for the subprocess
 * @param env - Optional environment variable overrides merged on top of `process.env`
 * @param prompt - Optional text written to the child's stdin before closing it
 * @returns The spawned child process
 */
const spawnCodexProcess = (
  args: string[], cwd: string, env?: Record<string, string>, prompt?: string,
): ChildProcess => {
  const child = spawn('codex', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (prompt) {
    child.stdin.write(prompt);
    child.stdin.end();
  }
  return child;
};

/**
 * Sends SIGKILL to a child process if it has not already exited.
 *
 * @param proc - Child process to escalate
 */
const escalateToSigkill = (proc: ChildProcess): void => {
  if (!proc.killed) proc.kill('SIGKILL');
};

const makeKillFn = (proc: ChildProcess, state: KillState): (() => void) => {
  return () => {
    if (state.killed) return;
    state.killed = true;
    if (state.inactivityHandle) clearTimeout(state.inactivityHandle);
    proc.kill('SIGTERM');
    setTimeout(() => escalateToSigkill(proc), SIGKILL_GRACE_MS);
  };
};

const makeResetInactivity = (
  state: KillState, inactivityTimeoutMs: number, onInactivity: () => void,
): (() => void) => {
  return () => {
    if (!state.inactivityHandle || state.killed) return;
    clearTimeout(state.inactivityHandle);
    state.inactivityHandle = setTimeout(onInactivity, inactivityTimeoutMs);
  };
};

const buildTimers = (
  state: KillState, timeoutMs: number, inactivityTimeoutMs: number, kill: () => void,
) => {
  const onTimeout = () => {
    state.timedOut = true;
    kill();
  };
  const onInactivity = () => {
    state.inactivityTimedOut = true;
    kill();
  };
  state.inactivityHandle = inactivityTimeoutMs > 0 ? setTimeout(onInactivity, inactivityTimeoutMs) : undefined;
  const timeoutHandle = timeoutMs > 0 ? setTimeout(onTimeout, timeoutMs) : undefined;
  return { timeoutHandle, resetInactivity: makeResetInactivity(state, inactivityTimeoutMs, onInactivity) };
};

const buildKillController = (proc: ChildProcess, timeoutMs: number, inactivityTimeoutMs: number): KillController => {
  const state: KillState = { killed: false, timedOut: false, inactivityTimedOut: false, inactivityHandle: undefined };
  const kill = makeKillFn(proc, state);
  const { timeoutHandle, resetInactivity } = buildTimers(state, timeoutMs, inactivityTimeoutMs, kill);
  return {
    kill, timeoutHandle, resetInactivity,
    timedOut: () => state.timedOut,
    inactivityTimedOut: () => state.inactivityTimedOut,
  };
};

/**
 * Inspects collected stderr chunks after the generator loop exits without yielding any messages.
 * Throws when non-empty stderr is present, surfacing the extracted error text.
 *
 * @param yieldedAny - Whether at least one message was yielded during the session
 * @param stderrChunks - Buffered stderr data collected from the child process
 */
const collectCodexResult = (yieldedAny: boolean, stderrChunks: Buffer[]): void => {
  if (yieldedAny || stderrChunks.length === 0) return;
  const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
  if (!stderr) return;
  throw new Error(`Codex CLI failed: ${extractCodexErrorMessages(stderr)}`);
};

/**
 * Builds a timeout error message for the Codex CLI generator.
 *
 * @param timeoutMs - The timeout duration in milliseconds
 * @returns A `CodexCliMessage` representing a timeout error
 */
export const buildTimeoutMessage = (timeoutMs: number): CodexCliMessage => ({
  type: 'error',
  subtype: 'timeout',
  is_error: true,
  result: `Codex CLI timed out after ${Math.round(timeoutMs / 1000)}s without returning a result.`,
});

export const buildInactivityTimeoutMessage = (inactivityTimeoutMs: number): CodexCliMessage => ({
  type: 'error',
  subtype: 'inactivity_timeout',
  is_error: true,
  result: `Codex CLI timed out after ${Math.round(inactivityTimeoutMs / 1000)}s of inactivity.`,
});

/**
 * Attaches a stderr data listener to the child process and returns the buffer array.
 *
 * @param proc - Child process whose stderr to collect
 * @returns Mutable array that accumulates raw stderr `Buffer` chunks
 */
const attachStderrCollector = (proc: ChildProcess): Buffer[] => {
  const chunks: Buffer[] = [];
  if (!proc.stderr) throw new Error('codex child process stderr not available');
  proc.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
  return chunks;
};

interface CodexSession {
  rl: ReturnType<typeof createInterface>;
  stderrChunks: Buffer[];
  ctrl: KillController;
  yieldedRef: [boolean];
}

/**
 * Wires up the readline interface, stderr collector, kill controller, and yielded-ref
 * for a spawned Codex child process.
 *
 * @param child - Spawned Codex child process
 * @param timeoutMs - Milliseconds before the kill controller fires
 * @returns Fully initialised `CodexSession` ready for the generator loop
 */
const buildCodexSession = (child: ChildProcess, timeoutMs: number, inactivityTimeoutMs: number): CodexSession => {
  if (!child.stdout) throw new Error('codex child process stdout not available');
  return {
    rl: createInterface({ input: child.stdout }),
    stderrChunks: attachStderrCollector(child),
    ctrl: buildKillController(child, timeoutMs, inactivityTimeoutMs),
    yieldedRef: [false],
  };
};

/**
 * Reads NDJSON lines from a readline interface and yields parsed messages.
 * Tracks whether any message was successfully yielded via the `yieldedRef`.
 *
 * @param rl - Readline interface wrapping the child process stdout
 * @param yieldedRef - Single-element array used as a mutable boolean reference
 * @returns Async generator that yields parsed `CodexCliMessage` objects
 */
async function* readCodexLines(
  rl: ReturnType<typeof createInterface>,
  yieldedRef: [boolean],
  resetInactivity: () => void,
): AsyncGenerator<CodexCliMessage, void, undefined> {
  for await (const line of rl) {
    const message = parseNdjsonLine(line) as CodexCliMessage | null;
    if (message) {
      yieldedRef[0] = true;
      resetInactivity();
      yield message;
    }
  }
}

/**
 * Spawns the Codex CLI as a subprocess and yields parsed NDJSON messages.
 *
 * @param args - CLI arguments (built via `buildCodexCliArgs`)
 * @param cwd - Working directory for the subprocess
 * @param prompt - Prompt text piped to the subprocess via stdin
 * @param env - Optional environment variable overrides
 * @param timeoutMs - Subprocess timeout in milliseconds (default: 10 minutes)
 * @returns Async generator yielding `CodexCliMessage` objects
 */
const installCodexSigintHandler = (child: ChildProcess, rl: ReturnType<typeof createInterface>): () => void => {
  const onSigint = () => {
    child.kill('SIGINT');
    rl.close();
  };
  process.on('SIGINT', onSigint);
  return onSigint;
};

const cleanupCodexSession = (
  onSigint: () => void, ctrl: KillController, rl: ReturnType<typeof createInterface>,
): void => {
  process.off('SIGINT', onSigint);
  if (ctrl.timeoutHandle) clearTimeout(ctrl.timeoutHandle);
  rl.close();
  ctrl.kill();
};

async function* runCodexStream(
  session: CodexSession, onSigint: () => void,
): AsyncGenerator<CodexCliMessage, void, undefined> {
  try {
    yield* readCodexLines(session.rl, session.yieldedRef, session.ctrl.resetInactivity);
  } finally {
    cleanupCodexSession(onSigint, session.ctrl, session.rl);
  }
}

const resolveTimeoutMessage = (
  ctrl: KillController, timeoutMs: number, inactivityTimeoutMs: number,
): CodexCliMessage | undefined => {
  if (ctrl.timedOut()) return buildTimeoutMessage(timeoutMs);
  if (ctrl.inactivityTimedOut()) return buildInactivityTimeoutMessage(inactivityTimeoutMs);
  return undefined;
};

export async function* spawnCodex(
  args: string[], cwd: string, prompt?: string, env?: Record<string, string>,
  timeoutMs = CLI_TIMEOUT_MS, inactivityTimeoutMs = CLI_INACTIVITY_TIMEOUT_MS,
): AsyncGenerator<CodexCliMessage, void, undefined> {
  const child = spawnCodexProcess(args, cwd, env, prompt);
  const session = buildCodexSession(child, timeoutMs, inactivityTimeoutMs);
  yield* runCodexStream(session, installCodexSigintHandler(child, session.rl));
  const timeoutMsg = resolveTimeoutMessage(session.ctrl, timeoutMs, inactivityTimeoutMs);
  if (timeoutMsg) {
    yield timeoutMsg;
    return;
  }
  collectCodexResult(session.yieldedRef[0], session.stderrChunks);
}
