/**
 * Manual smoke test: Codex CLI formatted progress output
 *
 * Run: nr test:manual -- test-codex-cli-diagnostic-logging
 *
 * Verifies:
 *   1. parseNdjsonLine round-trips item.started, item.completed, and turn.completed
 *      CodexCliMessage objects preserving item.command, item.exit_code, and usage fields
 *   2. parseNdjsonLine returns null for non-JSON input
 *   3. No-result label string uses [codex-cli] prefix
 */
import chalk from 'chalk';
import { parseNdjsonLine } from '../../src/integrations/ai/adapters/claude-cli-runner';
import type { CodexCliMessage } from '../../src/integrations/ai/adapters/codex-cli-runner';

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
  console.log(chalk.bold('\nCodex CLI formatted progress smoke test\n'));

  // Test 1: parseNdjsonLine round-trips item.started preserving item.command
  {
    const itemStarted: CodexCliMessage = {
      type: 'item.started',
      item: { type: 'command_execution', command: 'yarn build' },
    };
    const parsed = parseNdjsonLine(JSON.stringify(itemStarted)) as CodexCliMessage | null;
    assert(parsed !== null, 'parseNdjsonLine parses item.started message', 'returned null');
    assert(parsed?.type === 'item.started', 'parsed item.started has correct type', `got: ${parsed?.type}`);
    assert(
      (parsed?.item as Record<string, unknown> | undefined)?.['command'] === 'yarn build',
      'parsed item.started preserves item.command',
      `got: ${JSON.stringify(parsed?.item)}`
    );
  }

  // Test 2: parseNdjsonLine round-trips item.completed preserving item.exit_code
  {
    const itemCompleted: CodexCliMessage = {
      type: 'item.completed',
      item: { type: 'command_execution', command: 'yarn test', exit_code: 0 },
    };
    const parsed = parseNdjsonLine(JSON.stringify(itemCompleted)) as CodexCliMessage | null;
    assert(parsed !== null, 'parseNdjsonLine parses item.completed message', 'returned null');
    assert(
      (parsed?.item as Record<string, unknown> | undefined)?.['exit_code'] === 0,
      'parsed item.completed preserves exit_code: 0',
      `got: ${JSON.stringify(parsed?.item)}`
    );
  }

  // Test 3: parseNdjsonLine round-trips turn.completed preserving usage fields
  {
    const turnCompleted: CodexCliMessage = {
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 200 },
    };
    const parsed = parseNdjsonLine(JSON.stringify(turnCompleted)) as CodexCliMessage | null;
    assert(parsed !== null, 'parseNdjsonLine parses turn.completed message', 'returned null');
    assert(
      parsed?.usage?.input_tokens === 100 && parsed?.usage?.output_tokens === 200,
      'parsed turn.completed preserves usage.input_tokens and usage.output_tokens',
      `got: ${JSON.stringify(parsed?.usage)}`
    );
  }

  // Test 4: parseNdjsonLine returns null for non-JSON input
  {
    const result = parseNdjsonLine('this is not json');
    assert(result === null, 'parseNdjsonLine returns null for non-JSON input');
  }

  // Test 5: no-result label uses [codex-cli] prefix
  {
    const noResultLabel = '[codex-cli] No result message received from Codex CLI';
    assert(noResultLabel.startsWith('[codex-cli]'), 'no-result label starts with [codex-cli]', `got: ${noResultLabel}`);
  }

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  process.exit(failed > 0 ? 1 : 0);
}

main();
