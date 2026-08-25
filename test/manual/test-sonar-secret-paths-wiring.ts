/**
 * Manual smoke test: secretPaths flow from git status into the sonar secrets scan
 *
 * Verifies that both call sites derive secretPaths from real git state and forward
 * them to runSonarScan — a wiring regression (dropping the field, or sourcing it
 * from the wrong git status field) would silently disable the secrets-before-
 * transmission scan without any test noticing, since the sonar CLI itself never
 * needs to run for this check.
 *
 *   1. IssueReviewCommand.resolveSonarOutputForTarget does not stage anything —
 *      secretPaths must equal exactly the already-staged files, excluding any
 *      untracked file.
 *   2. ReviewerAgent.execute stages everything first — secretPaths must
 *      equal the full staged list *after* that stage-all, including files that
 *      started out untracked.
 *
 * Run: nr test:manual -- test-sonar-secret-paths-wiring
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { ConfigService } from '@nestjs/config';
import * as sonarScannerModule from '../../src/review/sonar-scanner';
import chalk from 'chalk';

let passed = 0;
let failed = 0;
const pass = (msg: string): void => {
  console.log(chalk.green(`  PASS  ${msg}`));
  passed++;
};
const fail = (msg: string): void => {
  console.error(chalk.red(`  FAIL  ${msg}`));
  failed++;
};

function initGit(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
}

function forceSonarConfig(configService: ConfigService, enabled: boolean): () => void {
  const originalGet = configService.get.bind(configService);
  (configService as unknown as Record<string, unknown>)['get'] = (key: string, ...rest: unknown[]) => {
    if (key === 'stages.review.sonar') return enabled;
    return originalGet(key, ...rest);
  };
  return () => {
    (configService as unknown as Record<string, unknown>)['get'] = originalGet;
  };
}

async function testIssueReviewCommandDoesNotStageUntracked(
  command: IssueReviewCommand, configService: ConfigService
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 1: resolveSonarOutputForTarget forwards only pre-staged files'));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-secrets-cmd-'));
  initGit(tempDir);
  fs.writeFileSync(path.join(tempDir, 'auth.ts'), 'staged');
  fs.writeFileSync(path.join(tempDir, 'secrets.env'), 'staged');
  execSync('git add auth.ts secrets.env', { cwd: tempDir });
  fs.writeFileSync(path.join(tempDir, 'notes.md'), 'untracked');

  const calls: Array<{ secretPaths?: string[] }> = [];
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { secretPaths?: string[] }) => {
    calls.push(opts);
    return { status: 'clean' as const, steps: [] };
  };
  const restoreConfig = forceSonarConfig(configService, true);

  try {
    const resolveFn = (command as unknown as Record<string, (...a: unknown[]) => Promise<void>>)['resolveSonarOutputForTarget'];
    await resolveFn.call(command, { repoDir: tempDir, diff: '', title: '', context: '' }, { sonar: true }, () => {});

    if (calls.length !== 1) {
      fail(`Expected exactly 1 runSonarScan call, got ${calls.length}`);
    } else {
      const secretPaths = [...(calls[0].secretPaths ?? [])].sort();
      const expected = ['auth.ts', 'secrets.env'];
      if (JSON.stringify(secretPaths) === JSON.stringify(expected)) {
        pass(`secretPaths matched exactly the staged files: ${JSON.stringify(secretPaths)}`);
      } else {
        fail(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(secretPaths)}`);
      }
    }
  } finally {
    (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;
    restoreConfig();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testReviewerAgentStagesEverythingFirst(
  agent: ReviewerAgent, configService: ConfigService
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 2: ReviewerAgent.execute forwards the post-stage-all staged list to sonar'));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-secrets-agent-'));
  initGit(tempDir);
  fs.writeFileSync(path.join(tempDir, 'auth.ts'), 'initial');
  execSync('git add auth.ts', { cwd: tempDir });
  execSync('git commit -q -m initial', { cwd: tempDir });
  fs.appendFileSync(path.join(tempDir, 'auth.ts'), 'modified');
  fs.writeFileSync(path.join(tempDir, 'new-secret.ts'), 'untracked');

  const calls: Array<{ secretPaths?: string[] }> = [];
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { secretPaths?: string[] }) => {
    calls.push(opts);
    return { status: 'clean' as const, steps: [] };
  };
  const restoreConfig = forceSonarConfig(configService, true);

  const reviewStageService = (agent as unknown as Record<string, { reviewDiff: (...a: unknown[]) => Promise<unknown> }>)['reviewStageService'];
  const originalReviewDiff = reviewStageService.reviewDiff;
  reviewStageService.reviewDiff = async () => ({
    review: { summary: '', issues: [], suggestions: [], approved: true }, sessionId: undefined,
  });

  try {
    const ticket = { ticketKey: 'TEST-1', content: '# TEST-1', path: path.join(tempDir, 'TEST-1.md') };
    await agent.execute(ticket, { repoDir: tempDir, silent: true });

    if (calls.length === 1) {
      const secretPaths = [...(calls[0].secretPaths ?? [])].sort();
      const expected = ['auth.ts', 'new-secret.ts'];
      if (JSON.stringify(secretPaths) === JSON.stringify(expected)) {
        pass(`secretPaths matched the full staged list after stage-all: ${JSON.stringify(secretPaths)}`);
      } else {
        fail(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(secretPaths)}`);
      }
    } else {
      fail(`Expected exactly 1 runSonarScan call, got ${calls.length}`);
    }
  } finally {
    (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;
    reviewStageService.reviewDiff = originalReviewDiff;
    restoreConfig();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  console.log('Manual smoke: secretPaths wiring into runSonarScan\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueReviewCommand);
  const agent = app.get(ReviewerAgent);
  const configService = app.get(ConfigService);

  await testIssueReviewCommandDoesNotStageUntracked(command, configService);
  await testReviewerAgentStagesEverythingFirst(agent, configService);

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: secretPaths wiring into runSonarScan');
}

run().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
