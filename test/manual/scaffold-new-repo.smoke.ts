/**
 * Manual smoke test: scaffoldNewRepo creates a usable git repository
 *
 * Run: nr test:manual scaffold-new-repo.smoke.ts
 *
 * Verifies:
 *   1. scaffoldNewRepo returns the correct sibling path
 *   2. The scaffolded directory exists on disk
 *   3. The directory contains a .git/ subdirectory
 *   4. git log shows exactly one commit with "chore: initial commit"
 *   5. git branch shows a single branch
 *   6. isRepoResolvable returns true for the scaffolded repo
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { scaffoldNewRepo, isRepoResolvable } from '../../src/agents/utils';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean): void =>
  condition ? pass(label) : fail(label);

function checkReturnedPath(result: string, expectedPath: string): void {
  assert('returns the resolved sibling path', result === expectedPath);
}

function checkDirectoryAndGit(result: string): void {
  assert('scaffolded directory exists on disk', fs.existsSync(result));
  assert('contains a .git/ subdirectory', fs.existsSync(path.join(result, '.git')));
}

function checkGitLog(result: string): void {
  const log = execSync('git log --oneline', { cwd: result, encoding: 'utf-8' }).trim();
  const lines = log.split('\n').filter(Boolean);
  assert('git log shows exactly one commit', lines.length === 1);
  assert('commit message is "chore: initial commit"', lines[0].includes('chore: initial commit'));
}

function checkBranchCount(result: string): void {
  const branches = execSync('git branch', { cwd: result, encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean);
  assert('git branch shows a single branch', branches.length === 1);
}

function checkIsRepoResolvable(result: string, baseDir: string): void {
  const origCwd = process.cwd;
  (process as any).cwd = () => baseDir;
  try {
    assert('isRepoResolvable returns true for the scaffolded repo', isRepoResolvable('new-contracts'));
  } finally {
    (process as any).cwd = origCwd;
  }
}

async function runChecks(tmpBase: string, baseDir: string): Promise<void> {
  const result = scaffoldNewRepo('new-contracts', baseDir);
  const expectedPath = path.resolve(baseDir, '..', 'new-contracts');
  checkReturnedPath(result, expectedPath);
  checkDirectoryAndGit(result);
  checkGitLog(result);
  checkBranchCount(result);
  checkIsRepoResolvable(result, baseDir);
}

const main = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: scaffoldNewRepo live side effects\n'));
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-scaffold-test-'));
  const baseDir = path.join(tmpBase, 'existing-app');
  fs.mkdirSync(baseDir, { recursive: true });
  try {
    await runChecks(tmpBase, baseDir);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
  summarise(counts);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
