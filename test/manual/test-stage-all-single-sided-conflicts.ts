/**
 * Manual smoke test: stageAll correctly stages single-sided merge conflicts (add/add, modify/delete)
 *
 * Run: nr test:manual -- test-stage-all-single-sided-conflicts
 *
 * Verifies:
 *   1. An "AA" (both added, no common ancestor) conflict is staged successfully
 *   2. A "UD"/"DU" (deleted by one side, modified by the other) conflict's surviving
 *      content is staged, not silently dropped
 *   3. stageAll does not re-stage EXCLUDED_PATHS entries even inside a real conflicted merge
 *
 * Rationale: GitService.selectStageablePaths treats any `working_dir !== ' '` as
 * stageable, including merge-conflict status codes where working_dir encodes the
 * state of "the other side" of the merge rather than an index-vs-worktree comparison.
 * Only "UU" (both modified) has existing unit coverage. This test verifies the
 * remaining common conflict shapes against real git plumbing, not mocked status.
 *
 * No AI / API keys required — exercises GitService.stageAll directly.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(chalk.green(`  ✓ ${msg}`));
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${msg}`));
  if (detail) console.error(chalk.gray(`    → ${detail}`));
  failed++;
};
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

function makeRepo(): { dir: string; git: (cmd: string, allowFailure?: boolean) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stage-conflicts-'));
  const run = (cmd: string, allowFailure = false) => {
    try {
      return execSync(cmd, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
    } catch (err) {
      if (allowFailure) return (err as { stdout?: string }).stdout?.toString().trim() ?? '';
      throw err;
    }
  };
  run('git init -b main');
  run('git config user.email "test@example.com"');
  run('git config user.name "Test"');
  run('git config commit.gpgsign false');
  return { dir, git: run };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const gitService = app.get(GitService);
  const dirs: string[] = [];

  try {
    console.log(chalk.bold.cyan('\nSmoke test: GitService.stageAll on single-sided merge conflicts\n'));

    const { dir, git } = makeRepo();
    dirs.push(dir);

    // baseline commit shared by both branches, includes a file that will diverge as UD/DU
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'base');
    git('git add shared.txt');
    git('git commit -m base');
    const baseSha = git('git rev-parse HEAD');

    // branch-a: adds added.txt, modifies shared.txt
    git('git checkout -b branch-a');
    fs.writeFileSync(path.join(dir, 'added.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'modified-by-a');
    git('git add .');
    git('git commit -m branch-a');

    // branch-b: adds added.txt (conflicting add/add), deletes shared.txt
    git(`git checkout -b branch-b ${baseSha}`);
    fs.writeFileSync(path.join(dir, 'added.txt'), 'b');
    fs.rmSync(path.join(dir, 'shared.txt'));
    git('git add added.txt');
    git('git rm shared.txt');
    git('git commit -m branch-b');

    // merge branch-a into branch-b: AA on added.txt, DU (deleted by us) on shared.txt
    git('git merge branch-a --no-edit', true);

    const porcelain = git('git status --porcelain');
    assert('git status reports AA added.txt after the merge stops', porcelain.includes('AA added.txt'), porcelain);
    assert(
      'git status reports a shared.txt conflict (DU: deleted by us)',
      /^(DU|UD) shared\.txt$/m.test(porcelain),
      porcelain
    );

    await gitService.stageAll(dir);

    const cachedNameStatus = git('git diff --cached --name-status');
    assert('AA conflict (added.txt) is staged', cachedNameStatus.includes('added.txt'), cachedNameStatus);
    assert(
      'DU/UD conflict (shared.txt) surviving content is staged, not dropped',
      cachedNameStatus.includes('shared.txt'),
      cachedNameStatus
    );

    // regression guard: EXCLUDED_PATHS must not be staged even inside a real conflicted merge
    fs.mkdirSync(path.join(dir, '.wf', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wf', 'state', 'run.json'), '{}');
    await gitService.stageAll(dir);
    const cachedAfterExclusionCheck = git('git diff --cached --name-status');
    assert(
      '.wf/** stays excluded from staging even mid-conflict-resolution',
      !cachedAfterExclusionCheck.includes('.wf/state/run.json'),
      cachedAfterExclusionCheck
    );
  } finally {
    await app.close();
    for (const d of dirs) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  }

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
