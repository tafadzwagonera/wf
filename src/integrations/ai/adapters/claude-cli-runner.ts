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

/**
 * Parses a `claude --version` output string into major/minor/patch components.
 * Returns null when the string does not contain a recognisable semver triple.
 *
 * @param raw - Raw stdout from `claude --version` (e.g. "2.1.80 (Claude Code)")
 * @returns Parsed version object, or null if the format is unrecognisable
 */
export const parseClaudeCliVersion = (raw: string): { major: number; minor: number; patch: number } | null => {
  const match = raw.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

/**
 * Asserts that the Claude CLI binary is installed and meets the minimum version requirement.
 * Throws with install/upgrade instructions when the binary is missing or incompatible.
 * Set WF_SKIP_CLI_VERSION_CHECK=1 to bypass the version check (e.g. in CI).
 */
export const assertClaudeCliAvailable = (): void => {
  try {
    execSync('command -v claude', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Claude CLI is not installed. Install it by following: https://docs.anthropic.com/en/docs/claude-code'
    );
  }

  if (process.env[SKIP_VERSION_CHECK_ENV] === '1') return;

  let raw: string;
  try {
    raw = execSync('claude --version', { stdio: 'pipe', encoding: 'utf-8' });
  } catch {
    throw new Error('Claude CLI version check failed. Run `claude --version` to diagnose.');
  }

  const version = parseClaudeCliVersion(raw);
  if (!version) {
    throw new Error(
      `Unrecognised Claude CLI version format: "${raw.trim()}". ` +
        `Set ${SKIP_VERSION_CHECK_ENV}=1 to bypass this check.`
    );
  }

  if (version.major !== REQUIRED_CLAUDE_CLI_MAJOR) {
    throw new Error(
      `Incompatible Claude CLI version ${version.major}.${version.minor}.${version.patch}. ` +
        `Required: major=${REQUIRED_CLAUDE_CLI_MAJOR} (>=${REQUIRED_CLAUDE_CLI_MAJOR}.${REQUIRED_CLAUDE_CLI_MIN_MINOR}). ` +
        `Upgrade: npm install -g @anthropic-ai/claude-code@latest. ` +
        `Or set ${SKIP_VERSION_CHECK_ENV}=1 to bypass.`
    );
  }

  if (version.minor < REQUIRED_CLAUDE_CLI_MIN_MINOR) {
    throw new Error(
      `Claude CLI version ${version.major}.${version.minor}.${version.patch} is too old. ` +
        `Required: >=${REQUIRED_CLAUDE_CLI_MAJOR}.${REQUIRED_CLAUDE_CLI_MIN_MINOR}. ` +
        `Upgrade: npm install -g @anthropic-ai/claude-code@latest. ` +
        `Or set ${SKIP_VERSION_CHECK_ENV}=1 to bypass.`
    );
  }
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

  if (params.permissionMode) {
    args.push('--permission-mode', params.permissionMode);
  }

  if (params.appendSystemPrompt) {
    args.push('--append-system-prompt', params.appendSystemPrompt);
  }

  if (params.sessionId) {
    args.push('--resume', params.sessionId);
  }

  if (params.tools && params.tools.length > 0) {
    args.push('--allowedTools', params.tools.join(','));
  }

  if (params.addDirs) {
    for (const dir of params.addDirs) {
      args.push('--add-dir', dir);
    }
  }

  if (params.jsonSchema) {
    args.push('--json-schema', params.jsonSchema);
  }

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
  args: string[],
  cwd: string,
  prompt?: string,
  env?: Record<string, string>,
  timeoutMs: number = CLI_TIMEOUT_MS,
  inactivityTimeoutMs: number = CLI_INACTIVITY_TIMEOUT_MS
): AsyncGenerator<ClaudeCliMessage, void, undefined> {
  const child = spawn('claude', args, {
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
  let inactivityHandle: ReturnType<typeof setTimeout> | undefined;
  let killed = false;
  let yieldedAny = false;
  let wallClockTimedOut = false;
  let inactivityTimedOut = false;

  const killChild = () => {
    if (killed) return;
    killed = true;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, SIGKILL_GRACE_MS).unref();
  };

  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      wallClockTimedOut = true;
      killChild();
    }, timeoutMs);
  }

  // Inactivity timer — reset on each yielded message
  const resetInactivityTimer = () => {
    if (inactivityHandle) clearTimeout(inactivityHandle);
    if (inactivityTimeoutMs > 0) {
      inactivityHandle = setTimeout(() => {
        inactivityTimedOut = true;
        killChild();
      }, inactivityTimeoutMs);
    }
  };
  resetInactivityTimer();

  try {
    for await (const line of rl) {
      const message = parseNdjsonLine(line);
      if (message) {
        yieldedAny = true;
        yield message;
        resetInactivityTimer();
      }
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (inactivityHandle) clearTimeout(inactivityHandle);
    rl.close();
    killChild();
  }

  if (inactivityTimedOut) {
    yield {
      type: 'error',
      subtype: 'timeout',
      is_error: true,
      result: `Claude CLI stalled — no output for ${Math.ceil(inactivityTimeoutMs / 1000)}s.`,
    };
    return;
  }

  if (wallClockTimedOut) {
    yield {
      type: 'error',
      subtype: 'timeout',
      is_error: true,
      result: `Claude CLI exceeded the ${Math.round(timeoutMs / 1000)}s wall-clock limit. Increase stages.<stage>.timeoutMs in wf.config.ts.`,
    };
    return;
  }

  if (!yieldedAny && stderrChunks.length > 0) {
    const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
    if (stderr) {
      throw new Error(`Claude CLI failed to produce output: ${stderr}`);
    }
  }
}
