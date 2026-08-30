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
 * Run: nr test:manual -- test-sonar-unrecovered-branch-warn-log
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { SonarStageService } from '../../src/review/sonar-stage.service';
import * as sonarScannerModule from '../../src/review/sonar-scanner';

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
  console.log('Manual smoke: unrecovered source branch WARN log\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-warn-log-'));
  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-warn-log-home-'));
  const originalWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;

  // A repo with no dev-like or main-like branch and no upstream: the heuristic resolves a
  // baseRef ('solo') that shares no common history-free ancestor concept here since it *is*
  // the only branch — instead we force the "no base at all" case by using a single branch
  // with no development/main match and no upstream, so getUpstreamRef and the development
  // check both come up empty and baseRef is undefined outright.
  git(repoDir, ['init', '-q', '-b', 'solo']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);

  const capturedRefs: unknown[] = [];
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: unknown) => {
    capturedRefs.push(opts);
    return { status: 'clean', steps: [] };
  };

  const target = { repoDir, diff: '', title: '', context: '' };
  const progressMessages: string[] = [];

  console.log(chalk.bold.cyan('\nTest 1: falls back to a bare analyze instead of skipping'));
  await sonarStageService.scanIfEnabled({
    repoDir: target.repoDir,
    force: true,
    allowPrompt: true,
    onProgress: (m: string) => progressMessages.push(m),
  });

  if (
    capturedRefs.length === 1
    && JSON.stringify((capturedRefs[0] as { scope: unknown }).scope) === JSON.stringify({ kind: 'branch' })
  ) {
    pass('runSonarScan was called once with the bare { kind: \'branch\' } scope');
  } else {
    fail('Expected a single bare-analyze runSonarScan call', JSON.stringify(capturedRefs));
  }

  const expectedMessage = 'SonarQube CLI: no base branch to diff against — running a bare analyze instead';

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

  console.log(chalk.bold.cyan('\nTest 3: the same message reaches onProgress'));
  if (progressMessages.includes(expectedMessage)) {
    pass('onProgress received the same skip message');
  } else {
    fail('Expected onProgress to receive the skip message', JSON.stringify(progressMessages));
  }

  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(wfHome, { recursive: true, force: true });
  if (originalWfHome === undefined) delete process.env.WF_HOME;
  else process.env.WF_HOME = originalWfHome;

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: unrecovered source branch WARN log');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
