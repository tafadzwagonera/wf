/**
 * Smoke test: GitService stash/checkout/pop with explicit cwd
 *
 * Verifies that stashChanges, stashPop, and checkoutBranch operate on the
 * target directory (cwd) rather than process.cwd().
 *
 * Run: nr test:manual -- test-git-cwd-stash-checkout
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-git-cwd-'));
  console.log(chalk.bold.cyan('\nSmoke test: GitService cwd forwarding'));
  console.log(chalk.gray(`  Temp repo: ${tmpDir}\n`));

  // Set up a bare git repo in the temp dir
  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: tmpDir,
    stdio: 'pipe',
  });

  // Create a branch to test checkout
  execSync('git checkout -b test-branch && git checkout -', {
    cwd: tmpDir,
    stdio: 'pipe',
  });

  // Create a dirty file so stash has something to work with
  fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'uncommitted change');
  execSync('git add dirty.txt', { cwd: tmpDir, stdio: 'pipe' });

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const gitService = app.get(GitService);

    // 1. stashChanges with cwd
    console.log(chalk.gray('  1. stashChanges(msg, cwd)...'));
    await gitService.stashChanges('smoke-test-stash', tmpDir);
    const statusAfterStash = await gitService.getStatus(tmpDir);
    if (!statusAfterStash.isClean()) {
      throw new Error('stashChanges did not clean the working tree in the target dir');
    }
    console.log(chalk.green('     PASS — stash applied in target dir'));

    // 2. checkoutBranch with cwd
    console.log(chalk.gray('  2. checkoutBranch(branch, cwd)...'));
    await gitService.checkoutBranch('test-branch', tmpDir);
    const branch = await gitService.getCurrentBranch(tmpDir);
    if (branch !== 'test-branch') {
      throw new Error(`Expected branch "test-branch", got "${branch}"`);
    }
    console.log(chalk.green('     PASS — checkout operated in target dir'));

    // Switch back before popping
    await gitService.checkoutBranch('master', tmpDir);

    // 3. stashPop with cwd
    console.log(chalk.gray('  3. stashPop(cwd)...'));
    await gitService.stashPop(tmpDir);
    const statusAfterPop = await gitService.getStatus(tmpDir);
    if (statusAfterPop.isClean()) {
      throw new Error('stashPop did not restore changes in the target dir');
    }
    console.log(chalk.green('     PASS — stash pop restored in target dir'));

    console.log(chalk.bold.green('\nAll smoke tests passed.\n'));
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
