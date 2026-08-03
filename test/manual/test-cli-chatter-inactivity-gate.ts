/**
 * Manual smoke test: inactivity timer ignores system chatter messages
 *
 * Run: nr test:manual -- test-cli-chatter-inactivity-gate
 *
 * Verifies:
 *   1. isSystemChatter returns true for rate_limit_event
 *   2. isSystemChatter returns true for system/status
 *   3. isSystemChatter returns true for system/compact_boundary
 *   4. isSystemChatter returns true for system/api_retry
 *   5. isSystemChatter returns false for system/init (meaningful progress)
 *   6. isSystemChatter returns false for assistant messages
 *   7. isSystemChatter returns false for result messages
 *   8. isSystemChatter returns false for error messages
 *   9. isSystemChatter returns false for unknown future types (deny-list default)
 *   10. Chatter-only NDJSON stream triggers inactivity timeout (live child process)
 *   11. Progress NDJSON stream does not trigger inactivity timeout (live child process)
 *
 * @returns void
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import * as path from 'path';
import chalk from 'chalk';
import {
  isSystemChatter,
  parseNdjsonLine,
  type ClaudeCliMessage,
} from '../../src/integrations/ai/adapters/claude-cli-runner';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  \u2717 ${message}`));
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

/**
 * Spawns a node child that writes NDJSON lines to stdout with controlled
 * timing, then processes them through the real parseNdjsonLine + isSystemChatter
 * pipeline. Returns whether the inactivity timer would have fired.
 *
 * @param lines - NDJSON strings the child writes to stdout
 * @param delayMs - Delay between lines in milliseconds
 * @param inactivityMs - Simulated inactivity timeout window in milliseconds
 * @param hangAfterWrite - When true the child stays alive after writing, letting the timer fire
 * @returns True when the inactivity timer would have fired (no progress resets)
 */
const runTimerSimulation = (
  lines: string[],
  delayMs: number,
  inactivityMs: number,
  hangAfterWrite: boolean,
): Promise<boolean> =>
  new Promise(resolve => {
    const escaped = JSON.stringify(lines);
    const afterWrite = hangAfterWrite
      ? `setTimeout(() => process.exit(0), ${inactivityMs + 200});`
      : `process.exit(0);`;
    const script = [
      `const lines = ${escaped};`,
      `let i = 0;`,
      `const tick = () => {`,
      `  if (i < lines.length) { process.stdout.write(lines[i] + '\\n'); i++; setTimeout(tick, ${delayMs}); }`,
      `  else { ${afterWrite} }`,
      `};`,
      `tick();`,
    ].join(' ');

    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const rl = createInterface({ input: child.stdout });

    let lastResetAt = Date.now();
    let timedOut = false;
    const checkInterval = setInterval(() => {
      if (Date.now() - lastResetAt >= inactivityMs) {
        timedOut = true;
        clearInterval(checkInterval);
        child.kill();
        rl.close();
      }
    }, 10);

    rl.on('line', (line: string) => {
      const message = parseNdjsonLine(line);
      if (message && !isSystemChatter(message)) {
        lastResetAt = Date.now();
      }
    });

    child.on('close', () => {
      clearInterval(checkInterval);
      resolve(timedOut);
    });
  });

async function main(): Promise<void> {
  console.log(chalk.bold('\nSystem chatter inactivity gate smoke test\n'));

  // 1-4: chatter messages return true
  const chatterCases: Array<{ label: string; msg: ClaudeCliMessage }> = [
    { label: 'rate_limit_event', msg: { type: 'rate_limit_event' } as ClaudeCliMessage },
    { label: 'system/status', msg: { type: 'system', subtype: 'status' } as ClaudeCliMessage },
    { label: 'system/compact_boundary', msg: { type: 'system', subtype: 'compact_boundary' } as ClaudeCliMessage },
    { label: 'system/api_retry', msg: { type: 'system', subtype: 'api_retry' } as ClaudeCliMessage },
  ];

  for (const { label, msg } of chatterCases) {
    assert(`isSystemChatter returns true for ${label}`, isSystemChatter(msg) === true);
  }

  // 5-9: progress messages return false
  const progressCases: Array<{ label: string; msg: ClaudeCliMessage }> = [
    { label: 'system/init (meaningful progress)', msg: { type: 'system', subtype: 'init' } as ClaudeCliMessage },
    { label: 'assistant', msg: { type: 'assistant' } as ClaudeCliMessage },
    { label: 'result', msg: { type: 'result' } as ClaudeCliMessage },
    { label: 'error', msg: { type: 'error' } as ClaudeCliMessage },
    { label: 'unknown_future_type (deny-list default)', msg: { type: 'unknown_future_type' } as ClaudeCliMessage },
  ];

  for (const { label, msg } of progressCases) {
    assert(`isSystemChatter returns false for ${label}`, isSystemChatter(msg) === false);
  }

  // 10: chatter-only stream triggers inactivity timeout
  console.log(chalk.bold('\n  Live child process: chatter-only stream'));
  const chatterLines = [
    '{"type":"system","subtype":"status"}',
    '{"type":"rate_limit_event"}',
    '{"type":"system","subtype":"compact_boundary"}',
    '{"type":"system","subtype":"api_retry"}',
  ];
  const chatterTimedOut = await runTimerSimulation(chatterLines, 40, 150, true);
  assert(
    'chatter-only stream triggers inactivity timeout',
    chatterTimedOut,
    'expected timer to fire because chatter should not reset it',
  );

  // 11: progress stream does NOT trigger inactivity timeout
  console.log(chalk.bold('\n  Live child process: progress stream'));
  const progressLines = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","result":"working"}',
    '{"type":"result","result":"done"}',
  ];
  const progressTimedOut = await runTimerSimulation(progressLines, 40, 150, false);
  assert(
    'progress stream does not trigger inactivity timeout',
    !progressTimedOut,
    'expected timer NOT to fire because progress messages should reset it',
  );

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
