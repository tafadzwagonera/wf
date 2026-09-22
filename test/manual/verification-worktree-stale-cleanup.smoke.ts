/**
 * Manual smoke test: stale verification worktrees are cleaned up on next run
 *
 * Run: nr test:manual verification-worktree-stale-cleanup.smoke.ts
 */

import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { cleanStaleVerificationWorktrees } from '../../src/shared/utils/run-pre-review-verification';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
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

function setupStaleWorktree(repoDir: string, stalePath: string): void {
  try {
    execSync(`git worktree add --detach ${JSON.stringify(stalePath)}`, {
      cwd: repoDir, stdio: 'ignore',
    });
  } catch {
    fail('could not create stale worktree for test setup');
    process.exit(1);
  }
}

function checkStaleWorktreeExists(repoDir: string, stalePath: string): void {
  const before = listWorktrees(repoDir);
  const hasStale = before.split('\n').some(l => l.includes('wf-verify-staletest123'));
  assert('stale worktree exists before cleanup', hasStale, `Worktrees:\n${before}`);
  assert('stale directory exists on disk before cleanup', fs.existsSync(stalePath));
}

function checkStaleWorktreeRemoved(repoDir: string, stalePath: string): void {
  const after = listWorktrees(repoDir);
  const staleRemoved = !after.split('\n').some(l => l.includes('wf-verify-'));
  assert('no wf-verify-* worktrees after cleanup', staleRemoved, `Worktrees after:\n${after}`);
  assert('stale directory removed from disk', !fs.existsSync(stalePath), `Directory still exists: ${stalePath}`);
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: stale verification worktree cleanup\n'));
  const repoDir = process.cwd();
  const stalePath = path.join(os.tmpdir(), 'wf-verify-staletest123');
  setupStaleWorktree(repoDir, stalePath);
  try {
    checkStaleWorktreeExists(repoDir, stalePath);
    cleanStaleVerificationWorktrees(repoDir);
    checkStaleWorktreeRemoved(repoDir, stalePath);
  } finally {
    removeWorktreeSafe(repoDir, stalePath);
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
