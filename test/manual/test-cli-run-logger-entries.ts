/**
 * Manual smoke test: cli-run-logger log entry format and level selection
 *
 * Run: nr test:manual -- test-cli-run-logger-entries
 *
 * Verifies:
 *   1.  logCliSpawn writes a line starting with `cli.spawn ` at DEBUG
 *   2.  logCliSpawn collapses --append-system-prompt value to `<N chars>`
 *   3.  logCliSpawn redacts --auth-token in argv=
 *   4.  logCliKill writes WARN for reason='inactivity' with reason= field
 *   5.  logCliKill skips appendToLogFile for reason='cleanup'
 *   6.  logCliRunSummary uses DEBUG when killReason=undefined, no stderr
 *   7.  logCliRunSummary uses DEBUG when killReason='cleanup', no stderr (regression guard)
 *   8.  logCliRunSummary uses WARN when killReason='inactivity'
 *   9.  logCliRunSummary uses WARN when killReason=undefined but stderr is non-empty
 *   10. logCliSpawnError writes JSON-quoted message= field
 */
import chalk from 'chalk';
import * as logFileWriter from '../../src/shared/logger/log-file-writer';
import {
  logCliKill,
  logCliRunSummary,
  logCliSpawn,
  logCliSpawnError,
  type CliRunIdentity,
} from '../../src/integrations/ai/adapters/cli-run-logger';

// ---- pass/fail counter -------------------------------------------------

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

// ---- intercept setup ---------------------------------------------------

interface Captured {
  level: string;
  line: string;
}

let captured: Captured[] = [];
const originalAppend = logFileWriter.appendToLogFile;

const installIntercept = (): void => {
  (logFileWriter as Record<string, unknown>).appendToLogFile = (
    level: string,
    line: string,
  ) => {
    captured.push({ level, line });
  };
};

const removeIntercept = (): void => {
  (logFileWriter as Record<string, unknown>).appendToLogFile = originalAppend;
};

const reset = (): void => {
  captured = [];
};

// ---- shared fixture ----------------------------------------------------

const makeIdentity = (overrides: Partial<CliRunIdentity> = {}): CliRunIdentity => ({
  runId: 'test1234',
  binary: 'claude',
  model: 'claude-opus-5',
  cwd: '/repo',
  args: ['-p'],
  envKeys: [],
  promptChars: 42,
  timeoutMs: 1_800_000,
  inactivityTimeoutMs: 120_000,
  ...overrides,
});

// ---- main --------------------------------------------------------------

function main(): void {
  console.log(chalk.bold('\ncli-run-logger entry smoke test\n'));

  installIntercept();

  try {
    // 1. logCliSpawn writes DEBUG line starting with cli.spawn
    reset();
    logCliSpawn(makeIdentity());
    assert(
      'logCliSpawn writes DEBUG entry starting with cli.spawn',
      captured.length === 1
      && captured[0].level === 'DEBUG'
      && captured[0].line.startsWith('cli.spawn '),
      `captured=${JSON.stringify(captured)}`,
    );

    // 2. logCliSpawn includes model=, cwd=, inactivityTimeoutMs=, timeoutMs=
    assert(
      'logCliSpawn line contains model=, cwd=, inactivityTimeoutMs=, timeoutMs=',
      captured.length === 1
      && /model=/.test(captured[0].line)
      && /cwd=/.test(captured[0].line)
      && /inactivityTimeoutMs=/.test(captured[0].line)
      && /timeoutMs=/.test(captured[0].line),
      `line=${captured[0]?.line}`,
    );

    // 3. logCliSpawn collapses --append-system-prompt to <N chars>
    reset();
    const longPrompt = 'x'.repeat(12043);
    logCliSpawn(makeIdentity({ args: ['--append-system-prompt', longPrompt] }));
    assert(
      'logCliSpawn collapses --append-system-prompt value to <N chars>',
      captured.length === 1
      && /argv=.*--append-system-prompt <12043 chars>/.test(captured[0].line)
      && !captured[0].line.includes(longPrompt),
      `line=${captured[0]?.line}`,
    );

    // 4. logCliSpawn redacts --auth-token
    reset();
    logCliSpawn(makeIdentity({ args: ['--auth-token', 'supersecret123'] }));
    assert(
      'logCliSpawn redacts --auth-token value in argv=',
      captured.length === 1
      && /argv=.*--auth-token <redacted>/.test(captured[0].line)
      && !captured[0].line.includes('supersecret123'),
      `line=${captured[0]?.line}`,
    );

    // 5. logCliKill writes WARN with reason=inactivity
    reset();
    logCliKill({
      runId: 'test1234',
      reason: 'inactivity',
      elapsedMs: 120_041,
      inactivityTimeoutMs: 120_000,
      timeoutMs: 1_800_000,
    });
    assert(
      'logCliKill writes WARN for reason=inactivity',
      captured.length === 1 && captured[0].level === 'WARN',
      `level=${captured[0]?.level}`,
    );
    assert(
      'logCliKill includes reason=inactivity in line',
      captured.length === 1 && /reason=inactivity/.test(captured[0].line),
      `line=${captured[0]?.line}`,
    );

    // 6. logCliKill skips appendToLogFile for reason='cleanup'
    reset();
    logCliKill({
      runId: 'test1234',
      reason: 'cleanup',
      elapsedMs: 5,
      inactivityTimeoutMs: 120_000,
      timeoutMs: 1_800_000,
    });
    assert(
      'logCliKill does not write for reason=cleanup',
      captured.length === 0,
      `captured=${JSON.stringify(captured)}`,
    );

    // 7. logCliRunSummary uses DEBUG for clean run (no killReason, no stderr)
    reset();
    logCliRunSummary({
      runId: 'test1234',
      messageCount: 10,
      elapsedMs: 5_000,
      killReason: undefined,
      stderrChunks: [],
    });
    assert(
      'logCliRunSummary uses DEBUG for clean run (killReason=undefined, no stderr)',
      captured.length === 1 && captured[0].level === 'DEBUG',
      `level=${captured[0]?.level}`,
    );

    // 8. logCliRunSummary uses DEBUG when killReason='cleanup' (regression guard)
    reset();
    logCliRunSummary({
      runId: 'test1234',
      messageCount: 10,
      elapsedMs: 5_000,
      killReason: 'cleanup',
      stderrChunks: [],
    });
    assert(
      'logCliRunSummary uses DEBUG when killReason=cleanup (regression: was WARN before fix)',
      captured.length === 1 && captured[0].level === 'DEBUG',
      `level=${captured[0]?.level}`,
    );

    // 9. logCliRunSummary uses WARN when killReason='inactivity'
    reset();
    logCliRunSummary({
      runId: 'test1234',
      messageCount: 10,
      elapsedMs: 120_210,
      killReason: 'inactivity',
      stderrChunks: [],
    });
    assert(
      'logCliRunSummary uses WARN when killReason=inactivity',
      captured.length === 1 && captured[0].level === 'WARN',
      `level=${captured[0]?.level}`,
    );

    // 10. logCliRunSummary uses WARN when stderr is non-empty (no killReason)
    reset();
    logCliRunSummary({
      runId: 'test1234',
      messageCount: 5,
      elapsedMs: 3_000,
      killReason: undefined,
      stderrChunks: [Buffer.from('something went wrong')],
    });
    assert(
      'logCliRunSummary uses WARN when stderr is non-empty (killReason=undefined)',
      captured.length === 1 && captured[0].level === 'WARN',
      `level=${captured[0]?.level}`,
    );

    // 11. logCliSpawnError uses JSON-quoted message= field
    reset();
    logCliSpawnError({ runId: 'test1234', error: new Error('spawn claude ENOENT') });
    assert(
      'logCliSpawnError includes JSON-quoted message field (quotes present around value)',
      captured.length === 1
      && /message="spawn claude ENOENT"/.test(captured[0].line),
      `line=${captured[0]?.line}`,
    );
  } finally {
    removeIntercept();
  }

  // Summary
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
