import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline';
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
}

const CLI_TIMEOUT_MS = 10 * 60 * 1000;

const CODEX_ERROR_LINE_PATTERN = /^ERROR:\s*(.+)$/;

/**
 * Extracts meaningful error messages from Codex CLI stderr noise.
 *
 * @param stderr - Raw stderr output from the Codex CLI
 * @returns Extracted error message(s) or full stderr if no `ERROR:` lines found
 */
export const extractCodexErrorMessages = (stderr: string): string => {
  const errorLines = stderr
    .split('\n')
    .map(line => line.match(CODEX_ERROR_LINE_PATTERN)?.[1])
    .filter((match): match is string => match !== undefined);

  if (errorLines.length === 0) {
    return stderr;
  }

  const messages = errorLines.map(raw => {
    try {
      const parsed = JSON.parse(raw);
      return parsed?.error?.message ?? raw;
    } catch {
      return raw;
    }
  });

  const unique = [...new Set(messages)];
  return unique.join('; ');
};
const SIGKILL_GRACE_MS = 5000;
const REQUIRED_CODEX_CLI_MAJOR = 0;
const REQUIRED_CODEX_CLI_MIN_MINOR = 142;
const SKIP_VERSION_CHECK_ENV = 'WF_SKIP_CLI_VERSION_CHECK';

/**
 * Parses a `codex --version` output string into major/minor/patch components.
 * Returns null when the string does not contain a recognisable semver triple.
 *
 * @param raw - Raw stdout from `codex --version` (e.g. "codex-cli 0.142.5")
 * @returns Parsed version object, or null if the format is unrecognisable
 */
export const parseCodexCliVersion = (raw: string): { major: number; minor: number; patch: number } | null => {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

/**
 * Asserts that the Codex CLI binary is installed and meets the minimum version requirement.
 * Throws with install/upgrade instructions when the binary is missing or incompatible.
 * Set WF_SKIP_CLI_VERSION_CHECK=1 to bypass the version check (e.g. in CI).
 */
export const assertCodexCliAvailable = (): void => {
  try {
    execSync('command -v codex', { stdio: 'pipe' });
  } catch {
    throw new Error('Codex CLI is not installed. Install it by following: https://github.com/openai/codex');
  }

  if (process.env[SKIP_VERSION_CHECK_ENV] === '1') return;

  let raw: string;
  try {
    raw = execSync('codex --version', { stdio: 'pipe', encoding: 'utf-8' });
  } catch {
    throw new Error('Codex CLI version check failed. Run `codex --version` to diagnose.');
  }

  const version = parseCodexCliVersion(raw);
  if (!version) {
    throw new Error(
      `Unrecognised Codex CLI version format: "${raw.trim()}". ` +
        `Set ${SKIP_VERSION_CHECK_ENV}=1 to bypass this check.`
    );
  }

  if (version.major !== REQUIRED_CODEX_CLI_MAJOR) {
    throw new Error(
      `Incompatible Codex CLI version ${version.major}.${version.minor}.${version.patch}. ` +
        `Required: major=${REQUIRED_CODEX_CLI_MAJOR} (>=${REQUIRED_CODEX_CLI_MAJOR}.${REQUIRED_CODEX_CLI_MIN_MINOR}). ` +
        `Upgrade: npm install -g @openai/codex@latest. ` +
        `Or set ${SKIP_VERSION_CHECK_ENV}=1 to bypass.`
    );
  }

  if (version.minor < REQUIRED_CODEX_CLI_MIN_MINOR) {
    throw new Error(
      `Codex CLI version ${version.major}.${version.minor}.${version.patch} is too old. ` +
        `Required: >=${REQUIRED_CODEX_CLI_MAJOR}.${REQUIRED_CODEX_CLI_MIN_MINOR}. ` +
        `Upgrade: npm install -g @openai/codex@latest. ` +
        `Or set ${SKIP_VERSION_CHECK_ENV}=1 to bypass.`
    );
  }
};

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
    // Resume existing session
    const args = ['exec', '--json', 'resume', params.sessionId];
    if (params.model) args.push('--model', params.model);
    return args;
  }

  const args: string[] = ['exec', '--json'];

  if (params.model) {
    args.push('--model', params.model);
  }

  if (params.permissionMode === 'full-auto') {
    args.push('--full-auto');
  }

  return args;
};

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
export async function* spawnCodex(
  args: string[],
  cwd: string,
  prompt?: string,
  env?: Record<string, string>,
  timeoutMs: number = CLI_TIMEOUT_MS
): AsyncGenerator<CodexCliMessage, void, undefined> {
  const child = spawn('codex', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (prompt) {
    child.stdin.write(prompt);
    child.stdin.end();
  }

  const rl = createInterface({ input: child.stdout });
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let killed = false;
  let yieldedAny = false;
  let timedOut = false;

  const killChild = () => {
    if (killed) return;
    killed = true;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, SIGKILL_GRACE_MS);
  };

  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
  }

  try {
    for await (const line of rl) {
      const message = parseNdjsonLine(line) as CodexCliMessage | null;
      if (message) {
        yieldedAny = true;
        yield message;
      }
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    rl.close();
    killChild();
  }

  if (timedOut) {
    yield {
      type: 'error',
      subtype: 'timeout',
      is_error: true,
      result: `Codex CLI timed out after ${Math.round(timeoutMs / 1000)}s without returning a result.`,
    };
    return;
  }

  if (!yieldedAny && stderrChunks.length > 0) {
    const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
    if (stderr) {
      const extractedError = extractCodexErrorMessages(stderr);
      throw new Error(`Codex CLI failed: ${extractedError}`);
    }
  }
}
