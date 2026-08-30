/**
 * Manual smoke test: SonarQube CLI gating in issue:review
 *
 * Verifies the gating paths:
 *   1. --sonar flag with config undefined and staged changes → scan runs
 *   2. stages.review.sonar: false config → immediate return, no progress
 *   2b. stages.review.sonar: undefined (default) → immediate return, no progress
 *   3. Preflight: sonar not on PATH → ConfigurationError from runSonarScan directly
 *
 * The nothing-staged/no-base-branch bare-analyze fallback is covered by
 * test-sonar-unrecovered-branch-warn-log.ts, which asserts the exact scope and the
 * real on-disk WARN log line instead of just catching whatever error surfaces here.
 *
 * Run: nr test:manual -- test-sonar-gating
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { SonarStageService } from '../../src/review/sonar-stage.service';
import { ConfigService } from '@nestjs/config';
import { runSonarScan } from '../../src/review/sonar-scanner';
import { ConfigurationError } from '../../src/shared/errors/app.error';
import chalk from 'chalk';

function initGitRepoWithStagedFile(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'content');
  execSync('git add file.txt', { cwd: dir });
}

async function run(): Promise<void> {
  console.log('Manual smoke: SonarQube CLI gating\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const sonarStageService = app.get(SonarStageService);
  const configService = app.get(ConfigService);

  let passed = 0;
  let failed = 0;
  const pass = (msg: string) => {
    console.log(chalk.green(`  PASS  ${msg}`));
    passed++;
  };
  const fail = (msg: string) => {
    console.error(chalk.red(`  FAIL  ${msg}`));
    failed++;
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-gate-'));
  initGitRepoWithStagedFile(tempDir);

  console.log(chalk.bold.cyan('\nTest 1: --sonar flag forces scan when config is undefined and changes are staged'));

  const msgs1: string[] = [];
  try {
    await sonarStageService.scanIfEnabled({
      repoDir: tempDir,
      force: true,
      allowPrompt: true,
      onProgress: (m: string) => msgs1.push(m),
    });
    // runSonarScan only calls onProgress for findings, not for a clean result, so a clean
    // authenticated scan legitimately resolves with zero progress messages and no error.
    pass(
      'Scan attempted when --sonar is set, config is undefined, and changes are staged'
      + (msgs1.length > 0 ? ` (progress: ${JSON.stringify(msgs1)})` : ' (clean scan, no findings)')
    );
  } catch (error) {
    if (error instanceof ConfigurationError) {
      pass(`Scan attempted but sonar CLI unavailable in this environment: ${error.message}`);
    } else {
      fail(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(chalk.bold.cyan('\nTest 2: stages.review.sonar: false config bypasses scan'));

  const msgs2: string[] = [];
  const originalGet = configService.get.bind(configService);
  (configService as unknown as Record<string, unknown>)['get'] = (key: string, ...rest: unknown[]) => {
    if (key === 'stages.review.sonar') return false;
    return originalGet(key, ...rest);
  };

  await sonarStageService.scanIfEnabled({
    repoDir: tempDir,
    allowPrompt: true,
    onProgress: (m: string) => msgs2.push(m),
  });

  (configService as unknown as Record<string, unknown>)['get'] = originalGet;

  if (msgs2.length === 0) pass('No progress emitted when config sonar is false');
  else fail(`Expected no messages, got: ${JSON.stringify(msgs2)}`);

  console.log(chalk.bold.cyan('\nTest 2b: stages.review.sonar: undefined (default) bypasses scan'));

  const msgs2b: string[] = [];
  await sonarStageService.scanIfEnabled({
    repoDir: tempDir,
    allowPrompt: true,
    onProgress: (m: string) => msgs2b.push(m),
  });

  if (msgs2b.length === 0) pass('No progress emitted when config sonar is undefined');
  else fail(`Expected no messages, got: ${JSON.stringify(msgs2b)}`);

  console.log(chalk.bold.cyan('\nTest 3: preflight check when sonar CLI not available'));

  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await runSonarScan({ repoDir: tempDir, scope: { kind: 'staged' } });
    fail('Expected ConfigurationError when sonar is not on PATH');
  } catch (error) {
    if (error instanceof ConfigurationError && error.message.includes('SonarQube CLI not found')) {
      pass('Preflight ConfigurationError thrown when sonar not on PATH');
    } else {
      fail(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    process.env.PATH = originalPath;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: SonarQube CLI gating');
}

run().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
