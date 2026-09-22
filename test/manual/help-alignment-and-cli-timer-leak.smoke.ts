/**
 * Manual smoke test: CLI timer leak fix
 *
 * Run: nr test:manual help-alignment-and-cli-timer-leak.smoke.ts
 *
 * Verifies:
 *   1. spawnCli SIGKILL grace timer calls .unref() (no open handle leak)
 *   2. Full test suite exits cleanly without --forceExit
 *
 * The three help-catalog content checks this file previously carried (the
 * --repos description text, the repo-scoped generation text, and the
 * provider-aware diagnostics text) were removed: they were static,
 * in-process string assertions with no live side effect, and were already
 * duplicated verbatim by help-catalog-parser.spec.ts:33 and
 * help-output.spec.ts:48,120, which run on every `yarn test`.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';

const repoRoot = path.join(__dirname, '..', '..');

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
};

/**
 * Run a command and capture stdout + stderr.
 *
 * @param command - Shell command to execute
 * @param args - Arguments array
 * @returns Promise resolving to stdout, stderr, and exit code
 */
const run = (command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
  new Promise(resolve => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'pipe', shell: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('close', code => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        code: code ?? 1,
      });
    });
  });

function checkSigkillTimerUnref(): void {
  console.log(chalk.bold('Test 1: SIGKILL grace timer calls .unref()'));
  const source = fs.readFileSync(
    path.join(repoRoot, 'src', 'integrations', 'ai', 'adapters', 'claude-cli-runner.ts'),
    'utf-8'
  );
  const sigkillBlock = /setTimeout\(\(\)\s*=>\s*\{[^}]*SIGKILL[^}]*\}[^)]*\)[^;]*/s.exec(source);
  assert(
    'SIGKILL grace setTimeout calls .unref()',
    sigkillBlock !== null && sigkillBlock[0].includes('.unref()'),
    `Matched block: ${sigkillBlock?.[0] ?? 'no match'}`
  );
}

async function checkTestSuiteExitsCleanly(): Promise<void> {
  console.log(chalk.bold('Test 2: test suite exits cleanly (no open handle warning)'));
  const result = await run('npx', [
    'jest',
    '--detectOpenHandles',
    'src/integrations/ai/adapters/claude-cli-runner.spec.ts',
  ]);
  const combined = result.stdout + result.stderr;
  assert('Tests pass', result.code === 0, `Exit code: ${result.code}`);
  assert(
    'No open handle warning in output',
    !combined.includes('open handle') && !combined.includes('force exited'),
    'Found open handle or force exit warning'
  );
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nCLI timer leak smoke test\n'));
  checkSigkillTimerUnref();
  await checkTestSuiteExitsCleanly();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
