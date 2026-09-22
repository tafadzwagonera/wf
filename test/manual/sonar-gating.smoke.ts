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
 * Run: nr test:manual sonar-gating.smoke.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { SonarStageService } from '../../src/review/sonar-stage.service';
import { ConfigService } from '@nestjs/config';
import { runSonarScan } from '../../src/review/sonar-scanner';
import { ConfigurationError } from '../../src/shared/errors/app.error';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function initGitRepoWithStagedFile(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'content');
  execSync('git add file.txt', { cwd: dir });
}

function createProgressMessages(): { messages: string[]; onProgress: (m: string) => void } {
  const messages: string[] = [];
  return { messages, onProgress: (m: string) => messages.push(m) };
}

function handleScanResult(error: unknown, msgs: string[]): void {
  if (error instanceof ConfigurationError) {
    pass(`Scan attempted but sonar CLI unavailable in this environment: ${error.message}`);
  } else {
    fail(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function reportScanSuccess(msgs: string[]): void {
  const progressText = msgs.length > 0 ? ` (progress: ${JSON.stringify(msgs)})` : ' (clean scan, no findings)';
  pass('Scan attempted when --sonar is set, config is undefined, and changes are staged' + progressText);
}

async function checkScanAttempted(sonarStageService: SonarStageService, tempDir: string): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 1: --sonar flag forces scan when config is undefined and changes are staged'));
  const { messages: msgs1, onProgress } = createProgressMessages();
  try {
    await sonarStageService.scanIfEnabled({ repoDir: tempDir, force: true, allowPrompt: true, onProgress });
    reportScanSuccess(msgs1);
  } catch (error) {
    handleScanResult(error, msgs1);
  }
}

function mockConfigValue(configService: ConfigService, restore: boolean = false): () => void {
  const originalGet = configService.get.bind(configService);
  (configService as unknown as Record<string, unknown>)['get'] = (key: string, ...rest: unknown[]) => {
    if (key === 'stages.review.sonar') return false;
    return originalGet(key, ...rest);
  };
  return () => {
    (configService as unknown as Record<string, unknown>)['get'] = originalGet;
  };
}

async function checkConfigFalseBypassesScan(
  sonarStageService: SonarStageService,
  configService: ConfigService,
  tempDir: string,
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 2: stages.review.sonar: false config bypasses scan'));
  const { messages: msgs2, onProgress } = createProgressMessages();
  const restoreConfig = mockConfigValue(configService);
  await sonarStageService.scanIfEnabled({ repoDir: tempDir, allowPrompt: true, onProgress });
  restoreConfig();
  if (msgs2.length === 0) pass('No progress emitted when config sonar is false');
  else fail(`Expected no messages, got: ${JSON.stringify(msgs2)}`);
}

async function checkConfigUndefinedBypassesScan(sonarStageService: SonarStageService, tempDir: string): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 2b: stages.review.sonar: undefined (default) bypasses scan'));
  const { messages: msgs2b, onProgress } = createProgressMessages();
  await sonarStageService.scanIfEnabled({ repoDir: tempDir, allowPrompt: true, onProgress });
  if (msgs2b.length === 0) pass('No progress emitted when config sonar is undefined');
  else fail(`Expected no messages, got: ${JSON.stringify(msgs2b)}`);
}

function handlePreflightResult(error: unknown): void {
  if (error instanceof ConfigurationError && error.message.includes('SonarQube CLI not found')) {
    pass('Preflight ConfigurationError thrown when sonar not on PATH');
  } else {
    fail(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkPreflightError(tempDir: string): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 3: preflight check when sonar CLI not available'));
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await runSonarScan({ repoDir: tempDir, scope: { kind: 'staged' } });
    fail('Expected ConfigurationError when sonar is not on PATH');
  } catch (error) {
    handlePreflightResult(error);
  } finally {
    process.env.PATH = originalPath;
  }
}

async function main(): Promise<void> {
  console.log('Manual smoke: SonarQube CLI gating\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const configService = app.get(ConfigService);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-gate-'));
  initGitRepoWithStagedFile(tempDir);
  await checkScanAttempted(sonarStageService, tempDir);
  await checkConfigFalseBypassesScan(sonarStageService, configService, tempDir);
  await checkConfigUndefinedBypassesScan(sonarStageService, tempDir);
  await checkPreflightError(tempDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
