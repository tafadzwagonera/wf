import { ChildProcess, execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AiProviderError, ConfigurationError, ExecutionError } from '../../../shared/utils/errors';
import { signalProcessTree } from '../../../shared/utils/signal-process-tree';
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

const parseErrorMessageJson = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed?.error?.message ?? raw;
  } catch {
    return raw;
  }
};

export const extractCodexErrorMessages = (stderr: string): string => {
  const errorLines = stderr
    .split('\n')
    .map(line => CODEX_ERROR_LINE_PATTERN.exec(line)?.[1])
    .filter((match): match is string => match !== undefined);

  if (errorLines.length === 0) return stderr;

  const unique = [...new Set(errorLines.map(parseErrorMessageJson))];
  return unique.join('; ');
};

export const parseCodexCliVersion = (raw: string): { major: number; minor: number; patch: number } | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

let cachedCodexVersion: { major: number; minor: number; patch: number } | undefined;

export const getCodexCliVersion = (): { major: number; minor: number; patch: number } | undefined =>
  cachedCodexVersion;

/** @internal Test-only — resets the cached version for test isolation. */
export const resetCodexCliVersionCache = (): void => {
  cachedCodexVersion = undefined;
};

const assertBinaryExists = (name: string, installUrl: string): void => {
  try {
    execSync(`command -v ${name}`, { stdio: 'pipe' });
  } catch {
    throw new ConfigurationError(`${name} CLI is not installed. Install it by following: ${installUrl}`);
  }
};

const getVersionOrThrow = (name: string): string => {
  try {
    return execSync(`${name} --version`, { stdio: 'pipe', encoding: 'utf-8' });
  } catch {
    throw new ConfigurationError(`${name} CLI version check failed. Run \`${name} --version\` to diagnose.`);
  }
};

const CODEX_UPGRADE_HINT = 'Upgrade: npm install -g @openai/codex@latest. Or set WF_SKIP_CLI_VERSION_CHECK=1 to bypass.';

const throwMajorMismatch = (vStr: string, requiredMajor: number, minMinor: number): never => {
  throw new ConfigurationError(
    `Incompatible Codex CLI version ${vStr}. `
    + `Required: major=${requiredMajor} (>=${requiredMajor}.${minMinor}). ${CODEX_UPGRADE_HINT}`
  );
};

const throwMinorTooOld = (vStr: string, requiredMajor: number, minMinor: number): never => {
  throw new ConfigurationError(
    `Codex CLI version ${vStr} is too old. Required: >=${requiredMajor}.${minMinor}. ${CODEX_UPGRADE_HINT}`
  );
};

const validateVersionRange = (
  version: { major: number; minor: number; patch: number },
  requiredMajor: number,
  minMinor: number,
): void => {
  const vStr = `${version.major}.${version.minor}.${version.patch}`;
  if (version.major !== requiredMajor) throwMajorMismatch(vStr, requiredMajor, minMinor);
  if (version.minor < minMinor) throwMinorTooOld(vStr, requiredMajor, minMinor);
};

export const assertCodexCliAvailable = (): void => {
  assertBinaryExists('Codex', 'https://github.com/openai/codex');

  if (process.env[SKIP_VERSION_CHECK_ENV] === '1') return;

  const raw = getVersionOrThrow('codex');
  const version = parseCodexCliVersion(raw);

  if (!version) {
    throw new ConfigurationError(
      `Unrecognised Codex CLI version format: "${raw.trim()}". Set ${SKIP_VERSION_CHECK_ENV}=1 to bypass this check.`
    );
  }

  validateVersionRange(version, REQUIRED_CODEX_CLI_MAJOR, REQUIRED_CODEX_CLI_MIN_MINOR);
  cachedCodexVersion = version;
};

const resolveAutoApprovalArgs = (version?: { minor: number }): string[] =>
  version && version.minor >= SANDBOX_WRITE_MIN_MINOR
    ? ['--sandbox', 'workspace-write']
    : ['--full-auto'];

// Always passes --json so the CLI emits NDJSON on stdout; omitting it breaks parseNdjsonLine.
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
  exited: boolean;
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

const spawnCodexProcess = (
  args: string[], cwd: string, env?: Record<string, string>, prompt?: string,
): ChildProcess => {
  const child = spawn('codex', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  if (prompt) {
    child.stdin.write(prompt);
    child.stdin.end();
  }
  return child;
};

/**
 * Escalates to SIGKILL on the process group when SIGTERM did not land within the grace period.
 *
 * Liveness comes from `state.exited`, populated by the child's own `exit` listener. The
 * previous guard read `proc.killed`, which only reports that a signal was *sent* — the
 * preceding SIGTERM always set it, so the escalation never ran.
 *
 * @param proc - Spawned codex child process
 * @param state - Mutable kill state carrying the observed exit
 */
const escalateToSigkill = (proc: ChildProcess, state: KillState): void => {
  if (state.exited) return;
  signalProcessTree(proc, 'SIGKILL');
};

const makeKillFn = (proc: ChildProcess, state: KillState): (() => void) => {
  proc.once('exit', () => {
    state.exited = true;
  });
  return () => {
    if (state.killed) return;
    state.killed = true;
    if (state.inactivityHandle) clearTimeout(state.inactivityHandle);
    signalProcessTree(proc, 'SIGTERM');
    setTimeout(() => escalateToSigkill(proc, state), SIGKILL_GRACE_MS).unref();
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
  const state: KillState = {
    killed: false, exited: false, timedOut: false, inactivityTimedOut: false, inactivityHandle: undefined,
  };
  const kill = makeKillFn(proc, state);
  const { timeoutHandle, resetInactivity } = buildTimers(state, timeoutMs, inactivityTimeoutMs, kill);
  return {
    kill, timeoutHandle, resetInactivity,
    timedOut: () => state.timedOut,
    inactivityTimedOut: () => state.inactivityTimedOut,
  };
};

const collectCodexResult = (yieldedAny: boolean, stderrChunks: Buffer[]): void => {
  if (yieldedAny || stderrChunks.length === 0) return;
  const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
  if (!stderr) return;
  throw new AiProviderError(`Codex CLI failed: ${extractCodexErrorMessages(stderr)}`);
};

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

const attachStderrCollector = (proc: ChildProcess): Buffer[] => {
  const chunks: Buffer[] = [];
  if (!proc.stderr) throw new ExecutionError('codex child process stderr not available');
  proc.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
  return chunks;
};

interface CodexSession {
  rl: ReturnType<typeof createInterface>;
  stderrChunks: Buffer[];
  ctrl: KillController;
  yieldedRef: [boolean];
}

const buildCodexSession = (child: ChildProcess, timeoutMs: number, inactivityTimeoutMs: number): CodexSession => {
  if (!child.stdout) throw new ExecutionError('codex child process stdout not available');
  return {
    rl: createInterface({ input: child.stdout }),
    stderrChunks: attachStderrCollector(child),
    ctrl: buildKillController(child, timeoutMs, inactivityTimeoutMs),
    yieldedRef: [false],
  };
};

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

const installCodexSigintHandler = (child: ChildProcess, rl: ReturnType<typeof createInterface>): () => void => {
  const onSigint = () => {
    signalProcessTree(child, 'SIGINT');
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
