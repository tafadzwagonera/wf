/**
 * Manual smoke test: worktree is removed even when verification throws
 *
 * Run: nr test:manual verification-worktree-cleanup-on-error.smoke.ts
 */

import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { runPreReviewVerification } from '../../src/shared/utils/run-pre-review-verification';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const listWorktrees = (cwd: string): string =>
  execSync('git worktree list', { cwd, encoding: 'utf-8' });

function initTestRepo(tmpRepo: string): void {
  execSync('git init', { cwd: tmpRepo, stdio: 'ignore' });
  fs.writeFileSync(
    path.join(tmpRepo, 'package.json'),
    JSON.stringify({ scripts: { lint: 'exit 1', test: 'exit 1' } }),
  );
  execSync('git add package.json', { cwd: tmpRepo, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: tmpRepo, stdio: 'ignore' });
}

async function runVerificationCaptured(tmpRepo: string): Promise<{ threw: boolean; result: string | undefined }> {
  let threw = false;
  let result: string | undefined;
  try {
    result = await runPreReviewVerification(tmpRepo, { silent: true });
  } catch {
    threw = true;
  }
  return { threw, result };
}

function checkVerificationCompleted(threw: boolean, result: string | undefined): void {
  assert('call completed (threw or returned)', threw || result !== undefined);
}

function checkFailMarkersWhenPassed(threw: boolean, result: string | undefined): void {
  if (!threw && result !== undefined) {
    assert('result contains failure markers for broken scripts', result.includes('✗'), `Got: ${result}`);
  }
}

function checkNoStaleWorktrees(tmpRepo: string): void {
  const worktrees = listWorktrees(tmpRepo);
  const hasStale = worktrees.split('\n').some(l => l.includes('wf-verify-'));
  assert('no wf-verify-* worktrees remain after error', !hasStale, `Worktrees:\n${worktrees}`);
}

function checkNoStaleTmpDir(): void {
  const staleDir = fs.readdirSync(os.tmpdir()).find(e => e.startsWith('wf-verify-'));
  assert('no wf-verify-* directory remains in os.tmpdir()', !staleDir, `Found: ${staleDir}`);
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: worktree cleanup on verification error\n'));
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-error-test-'));
  try {
    initTestRepo(tmpRepo);
    const { threw, result } = await runVerificationCaptured(tmpRepo);
    checkVerificationCompleted(threw, result);
    checkFailMarkersWhenPassed(threw, result);
    checkNoStaleWorktrees(tmpRepo);
    checkNoStaleTmpDir();
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
