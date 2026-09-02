/**
 * Manual smoke test: scaffoldNewRepo creates a usable git repository
 *
 * Run: nr test:manual -- test-scaffold-new-repo
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

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  \u2713 ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  \u2717 ${label}`));
    failed++;
  }
};

const main = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: scaffoldNewRepo live side effects\n'));

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-scaffold-test-'));
  const baseDir = path.join(tmpBase, 'existing-app');
  fs.mkdirSync(baseDir, { recursive: true });

  try {
    const result = scaffoldNewRepo('new-contracts', baseDir);
    const expectedPath = path.resolve(baseDir, '..', 'new-contracts');

    // 1. Correct sibling path
    assert('returns the resolved sibling path', result === expectedPath);

    // 2. Directory exists
    assert('scaffolded directory exists on disk', fs.existsSync(result));

    // 3. .git/ exists
    assert('contains a .git/ subdirectory', fs.existsSync(path.join(result, '.git')));

    // 4. Exactly one commit with the expected message
    const log = execSync('git log --oneline', { cwd: result, encoding: 'utf-8' }).trim();
    const lines = log.split('\n').filter(Boolean);
    assert('git log shows exactly one commit', lines.length === 1);
    assert('commit message is "chore: initial commit"', lines[0].includes('chore: initial commit'));

    // 5. Single branch
    const branches = execSync('git branch', { cwd: result, encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
    assert('git branch shows a single branch', branches.length === 1);

    // 6. isRepoResolvable sees the scaffolded repo
    const origCwd = process.cwd;
    (process as any).cwd = () => baseDir;
    try {
      assert('isRepoResolvable returns true for the scaffolded repo', isRepoResolvable('new-contracts'));
    } finally {
      (process as any).cwd = origCwd;
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
