/**
 * Manual smoke test: push() protected branch guard via real NestJS DI + git
 *
 * Scope: guard logic (prefix stripping, case matching, custom config, empty
 * array opt-out) is exhaustively covered by the Jest unit test in
 * src/integrations/git/git.service.spec.ts. This manual test only verifies
 * live side effects that mocks cannot cover:
 *   1. Guard fires correctly through real NestJS DI wiring (not just mocks)
 *   2. An allowed branch actually pushes to a real git remote
 *
 * No AI / API keys required — exercises GitService.push() directly.
 *
 * Run: nr test:manual push-protected-branch-guard.smoke.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import { GitError } from '../../src/common/errors/app.error';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

type GitRunner = (cmd: string, cwd?: string) => string;

function isProtectedBranchError(err: unknown): boolean {
  return err instanceof GitError && err.message.includes('Refusing to push directly to protected branch');
}

function reportPushError(label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  fail(label, `Wrong error type or message: ${msg}`);
}

async function assertPushRefused(gitService: GitService, branch: string, label: string): Promise<void> {
  try {
    await gitService.push('origin', branch);
    fail(label, `Expected GitError but push() resolved for branch '${branch}'`);
  } catch (err) {
    if (isProtectedBranchError(err)) {
      pass(label);
      return;
    }
    reportPushError(label, err);
  }
}

function makeGitRunner(defaultDir: string): GitRunner {
  return (cmd: string, cwd: string = defaultDir) =>
    execSync(`git ${cmd}`, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

function initBareAndClone(tmpDir: string, bareDir: string, git: GitRunner): void {
  git('init --bare', bareDir);
  git('init -b main');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  git(`remote add origin ${bareDir}`);
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  git('add .');
  git('commit -m "init"');
  git('push -u origin main');
}

function addFeatureBranch(tmpDir: string, git: GitRunner): void {
  git('checkout -b feature/foo');
  fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'feature work\n');
  git('add .');
  git('commit -m "feature work"');
  git('checkout main');
}

function setupRepos(tmpDir: string, bareDir: string): GitRunner {
  const git = makeGitRunner(tmpDir);
  initBareAndClone(tmpDir, bareDir, git);
  addFeatureBranch(tmpDir, git);
  return git;
}

async function runProtectedBranchChecks(gitService: GitService, git: GitRunner, tmpDir: string): Promise<void> {
  console.log('\n  Real DI wiring:');
  await assertPushRefused(gitService, 'main', '1. push to main is refused via real DI');
  console.log('\n  Real git push:');
  git('checkout feature/foo', tmpDir);
  try {
    await gitService.push('origin', 'feature/foo', true);
    pass('2. push to feature/foo succeeds against real remote');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail('2. push to feature/foo should succeed', msg);
  }
}

async function runAppChecks(git: GitRunner, tmpDir: string): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  console.log('\nSmoke test: push() protected branch guard (live side effects)\n');
  console.log('─'.repeat(60));
  const gitService = app.get(GitService);
  await runProtectedBranchChecks(gitService, git, tmpDir);
  await app.close();
}

function printTestResults(): void {
  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ${counts.passed} passed   ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed!');
  console.log('━'.repeat(60));
  if (counts.failed > 0) process.exit(1);
}

function createTempDirs(): { tmpDir: string; bareDir: string } {
  return {
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wf-push-guard-')),
    bareDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wf-push-guard-bare-')),
  };
}

function cleanupDirs(tmpDir?: string, bareDir?: string): void {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (bareDir && fs.existsSync(bareDir)) fs.rmSync(bareDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const origCwd = process.cwd();
  let tmpDir: string | undefined;
  let bareDir: string | undefined;
  try {
    ({ tmpDir, bareDir } = createTempDirs());
    const git = setupRepos(tmpDir, bareDir);
    process.chdir(tmpDir);
    await runAppChecks(git, tmpDir);
    printTestResults();
  } finally {
    process.chdir(origCwd);
    cleanupDirs(tmpDir, bareDir);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
