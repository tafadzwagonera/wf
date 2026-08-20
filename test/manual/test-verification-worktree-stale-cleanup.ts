/**
 * Manual smoke test: stale verification worktrees are cleaned up on next run
 *
 * Run: nr test:manual -- test-verification-worktree-stale-cleanup
 */

import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { cleanStaleVerificationWorktrees } from '../../src/shared/utils/run-pre-review-verification';

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

const listWorktrees = (cwd: string): string =>
  execSync('git worktree list', { cwd, encoding: 'utf-8' });

function removeWorktreeSafe(repoDir: string, wtPath: string): void {
  try {
    execSync(`git worktree remove --force ${JSON.stringify(wtPath)}`, {
      cwd: repoDir, stdio: 'ignore',
    });
  } catch {
    fs.rmSync(wtPath, { recursive: true, force: true });
    try {
      execSync('git worktree prune', { cwd: repoDir, stdio: 'ignore' });
    } catch { /* best-effort */ }
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: stale verification worktree cleanup\n'));

  const repoDir = process.cwd();
  const stalePath = path.join(os.tmpdir(), 'wf-verify-staletest123');

  try {
    execSync(`git worktree add --detach ${JSON.stringify(stalePath)}`, {
      cwd: repoDir, stdio: 'ignore',
    });
  } catch {
    fail('could not create stale worktree for test setup');
    process.exit(1);
  }

  try {
    const before = listWorktrees(repoDir);
    const hasStale = before.split('\n').some(l => l.includes('wf-verify-staletest123'));
    assert('stale worktree exists before cleanup', hasStale, `Worktrees:\n${before}`);
    assert(
      'stale directory exists on disk before cleanup',
      fs.existsSync(stalePath),
    );

    cleanStaleVerificationWorktrees(repoDir);

    const after = listWorktrees(repoDir);
    const staleRemoved = !after.split('\n').some(l => l.includes('wf-verify-'));
    assert(
      'no wf-verify-* worktrees after cleanup',
      staleRemoved,
      `Worktrees after:\n${after}`,
    );

    assert(
      'stale directory removed from disk',
      !fs.existsSync(stalePath),
      `Directory still exists: ${stalePath}`,
    );
  } finally {
    removeWorktreeSafe(repoDir, stalePath);
  }

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
}

main();
