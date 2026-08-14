/**
 * Manual smoke test: implement stage timeout forwarding in ClaudeCliAdapter
 *
 * Run: nr test:manual -- test-implement-timeout-forwarding
 *
 * Verifies:
 *   1. When stages.implement.timeoutMs / inactivityTimeoutMs are set in config,
 *      spawnCli receives them as arg[4] and arg[5].
 *   2. When neither key is set, spawnCli falls back to CLI_TIMEOUT_MS and
 *      CLI_INACTIVITY_TIMEOUT_MS from claude-cli-runner.
 *   3. The initial run path (runCliSession / openImplementStream) forwards timeouts.
 *   4. The continuation path (runSinglePass) forwards the same timeouts.
 *
 * @returns void
 */
import chalk from 'chalk';
import { ClaudeCliAdapter } from '../../src/integrations/ai/adapters/claude-cli.adapter';
import * as cliRunner from '../../src/integrations/ai/adapters/claude-cli-runner';
import { CLI_TIMEOUT_MS, CLI_INACTIVITY_TIMEOUT_MS } from '../../src/integrations/ai/adapters/claude-cli-runner';

const originalAssert = cliRunner.assertClaudeCliAvailable;
const originalBuild = cliRunner.buildCliArgs;
const originalSpawn = cliRunner.spawnCli;

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
};

const makeParams = (repoFiles: string[] = []) => ({
  ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
  planArtifact: {
    plan: {
      action: 'feature' as const,
      summary: 'test',
      steps: ['step 1'],
      estimatedComplexity: 'low' as const,
      affectedFiles: [],
      affectedRepositories: [],
      risks: [],
    },
    action: 'feature' as const,
    path: '/tmp/p.json',
  },
  options: { trackerName: 'jira', repoDir: '/tmp/smoke-repo' },
  verificationScripts: [],
  repoFiles,
  repoName: 'repo',
  trackedFilePaths: [],
});

type CapturedCall = unknown[];

/**
 * Runs generateAndVerify with a custom configService mock, capturing every spawnCli
 * invocation's argument list.  Console output is suppressed to keep test output clean.
 *
 * @param configGet - Implementation for ConfigService.get(key, fallback)
 * @param repoFiles - Planned files list; non-empty triggers the continuation path
 * @returns Array of argument lists, one per spawnCli call
 */
async function runAndCapture(
  configGet: (key: string, fallback?: unknown) => unknown,
  repoFiles: string[] = [],
): Promise<CapturedCall[]> {
  const capturedCalls: CapturedCall[] = [];
  let callIndex = 0;

  (cliRunner as Record<string, unknown>).assertClaudeCliAvailable = () => undefined;
  (cliRunner as Record<string, unknown>).buildCliArgs = () => ['-p', '--output-format', 'stream-json'];
  (cliRunner as Record<string, unknown>).spawnCli = async function* (...args: unknown[]) {
    capturedCalls.push(args);
    const idx = callIndex++;
    if (idx === 0) {
      // Initial run: return a result with session_id so the continuation loop can run
      yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1 };
    } else {
      // Continuation pass: touch the planned file so the loop exits
      yield {
        type: 'result',
        result: 'done',
        session_id: 's1',
        num_turns: 1,
        files: [{ filename: 'src/foo.ts' }],
      };
    }
  };

  const mockConfigService = { get: configGet };
  const adapter = new ClaudeCliAdapter(mockConfigService as never);

  // Suppress console.log during the adapter run to avoid noise
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    await adapter.generateAndVerify(makeParams(repoFiles));
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    (cliRunner as Record<string, unknown>).assertClaudeCliAvailable = originalAssert;
    (cliRunner as Record<string, unknown>).buildCliArgs = originalBuild;
    (cliRunner as Record<string, unknown>).spawnCli = originalSpawn;
  }

  return capturedCalls;
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nImplement timeout forwarding smoke test\n'));

  // ── Test 1: custom timeouts on initial run ──────────────────────────────────
  {
    const calls = await runAndCapture((key: string, fallback?: unknown) => {
      if (key === 'stages.implement.timeoutMs') return 1_800_000;
      if (key === 'stages.implement.inactivityTimeoutMs') return 600_000;
      return fallback;
    });

    assert(
      'Initial run: spawnCli called at least once with custom timeouts',
      calls.length >= 1,
      `Expected ≥1 call, got ${calls.length}`,
    );

    if (calls.length >= 1) {
      assert(
        'Initial run: arg[4] is the configured timeoutMs (1 800 000)',
        calls[0][4] === 1_800_000,
        `arg[4] = ${String(calls[0][4])}, expected 1800000`,
      );
      assert(
        'Initial run: arg[5] is the configured inactivityTimeoutMs (600 000)',
        calls[0][5] === 600_000,
        `arg[5] = ${String(calls[0][5])}, expected 600000`,
      );
    }
  }

  // ── Test 2: default timeouts when config keys absent ───────────────────────
  {
    const calls = await runAndCapture((_key: string, fallback?: unknown) => fallback);

    assert(
      'Default timeouts: spawnCli called at least once',
      calls.length >= 1,
      `Expected ≥1 call, got ${calls.length}`,
    );

    if (calls.length >= 1) {
      assert(
        `Default timeouts: arg[4] falls back to CLI_TIMEOUT_MS (${CLI_TIMEOUT_MS})`,
        calls[0][4] === CLI_TIMEOUT_MS,
        `arg[4] = ${String(calls[0][4])}, expected ${CLI_TIMEOUT_MS}`,
      );
      assert(
        `Default timeouts: arg[5] falls back to CLI_INACTIVITY_TIMEOUT_MS (${CLI_INACTIVITY_TIMEOUT_MS})`,
        calls[0][5] === CLI_INACTIVITY_TIMEOUT_MS,
        `arg[5] = ${String(calls[0][5])}, expected ${CLI_INACTIVITY_TIMEOUT_MS}`,
      );
    }
  }

  // ── Test 3: custom timeouts on continuation pass (runSinglePass) ────────────
  {
    // Provide a non-empty repoFiles list so the continuation loop fires once.
    // 'repo/src/foo.ts' → stripRepoPrefix → 'src/foo.ts'; the second spawnCli
    // mock above yields files: [{ filename: 'src/foo.ts' }] which marks it touched
    // so the loop exits after a single continuation pass.
    const calls = await runAndCapture(
      (key: string, fallback?: unknown) => {
        if (key === 'stages.implement.timeoutMs') return 1_800_000;
        if (key === 'stages.implement.inactivityTimeoutMs') return 600_000;
        return fallback;
      },
      ['repo/src/foo.ts'],
    );

    assert(
      'Continuation path: spawnCli called at least twice (initial + one pass)',
      calls.length >= 2,
      `Expected ≥2 calls, got ${calls.length}`,
    );

    if (calls.length >= 2) {
      assert(
        'Continuation path: arg[4] on second call is the configured timeoutMs (1 800 000)',
        calls[1][4] === 1_800_000,
        `arg[4] = ${String(calls[1][4])}, expected 1800000`,
      );
      assert(
        'Continuation path: arg[5] on second call is the configured inactivityTimeoutMs (600 000)',
        calls[1][5] === 600_000,
        `arg[5] = ${String(calls[1][5])}, expected 600000`,
      );
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(
    chalk.bold(
      `\n${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`,
    ),
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main();
