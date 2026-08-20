/**
 * Manual smoke test: pre-review verification runs in a disposable worktree
 * and leaves the target repo clean
 *
 * Run: nr test:manual -- test-verification-worktree-isolation
 */

import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { runPreReviewVerification } from '../../src/shared/utils/run-pre-review-verification';

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(chalk.green(`  ✓ ${msg}`));
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${msg}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed++;
};
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const gitStatus = (cwd: string): string =>
  execSync('git status --porcelain', { cwd, encoding: 'utf-8' }).trim();

const listWorktrees = (cwd: string): string =>
  execSync('git worktree list', { cwd, encoding: 'utf-8' });

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: verification worktree isolation\n'));

  const repoDir = process.cwd();

  const statusBefore = gitStatus(repoDir);

  const result = await runPreReviewVerification(repoDir, { silent: true });
  assert('runPreReviewVerification completes without throwing', true);

  const hasContent = result === '' || result.startsWith('Pre-review verification:');
  assert(
    'returns empty string or verification summary',
    hasContent,
    `Got: ${result.slice(0, 200)}`,
  );

  const statusAfter = gitStatus(repoDir);
  assert(
    'working tree is unchanged after verification',
    statusAfter === statusBefore,
    `Before:\n${statusBefore || '(clean)'}\nAfter:\n${statusAfter || '(clean)'}`,
  );

  const worktrees = listWorktrees(repoDir);
  const hasStaleWorktree = worktrees.split('\n').some(line => line.includes('wf-verify-'));
  assert(
    'no wf-verify-* worktrees remain after completion',
    !hasStaleWorktree,
    `Worktree list:\n${worktrees}`,
  );

  const tmpEntries = fs.readdirSync(os.tmpdir());
  const staleDir = tmpEntries.find(e => e.startsWith('wf-verify-'));
  assert(
    'no wf-verify-* directory remains in os.tmpdir()',
    !staleDir,
    `Found: ${staleDir}`,
  );

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
}

main();
