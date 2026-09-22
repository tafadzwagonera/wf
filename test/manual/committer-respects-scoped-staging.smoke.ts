/**
 * Manual smoke test: CommitterAgent respects an already-scoped `git add`
 * instead of widening it to every changed file in the working tree
 *
 * Scenario: a caller (a human, or an agent following this project's own
 * commit convention) runs `git add <specific files>` to scope a commit, while
 * an UNRELATED file sits modified/untracked in the same working tree (e.g.
 * a separate feature's work-in-progress). CommitterAgent.execute() must
 * commit exactly the staged scope — it must not call GitService.stageAll()
 * and silently sweep the unrelated file into the same commit.
 *
 * Verifies:
 *   1. A real git commit is created containing ONLY the explicitly staged file
 *   2. The unrelated untracked file is NOT included in the commit
 *   3. The unrelated untracked file remains untracked in the working tree afterward
 *
 * Run: nr test:manual committer-respects-scoped-staging.smoke.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { CommitterAgent } from '../../src/agents/committer.agent';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

function setupTestRepo(repoDir: string): void {
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'b.ts'), 'export const b = 1;\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export const a = 2;\n');
  git(repoDir, ['add', 'a.ts']);
  fs.writeFileSync(path.join(repoDir, 'unrelated-feature.ts'), 'export const unrelated = true;\n');
}

function assertUnrelatedFileExcluded(filesInCommit: string[], statusAfter: string): void {
  if (filesInCommit.includes('unrelated-feature.ts')) {
    fail('Unrelated file was incorrectly included in the commit', JSON.stringify(filesInCommit));
  } else {
    pass('Unrelated untracked file was NOT swept into the commit');
  }
  if (statusAfter.includes('?? unrelated-feature.ts')) {
    pass('Unrelated file remains untracked in the working tree afterward');
  } else {
    fail('Expected unrelated-feature.ts to remain untracked', statusAfter);
  }
}

function checkScopedStagingResults(filesInCommit: string[], statusAfter: string): void {
  if (filesInCommit.includes('a.ts') && filesInCommit.length === 1) {
    pass('Commit contains exactly the explicitly staged file (a.ts)');
  } else {
    fail('Expected commit to contain only a.ts', JSON.stringify(filesInCommit));
  }
  assertUnrelatedFileExcluded(filesInCommit, statusAfter);
}

async function main(): Promise<void> {
  console.log('Manual smoke: CommitterAgent respects an already-scoped git add\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const committer = app.get(CommitterAgent);
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'committer-scoped-staging-'));
  setupTestRepo(repoDir);
  await committer.execute('WBP-1', repoDir, undefined, true, true);
  const headCommit = git(repoDir, ['rev-parse', 'HEAD']);
  const filesInCommit = git(repoDir, ['show', '--name-only', '--format=', headCommit]).split('\n').filter(Boolean);
  const statusAfter = git(repoDir, ['status', '--porcelain']);
  checkScopedStagingResults(filesInCommit, statusAfter);
  fs.rmSync(repoDir, { recursive: true, force: true });
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
