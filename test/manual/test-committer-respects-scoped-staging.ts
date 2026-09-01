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
 * Run: nr test:manual -- test-committer-respects-scoped-staging
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { CommitterAgent } from '../../src/agents/committer.agent';

let passed = 0;
let failed = 0;

const pass = (message: string) => {
  console.log(chalk.green(`  PASS  ${message}`));
  passed++;
};
const fail = (message: string, detail?: string) => {
  console.error(chalk.red(`  FAIL  ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed++;
};

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

async function main(): Promise<void> {
  console.log('Manual smoke: CommitterAgent respects an already-scoped git add\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const committer = app.get(CommitterAgent);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'committer-scoped-staging-'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'b.ts'), 'export const b = 1;\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);

  // The intended, scoped change.
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export const a = 2;\n');
  git(repoDir, ['add', 'a.ts']);

  // An unrelated file sitting in the same working tree — must NOT be swept in.
  fs.writeFileSync(path.join(repoDir, 'unrelated-feature.ts'), 'export const unrelated = true;\n');

  await committer.execute('WBP-1', repoDir, undefined, true, true);

  const headCommit = git(repoDir, ['rev-parse', 'HEAD']);
  const filesInCommit = git(repoDir, ['show', '--name-only', '--format=', headCommit])
    .split('\n')
    .filter(Boolean);

  if (filesInCommit.includes('a.ts') && filesInCommit.length === 1) {
    pass('Commit contains exactly the explicitly staged file (a.ts)');
  } else {
    fail('Expected commit to contain only a.ts', JSON.stringify(filesInCommit));
  }

  if (!filesInCommit.includes('unrelated-feature.ts')) {
    pass('Unrelated untracked file was NOT swept into the commit');
  } else {
    fail('Unrelated file was incorrectly included in the commit', JSON.stringify(filesInCommit));
  }

  const statusAfter = git(repoDir, ['status', '--porcelain']);
  if (statusAfter.includes('?? unrelated-feature.ts')) {
    pass('Unrelated file remains untracked in the working tree afterward');
  } else {
    fail('Expected unrelated-feature.ts to remain untracked', statusAfter);
  }

  fs.rmSync(repoDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: CommitterAgent respects scoped staging');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
