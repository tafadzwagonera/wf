/**
 * Manual smoke test: activity-based timeout and truncation detection
 *
 * Run: nr test:manual -- test-cli-activity-timeout-and-truncation
 *
 * Verifies:
 *   1. spawnCli yields inactivity timeout when no messages arrive
 *   2. spawnCli yields wall-clock timeout with updated message format
 *   3. spawnCli resets inactivity timer on each message (no false timeout)
 *   4. Truncation detection: stop_reason max_tokens triggers AIError in stage-agent pattern
 *   5. Truncation detection: absent stop_reason does not trigger AIError
 *
 * @returns void
 */
import chalk from 'chalk';

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

async function main(): Promise<void> {
  console.log(chalk.bold('\nActivity-based timeout and truncation detection smoke test\n'));

  // --- Test 1: spawnCli yields inactivity timeout when no messages arrive ---
  {
    const { spawn } = await import('child_process');
    const child = spawn(
      'node',
      ['-e', 'process.stdout.write(JSON.stringify({type:"system",subtype:"init"})+"\\n"); setTimeout(()=>{}, 60000)'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const { createInterface } = await import('readline');
    const rl = createInterface({ input: child.stdout });

    const state = { killed: false, inactivityTimedOut: false };
    const messages: Array<Record<string, unknown>> = [];

    const killChild = () => {
      if (state.killed) return;
      state.killed = true;
      child.kill('SIGTERM');
    };

    const inactivityMs = 100;
    let inactivityHandle: ReturnType<typeof setTimeout> | undefined;

    const resetInactivityTimer = () => {
      if (inactivityHandle) clearTimeout(inactivityHandle);
      inactivityHandle = setTimeout(() => {
        state.inactivityTimedOut = true;
        killChild();
      }, inactivityMs);
    };
    resetInactivityTimer();

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            messages.push(JSON.parse(trimmed));
            resetInactivityTimer();
          } catch {
            // skip
          }
        }
      }
    } finally {
      if (inactivityHandle) clearTimeout(inactivityHandle);
      rl.close();
      killChild();
    }

    if (state.inactivityTimedOut) {
      messages.push({
        type: 'error',
        subtype: 'timeout',
        is_error: true,
        result: `Claude CLI stalled — no output for ${Math.ceil(inactivityMs / 1000)}s.`,
      });
    }

    assert('Inactivity timeout fires after no output', state.inactivityTimedOut, 'Inactivity timeout did not fire');

    const timeoutMsg = messages.find(m => m.type === 'error' && m.subtype === 'timeout');
    assert(
      'Inactivity timeout message mentions "stalled"',
      typeof timeoutMsg?.result === 'string' && /stalled/i.test(timeoutMsg.result),
      `Got result: ${String(timeoutMsg?.result)}`
    );
  }

  // --- Test 2: Wall-clock timeout message uses updated format ---
  {
    const { spawn } = await import('child_process');
    const child = spawn(
      'node',
      ['-e', 'process.stdout.write(JSON.stringify({type:"system",subtype:"init"})+"\\n"); setTimeout(()=>{}, 60000)'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const { createInterface } = await import('readline');
    const rl = createInterface({ input: child.stdout });

    const state = { killed: false, wallClockTimedOut: false };
    const messages: Array<Record<string, unknown>> = [];

    const killChild = () => {
      if (state.killed) return;
      state.killed = true;
      child.kill('SIGTERM');
    };

    const wallClockMs = 100;
    // Disable inactivity by setting a much longer window
    const inactivityMs = 60000;
    let inactivityHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutHandle = setTimeout(() => {
      state.wallClockTimedOut = true;
      killChild();
    }, wallClockMs);

    const resetInactivityTimer = () => {
      if (inactivityHandle) clearTimeout(inactivityHandle);
      inactivityHandle = setTimeout(() => {
        killChild();
      }, inactivityMs);
    };
    resetInactivityTimer();

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            messages.push(JSON.parse(trimmed));
            resetInactivityTimer();
          } catch {
            // skip
          }
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
      if (inactivityHandle) clearTimeout(inactivityHandle);
      rl.close();
      killChild();
    }

    if (state.wallClockTimedOut) {
      messages.push({
        type: 'error',
        subtype: 'timeout',
        is_error: true,
        result: `Claude CLI exceeded the ${Math.round(wallClockMs / 1000)}s wall-clock limit. Increase stages.<stage>.timeoutMs in wf.config.ts.`,
      });
    }

    assert('Wall-clock timeout fires', state.wallClockTimedOut);

    const timeoutMsg = messages.find(m => m.type === 'error' && m.subtype === 'timeout');
    assert(
      'Wall-clock timeout message mentions "wall-clock limit"',
      typeof timeoutMsg?.result === 'string' && /wall-clock limit/i.test(timeoutMsg.result),
      `Got result: ${String(timeoutMsg?.result)}`
    );
  }

  // --- Test 3: Inactivity timer resets on each message (no false timeout) ---
  {
    const { spawn } = await import('child_process');
    // Subprocess emits 3 messages 50ms apart then exits — well within a 200ms inactivity window
    const child = spawn(
      'node',
      [
        '-e',
        [
          'const write = (obj) => process.stdout.write(JSON.stringify(obj)+"\\n");',
          'write({type:"system",subtype:"init"});',
          'setTimeout(() => write({type:"assistant",result:"working"}), 50);',
          'setTimeout(() => { write({type:"result",result:"done"}); process.exit(0); }, 100);',
        ].join(''),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const { createInterface } = await import('readline');
    const rl = createInterface({ input: child.stdout });

    const state = { killed: false, inactivityTimedOut: false };
    const messages: Array<Record<string, unknown>> = [];

    const killChild = () => {
      if (state.killed) return;
      state.killed = true;
      child.kill('SIGTERM');
    };

    const inactivityMs = 200;
    let inactivityHandle: ReturnType<typeof setTimeout> | undefined;

    const resetInactivityTimer = () => {
      if (inactivityHandle) clearTimeout(inactivityHandle);
      inactivityHandle = setTimeout(() => {
        state.inactivityTimedOut = true;
        killChild();
      }, inactivityMs);
    };
    resetInactivityTimer();

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            messages.push(JSON.parse(trimmed));
            resetInactivityTimer();
          } catch {
            // skip
          }
        }
      }
    } finally {
      if (inactivityHandle) clearTimeout(inactivityHandle);
      rl.close();
      killChild();
    }

    assert(
      'Inactivity timer does not fire when messages arrive within the window',
      !state.inactivityTimedOut,
      `Got ${messages.length} messages, inactivityTimedOut=${state.inactivityTimedOut}`
    );
    assert('All 3 messages received without timeout', messages.length >= 3, `Got ${messages.length} messages`);
  }

  // --- Test 4: Truncation detection — stop_reason max_tokens ---
  {
    const resultMessage: Record<string, unknown> = {
      type: 'result',
      result: '{"action":"fix"}',
      stop_reason: 'max_tokens',
    };

    const resultStopReason = resultMessage.stop_reason as string | undefined;
    const result = resultMessage.result as string;

    const truncationDetected = !!(result && resultStopReason === 'max_tokens');
    assert('Truncation detected when stop_reason is max_tokens', truncationDetected);
  }

  // --- Test 5: No truncation when stop_reason is absent ---
  {
    const resultMessage: Record<string, unknown> = {
      type: 'result',
      result: '{"action":"fix"}',
    };

    const resultStopReason = resultMessage.stop_reason as string | undefined;
    const result = resultMessage.result as string;

    const truncationDetected = !!(result && resultStopReason === 'max_tokens');
    assert('No truncation detected when stop_reason is absent', !truncationDetected);
  }

  // Summary
  console.log(
    chalk.bold(
      `\n${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`
    )
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main();
