/**
 * Manual smoke test: worktree is removed even when verification throws
 *
 * Run: nr test:manual -- test-verification-worktree-cleanup-on-error
 */

import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { runPreReviewVerification } from '../../src/shared/utils/run-pre-review-verification';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const listWorktrees = (cwd: string): string =>
  execSync('git worktree list', { cwd, encoding: 'utf-8' });

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: worktree cleanup on verification error\n'));

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-error-test-'));

  try {
    execSync('git init', { cwd: tmpRepo, stdio: 'ignore' });
    fs.writeFileSync(
      path.join(tmpRepo, 'package.json'),
      JSON.stringify({ scripts: { lint: 'exit 1', test: 'exit 1' } }),
    );
    execSync('git add package.json', { cwd: tmpRepo, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd: tmpRepo, stdio: 'ignore' });

    let threw = false;
    let result: string | undefined;
    try {
      result = await runPreReviewVerification(tmpRepo, { silent: true });
    } catch {
      threw = true;
    }

    assert(
      'call completed (threw or returned)',
      threw || result !== undefined,
    );

    if (!threw && result !== undefined) {
      const hasFailMarkers = result.includes('✗');
      assert(
        'result contains failure markers for broken scripts',
        hasFailMarkers,
        `Got: ${result}`,
      );
    }

    const worktrees = listWorktrees(tmpRepo);
    const hasStale = worktrees.split('\n').some(l => l.includes('wf-verify-'));
    assert(
      'no wf-verify-* worktrees remain after error',
      !hasStale,
      `Worktrees:\n${worktrees}`,
    );

    const tmpEntries = fs.readdirSync(os.tmpdir());
    const staleDir = tmpEntries.find(e => e.startsWith('wf-verify-'));
    assert(
      'no wf-verify-* directory remains in os.tmpdir()',
      !staleDir,
      `Found: ${staleDir}`,
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }

  console.log(chalk.bold(`\n  ${counts.passed} passed, ${counts.failed} failed\n`));
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
