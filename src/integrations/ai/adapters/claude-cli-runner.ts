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
  files?: Array<{ filename: string }>;
  summary?: string;
  rate_limit_info?: { status?: string; resetsAt?: number };
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

/**
 * Asserts that the Claude CLI binary is available on the system PATH.
 * Throws with install instructions when missing.
 */
export const assertClaudeCliAvailable = (): void => {
  try {
    execSync('command -v claude', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Claude CLI is not installed. Install it by following: https://docs.anthropic.com/en/docs/claude-code'
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
 * @param timeoutMs - Subprocess timeout in milliseconds (default: 10 minutes)
 * @returns Async generator yielding `ClaudeCliMessage` objects
 */
export async function* spawnCli(
  args: string[],
  cwd: string,
  prompt?: string,
  env?: Record<string, string>,
  timeoutMs: number = CLI_TIMEOUT_MS
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
      const message = parseNdjsonLine(line);
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
      result: `Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s without returning a result.`,
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
