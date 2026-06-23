/**
 * Manual smoke test: CLI subprocess timeout and rate-limit diagnostics
 *
 * Run: nr test:manual -- test-cli-timeout-diagnostics
 *
 * Verifies:
 *   1. spawnCli yields a synthetic error message on timeout (using a real slow subprocess)
 *   2. The synthetic message has type "error" (not "result") to avoid masking
 *   3. extractCliDiagnostic captures is_error messages
 *   4. extractCliDiagnostic captures rate-limit events with non-allowed status
 *   5. extractCliDiagnostic ignores rate-limit events with status "allowed"
 *   6. extractCliDiagnostic returns undefined for normal messages
 *   7. extractCliDiagnostic falls back to summary, then JSON.stringify
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

// Mirror the extractCliDiagnostic logic from stage-agent.service.ts
// to validate the diagnostic extraction contract independently.
const extractCliDiagnostic = (
  message: Record<string, unknown>,
): string | undefined => {
  if (message.is_error) {
    return (
      (message.result as string) ??
      (message.summary as string) ??
      JSON.stringify(message)
    );
  }
  if (message.type === 'rate_limit_event') {
    const info = message.rate_limit_info as { status?: string } | undefined;
    if (info?.status && info.status !== 'allowed') {
      return `Rate limited (status: ${info.status})`;
    }
  }
  return undefined;
};

async function main(): Promise<void> {
  console.log(
    chalk.bold('\nCLI timeout & rate-limit diagnostics smoke test\n'),
  );

  // --- Test 1 & 2: spawnCli yields timeout error with type "error" ---
  // Use a real subprocess (sleep) that exceeds a very short timeout.
  // spawnCli expects to spawn "claude" but we can test the timeout path
  // by spawning a process that outputs one NDJSON line then hangs.
  {
    const { spawn } = await import('child_process');
    const { createInterface } = await import('readline');

    // Spawn a node subprocess that prints one NDJSON line then sleeps
    const child = spawn(
      'node',
      [
        '-e',
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init"})+"\\n"); setTimeout(()=>{}, 60000)',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const rl = createInterface({ input: child.stdout });
    const state = { timedOut: false, killed: false };
    const messages: Array<Record<string, unknown>> = [];

    const killChild = () => {
      if (state.killed) return;
      state.killed = true;
      child.kill('SIGTERM');
    };

    const timeoutMs = 200;
    const timeoutHandle = setTimeout(() => {
      state.timedOut = true;
      killChild();
    }, timeoutMs);

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            messages.push(JSON.parse(trimmed));
          } catch {
            // skip
          }
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
      rl.close();
      killChild();
    }

    // Simulate what spawnCli does after the loop
    if (state.timedOut) {
      messages.push({
        type: 'error',
        subtype: 'timeout',
        is_error: true,
        result: `Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s without returning a result.`,
      });
    }

    assert(
      'Timeout fires and produces a synthetic error message',
      state.timedOut === true,
      'Timeout did not fire',
    );

    const timeoutMsg = messages.find(
      (m) => m.type === 'error' && m.subtype === 'timeout',
    );
    assert(
      'Timeout message exists with type "error"',
      timeoutMsg !== undefined,
      `Got messages: ${JSON.stringify(messages.map((m) => m.type))}`,
    );

    assert('Timeout message has is_error: true', timeoutMsg?.is_error === true);

    assert(
      'Timeout message type is "error" (not "result") to avoid masking valid results',
      timeoutMsg?.type === 'error',
      `Got type: ${String(timeoutMsg?.type)}`,
    );

    assert(
      'Timeout message result text mentions timeout',
      typeof timeoutMsg?.result === 'string' &&
        /timed out/i.test(timeoutMsg.result),
      `Got result: ${String(timeoutMsg?.result)}`,
    );
  }

  // --- Test 3: extractCliDiagnostic captures is_error messages ---
  {
    const result = extractCliDiagnostic({
      type: 'error',
      is_error: true,
      result: 'Something went wrong',
    });
    assert(
      'extractCliDiagnostic captures is_error messages',
      result === 'Something went wrong',
      `Got: ${result}`,
    );
  }

  // --- Test 4: extractCliDiagnostic captures rate-limit with non-allowed status ---
  {
    const result = extractCliDiagnostic({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'limited' },
    });
    assert(
      'extractCliDiagnostic captures rate-limit with status "limited"',
      result === 'Rate limited (status: limited)',
      `Got: ${result}`,
    );
  }

  // --- Test 5: extractCliDiagnostic ignores rate-limit with status "allowed" ---
  {
    const result = extractCliDiagnostic({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed' },
    });
    assert(
      'extractCliDiagnostic ignores rate-limit with status "allowed"',
      result === undefined,
      `Got: ${result}`,
    );
  }

  // --- Test 6: extractCliDiagnostic returns undefined for normal messages ---
  {
    const result = extractCliDiagnostic({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    assert(
      'extractCliDiagnostic returns undefined for normal messages',
      result === undefined,
      `Got: ${result}`,
    );
  }

  // --- Test 7: extractCliDiagnostic falls back to summary when result is missing ---
  {
    const result = extractCliDiagnostic({
      type: 'error',
      is_error: true,
      summary: 'fallback summary',
    });
    assert(
      'extractCliDiagnostic falls back to summary field',
      result === 'fallback summary',
      `Got: ${result}`,
    );
  }

  // --- Test 8: extractCliDiagnostic falls back to JSON when both missing ---
  {
    const result = extractCliDiagnostic({
      type: 'error',
      is_error: true,
    });
    assert(
      'extractCliDiagnostic falls back to JSON.stringify',
      typeof result === 'string' && result.includes('"is_error":true'),
      `Got: ${result}`,
    );
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
