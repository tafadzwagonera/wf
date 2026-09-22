/**
 * Manual smoke test: pre-review verification runs in a disposable worktree
 * and leaves the target repo clean
 *
 * Run: nr test:manual verification-worktree-isolation.smoke.ts
 */

import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import chalk from 'chalk';
import { runPreReviewVerification } from '../../src/shared/utils/run-pre-review-verification';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const gitStatus = (cwd: string): string =>
  execSync('git status --porcelain', { cwd, encoding: 'utf-8' }).trim();

const listWorktrees = (cwd: string): string =>
  execSync('git worktree list', { cwd, encoding: 'utf-8' });

function checkVerificationResult(result: string): void {
  const hasContent = result === '' || result.startsWith('Pre-review verification:');
  assert('returns empty string or verification summary', hasContent, `Got: ${result.slice(0, 200)}`);
}

function checkWorkingTreeUnchanged(repoDir: string, statusBefore: string): void {
  const statusAfter = gitStatus(repoDir);
  assert(
    'working tree is unchanged after verification',
    statusAfter === statusBefore,
    `Before:\n${statusBefore || '(clean)'}\nAfter:\n${statusAfter || '(clean)'}`,
  );
}

function checkNoStaleWorktrees(repoDir: string): void {
  const worktrees = listWorktrees(repoDir);
  const hasStaleWorktree = worktrees.split('\n').some(line => line.includes('wf-verify-'));
  assert('no wf-verify-* worktrees remain after completion', !hasStaleWorktree, `Worktree list:\n${worktrees}`);
}

function checkNoStaleTmpDir(): void {
  const staleDir = fs.readdirSync(os.tmpdir()).find(e => e.startsWith('wf-verify-'));
  assert('no wf-verify-* directory remains in os.tmpdir()', !staleDir, `Found: ${staleDir}`);
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: verification worktree isolation\n'));
  const repoDir = process.cwd();
  const statusBefore = gitStatus(repoDir);
  const result = await runPreReviewVerification(repoDir, { silent: true });
  assert('runPreReviewVerification completes without throwing', true);
  checkVerificationResult(result);
  checkWorkingTreeUnchanged(repoDir, statusBefore);
  checkNoStaleWorktrees(repoDir);
  checkNoStaleTmpDir();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
