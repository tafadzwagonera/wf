/**
 * Smoke test: GitService stash/checkout/pop with explicit cwd
 *
 * Verifies that stashChanges, stashPop, and checkoutBranch operate on the
 * target directory (cwd) rather than process.cwd().
 *
 * Run: nr test:manual git-cwd-stash-checkout.smoke.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

function setupTestRepo(tmpDir: string): void {
  // Set up a bare git repo in the temp dir
  execSync('git init && git commit --allow-empty -m "init"', { cwd: tmpDir, stdio: 'pipe' });
  // Create a branch to test checkout
  execSync('git checkout -b test-branch && git checkout -', { cwd: tmpDir, stdio: 'pipe' });
  // Create a dirty file so stash has something to work with
  fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'uncommitted change');
  execSync('git add dirty.txt', { cwd: tmpDir, stdio: 'pipe' });
}

async function testStashChanges(gitService: GitService, tmpDir: string): Promise<void> {
  console.log(chalk.gray('  1. stashChanges(msg, cwd)...'));
  await gitService.stashChanges('smoke-test-stash', tmpDir);
  const statusAfterStash = await gitService.getStatus(tmpDir);
  if (!statusAfterStash.isClean()) {
    throw new Error('stashChanges did not clean the working tree in the target dir');
  }
  console.log(chalk.green('     PASS — stash applied in target dir'));
}

async function testCheckoutBranch(gitService: GitService, tmpDir: string): Promise<void> {
  console.log(chalk.gray('  2. checkoutBranch(branch, cwd)...'));
  await gitService.checkoutBranch('test-branch', tmpDir);
  const branch = await gitService.getCurrentBranch(tmpDir);
  if (branch !== 'test-branch') {
    throw new Error(`Expected branch "test-branch", got "${branch}"`);
  }
  console.log(chalk.green('     PASS — checkout operated in target dir'));
  // Switch back before popping
  await gitService.checkoutBranch('master', tmpDir);
}

async function testStashPop(gitService: GitService, tmpDir: string): Promise<void> {
  console.log(chalk.gray('  3. stashPop(cwd)...'));
  await gitService.stashPop(tmpDir);
  const statusAfterPop = await gitService.getStatus(tmpDir);
  if (statusAfterPop.isClean()) {
    throw new Error('stashPop did not restore changes in the target dir');
  }
  console.log(chalk.green('     PASS — stash pop restored in target dir'));
}

async function runCwdTests(gitService: GitService, tmpDir: string): Promise<void> {
  await testStashChanges(gitService, tmpDir);
  await testCheckoutBranch(gitService, tmpDir);
  await testStashPop(gitService, tmpDir);
  console.log(chalk.bold.green('\nAll smoke tests passed.\n'));
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-git-cwd-'));
  console.log(chalk.bold.cyan('\nSmoke test: GitService cwd forwarding'));
  console.log(chalk.gray(`  Temp repo: ${tmpDir}\n`));
  setupTestRepo(tmpDir);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    await runCwdTests(app.get(GitService), tmpDir);
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(chalk.red(`\nFAILED: ${error.message}\n`));
  process.exit(1);
});
