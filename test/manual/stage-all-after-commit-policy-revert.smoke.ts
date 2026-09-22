/**
 * Manual smoke test: GitService.stageAll does not throw after resetSoftToCommit unwinds a deletion commit
 *
 * Run: nr test:manual stage-all-after-commit-policy-revert.smoke.ts
 *
 * Verifies:
 *   1. stageAll resolves without throwing when the index contains a fully-staged
 *      deletion left behind by resetSoftToCommit (the exact reported crash path)
 *   2. The staged deletion is preserved in the index after stageAll — the fix skips
 *      the path rather than losing the change
 *   3. stageAll still stages all genuinely pending changes (modifications, deletions,
 *      new files) alongside already-staged paths it leaves untouched
 *   4. stageAll is idempotent: a second consecutive call resolves and leaves the
 *      index byte-identical to what the first call produced
 *
 * No AI / API keys required — exercises GitService.resetSoftToCommit and stageAll directly.
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

function makeRepo(): { dir: string; git: (cmd: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stage-after-revert-'));
  const run = (cmd: string) => execSync(cmd, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  run('git init');
  run('git config user.email "test@example.com"');
  run('git config user.name "Test"');
  run('git config commit.gpgsign false');
  return { dir, git: run };
}

function setupScenario1Repo(dirs: string[]): { dir: string; git: (cmd: string) => string } {
  const { dir, git } = makeRepo();
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const v = 1;');
  fs.writeFileSync(path.join(dir, 'sonar-project.properties'), 'sonar.projectKey=test');
  git('git add .');
  git('git commit -m "baseline"');
  return { dir, git };
}

async function runScenario1(
  gitService: GitService,
  dirs: string[],
): Promise<{ dir: string; git: (cmd: string) => string }> {
  console.log('Scenario 1: stageAll does not throw after resetSoftToCommit unwinds a deletion\n');
  const { dir, git } = setupScenario1Repo(dirs);
  const baselineSha = git('git rev-parse HEAD');
  git('git rm sonar-project.properties');
  git('git commit -m "remove sonar config"');
  await gitService.resetSoftToCommit(baselineSha, dir);
  return { dir, git };
}

async function checkStageAllDoesNotThrow(
  gitService: GitService,
  dir: string,
): Promise<void> {
  let stageAllThrew = false;
  let stageAllError = '';
  try {
    await gitService.stageAll(dir);
  } catch (err: unknown) {
    stageAllThrew = true;
    stageAllError = err instanceof Error ? err.message : String(err);
  }
  assert('stageAll resolves without throwing', !stageAllThrew, stageAllError);
}

function assertPorcelainHasStagedDeletion(git: (cmd: string) => string): void {
  const porcelain = git('git status --porcelain');
  assert(
    'sonar-project.properties remains a staged deletion in the index',
    porcelain.includes('D  sonar-project.properties'),
    `git status --porcelain:\n${porcelain}`,
  );
}

function assertCachedDiffHasDeletion(git: (cmd: string) => string): void {
  const cachedNameStatus = git('git diff --cached --name-status');
  assert(
    'git diff --cached still lists the deletion after stageAll',
    cachedNameStatus.includes('sonar-project.properties'),
    `git diff --cached --name-status:\n${cachedNameStatus}`,
  );
}

async function checkScenario1Results(
  gitService: GitService,
  dir: string,
  git: (cmd: string) => string,
): Promise<void> {
  await checkStageAllDoesNotThrow(gitService, dir);
  assertPorcelainHasStagedDeletion(git);
  assertCachedDiffHasDeletion(git);
}

function buildScenario2Repo(dirs: string[]): { dir: string; git: (cmd: string) => string } {
  const { dir, git } = makeRepo();
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'v1');
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  git('git add .');
  git('git commit -m "baseline"');
  return { dir, git };
}

async function applyAndStageScenario2Changes(
  gitService: GitService,
  dir: string,
  git: (cmd: string) => string,
): Promise<void> {
  const base2 = git('git rev-parse HEAD');
  git('git rm config.json');
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'v2');
  fs.writeFileSync(path.join(dir, 'src', 'helper.ts'), 'export {}');
  git('git add .');
  git('git commit -m "agent changes"');
  await gitService.resetSoftToCommit(base2, dir);
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'v3');
  await gitService.stageAll(dir);
}

function assertScenario2Results(git: (cmd: string) => string): void {
  const cached2 = git('git diff --cached --name-status');
  assert('staged deletion (config.json) is present in cached diff', cached2.includes('config.json'), cached2);
  assert('modified file (src/index.ts) is staged', cached2.includes('src/index.ts'), cached2);
  assert('new file (src/helper.ts) is staged', cached2.includes('src/helper.ts'), cached2);
}

async function runScenario2(gitService: GitService, dirs: string[]): Promise<void> {
  console.log('\nScenario 2: genuinely pending changes are still staged alongside skipped paths\n');
  const { dir, git } = buildScenario2Repo(dirs);
  await applyAndStageScenario2Changes(gitService, dir, git);
  assertScenario2Results(git);
}

async function runScenario3(
  gitService: GitService,
  dir: string,
  git: (cmd: string) => string,
): Promise<void> {
  console.log('\nScenario 3: second stageAll call is idempotent\n');
  const porcelainAfterFirst = git('git status --porcelain');
  await gitService.stageAll(dir);
  const porcelainAfterSecond = git('git status --porcelain');
  assert(
    'git status --porcelain is identical after a second stageAll call',
    porcelainAfterFirst === porcelainAfterSecond,
    `after first:\n${porcelainAfterFirst}\nafter second:\n${porcelainAfterSecond}`,
  );
}

function cleanupDirs(dirs: string[]): void {
  for (const d of dirs) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
}

async function runAllScenarios(gitService: GitService, dirs: string[]): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: GitService.stageAll after resetSoftToCommit\n'));
  const { dir, git } = await runScenario1(gitService, dirs);
  await checkScenario1Results(gitService, dir, git);
  await runScenario2(gitService, dirs);
  await runScenario3(gitService, dir, git);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const gitService = app.get(GitService);
  const dirs: string[] = [];
  try {
    await runAllScenarios(gitService, dirs);
  } finally {
    await app.close();
    cleanupDirs(dirs);
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
