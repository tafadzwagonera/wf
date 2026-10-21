/**
 * Manual smoke test: an unrecoverable source branch logs a real WARN line
 * to the on-disk log file, not just the console, and falls back to a bare
 * analyze instead of skipping the scan entirely
 *
 * Verifies:
 *   1. When nothing is staged and no base branch can be resolved (no
 *      manifest, no reflog, non-interactive, no dev/upstream candidate),
 *      resolveSonarOutputForTarget completes without throwing and calls
 *      runSonarScan with the bare `{ kind: 'branch' }` scope (the terminal
 *      fallback), not a base-ref scope.
 *   2. A real WARN line is appended to the actual log file on disk under
 *      WF_HOME/logs/agent-<date>.log — read back with fs, not spied on.
 *   3. The same message also reaches the onProgress callback.
 *
 * Run: nr test:manual sonar-unrecovered-branch-warn-log.smoke.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { SonarStageService } from '../../src/review/sonar-stage.service';
import * as sonarScannerModule from '../../src/review/sonar-scanner';
import { createReporter, summarise } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/common/testing/env';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

type WfEnvironment = { repoDir: string; wfHome: string };

function setupWfEnvironment(prefix: string, homePrefix: string): WfEnvironment {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), homePrefix));
  withEnv({ WF_HOME: wfHome });
  return { repoDir, wfHome };
}

function cleanupWfEnvironment(repoDir: string, wfHome: string): void {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  restoreEnv();
}

function setupSoloRepo(repoDir: string): void {
  git(repoDir, ['init', '-q', '-b', 'solo']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
}

function mockSonarScanCapture(capturedRefs: unknown[]): () => void {
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: unknown) => {
    capturedRefs.push(opts);
    return { status: 'clean', steps: [] };
  };
  return () => {
    (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;
  };
}

function checkBareAnalyzeFallback(capturedRefs: unknown[]): void {
  console.log(chalk.bold.cyan('\nTest 1: falls back to a bare analyze instead of skipping'));
  if (
    capturedRefs.length === 1
    && JSON.stringify((capturedRefs[0] as { scope: unknown }).scope) === JSON.stringify({ kind: 'branch' })
  ) {
    pass('runSonarScan was called once with the bare { kind: \'branch\' } scope');
  } else {
    fail('Expected a single bare-analyze runSonarScan call', JSON.stringify(capturedRefs));
  }
}

function checkWarnLogFile(wfHome: string, expectedMessage: string): void {
  console.log(chalk.bold.cyan('\nTest 2: a real WARN line lands in the on-disk log file'));
  const today = new Date().toISOString().split('T')[0];
  const logFilePath = path.join(wfHome, 'logs', `agent-${today}.log`);
  if (fs.existsSync(logFilePath)) {
    const logContents = fs.readFileSync(logFilePath, 'utf-8');
    if (logContents.includes('[WARN]') && logContents.includes(expectedMessage)) {
      pass(`Log file ${logFilePath} contains a real [WARN] line with the skip message`);
    } else {
      fail('Log file exists but does not contain the expected WARN line', logContents);
    }
  } else {
    fail(`Expected log file to exist at ${logFilePath}`);
  }
}

function checkProgressCallback(progressMessages: string[], expectedMessage: string): void {
  console.log(chalk.bold.cyan('\nTest 3: the same message reaches onProgress'));
  if (progressMessages.includes(expectedMessage)) {
    pass('onProgress received the same skip message');
  } else {
    fail('Expected onProgress to receive the skip message', JSON.stringify(progressMessages));
  }
}

async function runAndCapture(
  sonarStageService: SonarStageService,
  repoDir: string,
  progressMessages: string[],
  capturedRefs: unknown[],
): Promise<() => void> {
  const restore = mockSonarScanCapture(capturedRefs);
  await sonarStageService.scanIfEnabled({
    repoDir,
    force: true,
    allowPrompt: true,
    onProgress: (m: string) => progressMessages.push(m),
  });
  return restore;
}

function verifySmoke(capturedRefs: unknown[], wfHome: string, progressMessages: string[]): void {
  const expectedMessage = 'SonarQube CLI: no base branch to diff against — running a bare analyze instead';
  checkBareAnalyzeFallback(capturedRefs);
  checkWarnLogFile(wfHome, expectedMessage);
  checkProgressCallback(progressMessages, expectedMessage);
}

async function main(): Promise<void> {
  console.log('Manual smoke: unrecovered source branch WARN log\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const { repoDir, wfHome } = setupWfEnvironment('sonar-warn-log-', 'sonar-warn-log-home-');
  setupSoloRepo(repoDir);
  const capturedRefs: unknown[] = [];
  const progressMessages: string[] = [];
  const restore = await runAndCapture(sonarStageService, repoDir, progressMessages, capturedRefs);
  restore();
  verifySmoke(capturedRefs, wfHome, progressMessages);
  cleanupWfEnvironment(repoDir, wfHome);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
