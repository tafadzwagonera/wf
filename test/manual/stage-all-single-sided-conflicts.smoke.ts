/**
 * Manual smoke test: stageAll correctly stages single-sided merge conflicts (add/add, modify/delete)
 *
 * Run: nr test:manual stage-all-single-sided-conflicts.smoke.ts
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
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

function configureGitUser(run: (cmd: string) => string): void {
  run('git config user.email "test@example.com"');
  run('git config user.name "Test"');
  run('git config commit.gpgsign false');
}

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
  configureGitUser(run);
  return { dir, git: run };
}

function setupBaseAndBranchA(dir: string, git: (cmd: string, allowFailure?: boolean) => string): string {
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'base');
  git('git add shared.txt');
  git('git commit -m base');
  const baseSha = git('git rev-parse HEAD');
  git('git checkout -b branch-a');
  fs.writeFileSync(path.join(dir, 'added.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'modified-by-a');
  git('git add .');
  git('git commit -m branch-a');
  return baseSha;
}

function setupBranchB(dir: string, git: (cmd: string, allowFailure?: boolean) => string, baseSha: string): void {
  git(`git checkout -b branch-b ${baseSha}`);
  fs.writeFileSync(path.join(dir, 'added.txt'), 'b');
  fs.rmSync(path.join(dir, 'shared.txt'));
  git('git add added.txt');
  git('git rm shared.txt');
  git('git commit -m branch-b');
  // merge branch-a into branch-b: AA on added.txt, DU (deleted by us) on shared.txt
  git('git merge branch-a --no-edit', true);
}

function checkConflictStatuses(dir: string, git: (cmd: string, allowFailure?: boolean) => string): void {
  const porcelain = git('git status --porcelain');
  assert('git status reports AA added.txt after the merge stops', porcelain.includes('AA added.txt'), porcelain);
  assert('git status reports a shared.txt conflict (DU: deleted by us)', /^(DU|UD) shared\.txt$/m.test(porcelain), porcelain);
}

async function checkConflictFilesStaged(
  dir: string, git: (cmd: string, allowFailure?: boolean) => string, gitService: GitService,
): Promise<void> {
  await gitService.stageAll(dir);
  const cachedNameStatus = git('git diff --cached --name-status');
  assert('AA conflict (added.txt) is staged', cachedNameStatus.includes('added.txt'), cachedNameStatus);
  assert('DU/UD conflict (shared.txt) surviving content is staged, not dropped', cachedNameStatus.includes('shared.txt'), cachedNameStatus);
}

async function checkExclusionPathsNotStaged(
  dir: string, git: (cmd: string, allowFailure?: boolean) => string, gitService: GitService,
): Promise<void> {
  // regression guard: EXCLUDED_PATHS must not be staged even inside a real conflicted merge
  fs.mkdirSync(path.join(dir, '.wf', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wf', 'state', 'run.json'), '{}');
  await gitService.stageAll(dir);
  const cachedAfterExclusionCheck = git('git diff --cached --name-status');
  assert('.wf/** stays excluded from staging even mid-conflict-resolution', !cachedAfterExclusionCheck.includes('.wf/state/run.json'), cachedAfterExclusionCheck);
}

async function runConflictScenario(gitService: GitService, dirs: string[]): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: GitService.stageAll on single-sided merge conflicts\n'));
  const { dir, git } = makeRepo();
  dirs.push(dir);
  const baseSha = setupBaseAndBranchA(dir, git);
  setupBranchB(dir, git, baseSha);
  checkConflictStatuses(dir, git);
  await checkConflictFilesStaged(dir, git, gitService);
  await checkExclusionPathsNotStaged(dir, git, gitService);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const gitService = app.get(GitService);
  const dirs: string[] = [];
  try {
    await runConflictScenario(gitService, dirs);
  } finally {
    await app.close();
    for (const d of dirs) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
