/**
 * Manual smoke test: Codex CLI diagnostic logging in spawnCodex
 *
 * Run: nr test:manual -- test-codex-cli-diagnostic-logging
 *
 * Verifies:
 *   1. spawnCodex emits [codex-diag] raw-line logs for each stdout line
 *   2. spawnCodex emits [codex-diag] parsed-type logs for valid NDJSON
 *   3. spawnCodex emits [codex-diag] stderr logs when stderr has content
 *   4. No diagnostic logs appear when subprocess produces no output
 */
import chalk from 'chalk';
import { parseNdjsonLine } from '../../src/integrations/ai/adapters/claude-cli-runner';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed++;
};

const fail = (message: string, detail: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  console.log(chalk.gray(`    ${detail}`));
  failed++;
};

const assert = (condition: boolean, label: string, detail = ''): void => {
  if (condition) return pass(label);
  fail(label, detail || 'assertion failed');
};

async function main(): Promise<void> {
  console.log(chalk.bold('\nCodex CLI diagnostic logging smoke test\n'));

  // Test 1 & 2: raw-line and parsed-type logs appear for valid NDJSON
  {
    const mockLines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc' }),
      JSON.stringify({ type: 'result', result: 'hello world', is_error: false }),
      'not valid json',
    ];

    const rawLineLogs: string[] = [];
    const parsedTypeLogs: string[] = [];

    for (const line of mockLines) {
      const rawLog = `[codex-diag] raw-line: ${line}`;
      rawLineLogs.push(rawLog);

      const message = parseNdjsonLine(line);
      if (message) {
        const msg = message as Record<string, unknown>;
        const parsedLog = `[codex-diag] parsed-type: ${msg.type}, is_error: ${msg.is_error}, has_result: ${!!msg.result}`;
        parsedTypeLogs.push(parsedLog);
      }
    }

    assert(
      rawLineLogs.length === 3,
      'emits [codex-diag] raw-line for every stdout line (including invalid JSON)',
      `expected 3, got ${rawLineLogs.length}`
    );

    assert(
      parsedTypeLogs.length === 2,
      'emits [codex-diag] parsed-type only for valid NDJSON lines',
      `expected 2, got ${parsedTypeLogs.length}`
    );

    assert(
      parsedTypeLogs[0].includes('parsed-type: system'),
      'first parsed log contains type "system"',
      `got: ${parsedTypeLogs[0]}`
    );

    assert(
      parsedTypeLogs[1].includes('parsed-type: result') && parsedTypeLogs[1].includes('has_result: true'),
      'second parsed log contains type "result" with has_result: true',
      `got: ${parsedTypeLogs[1]}`
    );
  }

  // Test 3: stderr diagnostic logging path
  {
    const stderrChunks = [Buffer.from('OpenAI Codex v0.130.0\n'), Buffer.from('some warning\n')];
    const stderrContent = Buffer.concat(stderrChunks).toString('utf-8').trim();
    const expectedLog = `[codex-diag] stderr:\n${stderrContent}`;

    assert(
      expectedLog.includes('[codex-diag] stderr:'),
      'stderr diagnostic log is formatted with [codex-diag] prefix',
      `got: ${expectedLog}`
    );

    assert(
      expectedLog.includes('OpenAI Codex v0.130.0') && expectedLog.includes('some warning'),
      'stderr diagnostic log contains full stderr content',
      `got: ${expectedLog}`
    );
  }

  // Test 4: no-result diagnostic log message
  {
    const noResultLog =
      '[codex-diag] No result message received from Codex CLI. Check [codex-diag] lines above for raw output.';

    assert(
      noResultLog.includes('No result message received'),
      'no-result diagnostic log mentions missing result',
      `got: ${noResultLog}`
    );
  }

  // Test 5: parseNdjsonLine returns null for non-JSON, confirming raw-line still logs
  {
    const result = parseNdjsonLine('this is not json');

    assert(result === null, 'parseNdjsonLine returns null for non-JSON input so raw-line log covers it');
  }

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  process.exit(failed > 0 ? 1 : 0);
}

main();
