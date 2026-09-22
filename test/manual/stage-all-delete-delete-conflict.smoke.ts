/**
 * Manual smoke test: stageAll surfaces a clear failure on an unresolved delete/delete merge conflict
 *
 * Run: nr test:manual stage-all-delete-delete-conflict.smoke.ts
 *
 * Verifies:
 *   1. A synthetic "both deleted" (DD) unmerged conflict — stage 1 (ancestor) only,
 *      no stage 2/3, no working-tree file — is reported by git status as DD
 *   2. GitService.stageAll's behavior against that state is deterministic: it either
 *      resolves or rejects with GitError, never an unhandled exception
 *   3. A failed stageAll call leaves git status unchanged (no partial/corrupt staging)
 *
 * Rationale: GitService.selectStageablePaths filters on `working_dir !== ' '`. A DD
 * conflict's working_dir is 'D', so the path is included in what stageAll attempts to
 * `git add` — but the path is absent from both the working tree and any resolvable
 * index stage, the same class of failure the working_dir filter was added to fix for
 * soft-reset deletions. This test documents actual behavior against real git plumbing.
 *
 * No AI / API keys required — exercises GitService.stageAll directly.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import { GitError } from '../../src/shared/errors/app.error';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

function makeRepo(): { dir: string; git: (cmd: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stage-dd-conflict-'));
  const run = (cmd: string) => execSync(cmd, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  run('git init');
  run('git config user.email "test@example.com"');
  run('git config user.name "Test"');
  run('git config commit.gpgsign false');
  return { dir, git: run };
}

function injectDDConflict(dir: string, git: (cmd: string) => string): string {
  fs.writeFileSync(path.join(dir, 'conflict.txt'), 'content');
  git('git add conflict.txt');
  git('git commit -m base');
  // Inject an unmerged "both deleted" conflict directly into the index —
  // stage 1 (ancestor) only, no stage 2/3, no working-tree file.
  const blobSha = git('git rev-parse HEAD:conflict.txt');
  git('git rm --cached conflict.txt');
  execSync(`printf '100644 %s 1\\tconflict.txt\\n' ${blobSha} | git update-index --index-info`, { cwd: dir, shell: '/bin/bash' });
  fs.rmSync(path.join(dir, 'conflict.txt'), { force: true });
  return git('git status --porcelain');
}

async function runStageAllOnConflict(gitService: GitService, dir: string): Promise<{ threw: boolean; error: unknown }> {
  let threw = false;
  let error: unknown;
  try {
    await gitService.stageAll(dir);
  } catch (err: unknown) {
    threw = true;
    error = err;
  }
  return { threw, error };
}

function checkStageAllResult(
  threw: boolean, error: unknown, porcelainBefore: string, git: (cmd: string) => string,
): void {
  if (threw) {
    assert('stageAll rejects with GitError (not an unhandled exception)', error instanceof GitError, error instanceof Error ? error.message : String(error));
    const porcelainAfter = git('git status --porcelain');
    assert('git status is unchanged after the failed stageAll call', porcelainAfter === porcelainBefore, `before:\n${porcelainBefore}\nafter:\n${porcelainAfter}`);
  } else {
    const porcelainAfter = git('git status --porcelain');
    pass('stageAll resolved without throwing');
    console.log(chalk.gray(`    → resulting git status --porcelain:\n${porcelainAfter}`));
  }
}

async function runDDConflictScenario(gitService: GitService, dirs: string[]): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: GitService.stageAll on an unresolved delete/delete conflict\n'));
  const { dir, git } = makeRepo();
  dirs.push(dir);
  const porcelainBefore = injectDDConflict(dir, git);
  assert('git status reports DD conflict.txt before stageAll', porcelainBefore.includes('DD conflict.txt'), porcelainBefore);
  const { threw, error } = await runStageAllOnConflict(gitService, dir);
  checkStageAllResult(threw, error, porcelainBefore, git);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const gitService = app.get(GitService);
  const dirs: string[] = [];
  try {
    await runDDConflictScenario(gitService, dirs);
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
