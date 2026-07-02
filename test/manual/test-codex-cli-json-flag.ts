/**
 * Manual smoke test: Codex CLI --json flag in buildCodexCliArgs
 *
 * Run: nr test:manual -- test-codex-cli-json-flag
 *
 * Verifies:
 *   1. buildCodexCliArgs includes --json for new sessions.
 *   2. buildCodexCliArgs includes --json for resumed sessions.
 *   3. --json precedes 'resume' in the argument array.
 *   4. --model is included when specified.
 *   5. --full-auto is included when permissionMode is 'full-auto'.
 *   6. --full-auto is omitted when permissionMode is not set.
 */
import chalk from 'chalk';
import { buildCodexCliArgs } from '../../src/integrations/ai/adapters/codex-cli-runner';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Codex CLI --json flag smoke test\n'));

  // --- Test 1: --json for new sessions ---
  console.log(chalk.bold('Test 1: buildCodexCliArgs includes --json for new sessions'));
  const newArgs = buildCodexCliArgs({
    prompt: 'test',
    model: 'gpt-5.4-mini',
    cwd: '/repo',
  });
  assert('--json is present', newArgs.includes('--json'), `args: ${JSON.stringify(newArgs)}`);
  assert('exec is present', newArgs.includes('exec'), `args: ${JSON.stringify(newArgs)}`);

  // --- Test 2: --json for resumed sessions ---
  console.log(chalk.bold('\nTest 2: buildCodexCliArgs includes --json for resumed sessions'));
  const resumeArgs = buildCodexCliArgs({
    prompt: 'test',
    model: 'gpt-5.4-mini',
    cwd: '/repo',
    sessionId: 'sess-abc',
  });
  assert('--json is present', resumeArgs.includes('--json'), `args: ${JSON.stringify(resumeArgs)}`);
  assert('resume is present', resumeArgs.includes('resume'), `args: ${JSON.stringify(resumeArgs)}`);
  assert('session id is present', resumeArgs.includes('sess-abc'), `args: ${JSON.stringify(resumeArgs)}`);

  // --- Test 3: --json precedes resume ---
  console.log(chalk.bold('\nTest 3: --json precedes resume in argument order'));
  const jsonIdx = resumeArgs.indexOf('--json');
  const resumeIdx = resumeArgs.indexOf('resume');
  assert('--json comes before resume', jsonIdx < resumeIdx, `--json at ${jsonIdx}, resume at ${resumeIdx}`);

  // --- Test 4: --model included ---
  console.log(chalk.bold('\nTest 4: --model is included when specified'));
  assert('--model is present', newArgs.includes('--model'), `args: ${JSON.stringify(newArgs)}`);
  assert('model value is present', newArgs.includes('gpt-5.4-mini'), `args: ${JSON.stringify(newArgs)}`);

  // --- Test 5: --full-auto when permissionMode is full-auto ---
  console.log(chalk.bold('\nTest 5: --full-auto is included when permissionMode is full-auto'));
  const fullAutoArgs = buildCodexCliArgs({
    prompt: 'test',
    model: 'gpt-5.4-mini',
    cwd: '/repo',
    permissionMode: 'full-auto',
  });
  assert('--full-auto is present', fullAutoArgs.includes('--full-auto'), `args: ${JSON.stringify(fullAutoArgs)}`);

  // --- Test 6: --full-auto omitted ---
  console.log(chalk.bold('\nTest 6: --full-auto is omitted when permissionMode is not set'));
  assert('--full-auto is absent', !newArgs.includes('--full-auto'), `args: ${JSON.stringify(newArgs)}`);

  // --- Summary ---
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
