/**
 * Manual smoke test: GitService.getDiffFromRef returns the working-tree diff
 * against a named commit ref
 *
 * Scenario: A temp git repo has a committed baseline and one unstaged file
 * change. getDiffFromRef(baseRef, repoDir) must return a diff that contains
 * the changed file. Calling it with a nonexistent ref must throw. The slice
 * behaviour in StepSpecFidelityService.captureDiff is verified by writing a
 * file whose diff exceeds 60 000 chars.
 *
 * Verifies:
 *   1. getDiffFromRef(baselineSha, repoDir) returns a string containing the
 *      changed file name and added line content
 *   2. getDiffFromRef(baselineSha, repoDir) returns '' when the working tree
 *      is clean after the ref
 *   3. getDiffFromRef('nonexistent-ref', repoDir) throws a GitError
 *   4. StepSpecFidelityService.captureDiff truncates diffs longer than
 *      60 000 chars to at most 60 000 chars
 *
 * Run: nr test:manual git-service-diff-from-ref.smoke.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import { StepSpecFidelityService } from '../../src/agents/step-spec-fidelity.service';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

type ScenarioResult = {
  gitService: GitService;
  stepSpecFidelity: StepSpecFidelityService;
  repoDir: string;
  baselineSha: string;
};

async function setupScenario(app: any): Promise<ScenarioResult> {
  const gitService = app.get(GitService);
  const stepSpecFidelity = app.get(StepSpecFidelityService);
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-diff-from-ref-'));
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v1\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'baseline']);
  const baselineSha = git(repoDir, ['rev-parse', 'HEAD']);
  return { gitService, stepSpecFidelity, repoDir, baselineSha };
}

async function checkDiffContainsModifiedFile(
  gitService: GitService,
  repoDir: string,
  baselineSha: string,
): Promise<void> {
  fs.writeFileSync(path.join(repoDir, 'a.ts'), 'v2\n');
  const diff = await gitService.getDiffFromRef(baselineSha, repoDir);
  if (diff.includes('a.ts') && diff.includes('v2')) {
    pass('getDiffFromRef returns diff containing the modified file and added content');
  } else {
    fail('Expected diff to contain a.ts and v2', diff.slice(0, 300));
  }
}

async function checkEmptyDiffForCleanTree(gitService: GitService, repoDir: string): Promise<void> {
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'commit v2']);
  const cleanSha = git(repoDir, ['rev-parse', 'HEAD']);
  const cleanDiff = await gitService.getDiffFromRef(cleanSha, repoDir);
  if (cleanDiff.trim() === '') {
    pass('getDiffFromRef returns empty string when working tree is clean after ref');
  } else {
    fail('Expected empty diff for clean tree', cleanDiff.slice(0, 300));
  }
}

async function checkThrowsForNonexistentRef(gitService: GitService, repoDir: string): Promise<void> {
  let threw = false;
  try {
    await gitService.getDiffFromRef('nonexistent-ref-abc123', repoDir);
  } catch {
    threw = true;
  }
  if (threw) {
    pass('getDiffFromRef throws when ref does not exist');
  } else {
    fail('Expected getDiffFromRef to throw for a nonexistent ref');
  }
}

function assertDiffTruncated(rawDiff: string): void {
  if (rawDiff.length > 0 && rawDiff.length <= 60_000) {
    pass(`captureDiff truncates diff to at most 60 000 chars (got ${rawDiff.length})`);
  } else if (rawDiff.length === 0) {
    fail('captureDiff returned empty — large file was not tracked or diff was not captured');
  } else {
    fail(`Expected captureDiff result ≤ 60 000 chars, got ${rawDiff.length}`);
  }
}

async function checkCaptureDiffTruncates(
  stepSpecFidelity: StepSpecFidelityService,
  repoDir: string,
): Promise<void> {
  fs.writeFileSync(path.join(repoDir, 'big.ts'), 'placeholder\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'add big.ts placeholder']);
  const bigBaselineSha = git(repoDir, ['rev-parse', 'HEAD']);
  const bigContent = 'x'.repeat(70_000) + '\n';
  fs.writeFileSync(path.join(repoDir, 'big.ts'), bigContent);
  const rawDiff: string = await (stepSpecFidelity as any).captureDiff(repoDir, bigBaselineSha);
  assertDiffTruncated(rawDiff);
}

async function main(): Promise<void> {
  console.log('Manual smoke: GitService.getDiffFromRef returns diff against named commit ref\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const { gitService, stepSpecFidelity, repoDir, baselineSha } = await setupScenario(app);
  await checkDiffContainsModifiedFile(gitService, repoDir, baselineSha);
  await checkEmptyDiffForCleanTree(gitService, repoDir);
  await checkThrowsForNonexistentRef(gitService, repoDir);
  await checkCaptureDiffTruncates(stepSpecFidelity, repoDir);
  fs.rmSync(repoDir, { recursive: true, force: true });
  await app.close();
  summarise(counts);
  console.log('\nManual smoke test passed: GitService.getDiffFromRef');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
