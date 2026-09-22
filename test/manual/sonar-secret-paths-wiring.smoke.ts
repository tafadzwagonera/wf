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
 * Run: nr test:manual sonar-secret-paths-wiring.smoke.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { SonarStageService } from '../../src/review/sonar-stage.service';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { ConfigService } from '@nestjs/config';
import * as sonarScannerModule from '../../src/review/sonar-scanner';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

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

function mockSonarScan(calls: Array<{ secretPaths?: string[] }>): () => void {
  const originalRunSonarScan = sonarScannerModule.runSonarScan;
  (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = async (opts: { secretPaths?: string[] }) => {
    calls.push(opts);
    return { status: 'clean' as const, steps: [] };
  };
  return () => {
    (sonarScannerModule as unknown as Record<string, unknown>)['runSonarScan'] = originalRunSonarScan;
  };
}

type ReviewStageService = { reviewDiff: (...a: unknown[]) => Promise<unknown> };

function mockReviewDiff(agent: ReviewerAgent): () => void {
  const svc = (agent as unknown as Record<string, ReviewStageService>)['reviewStageService'];
  const original = svc.reviewDiff;
  svc.reviewDiff = async () => ({
    review: { summary: '', issues: [], suggestions: [], approved: true }, sessionId: undefined,
  });
  return () => {
    svc.reviewDiff = original;
  };
}

function setupCmdTestRepo(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-secrets-cmd-'));
  initGit(tempDir);
  fs.writeFileSync(path.join(tempDir, 'auth.ts'), 'staged');
  fs.writeFileSync(path.join(tempDir, 'secrets.env'), 'staged');
  execSync('git add auth.ts secrets.env', { cwd: tempDir });
  fs.writeFileSync(path.join(tempDir, 'notes.md'), 'untracked');
  return tempDir;
}

async function runCmdScan(
  sonarStageService: SonarStageService,
  tempDir: string,
  calls: Array<{ secretPaths?: string[] }>,
): Promise<void> {
  const restore = mockSonarScan(calls);
  try {
    await sonarStageService.scanIfEnabled({ repoDir: tempDir, force: true, allowPrompt: true, onProgress: () => {} });
  } finally {
    restore();
  }
}

function checkCmdSecretPaths(calls: Array<{ secretPaths?: string[] }>): void {
  if (calls.length !== 1) {
    fail(`Expected exactly 1 runSonarScan call, got ${calls.length}`);
    return;
  }
  const secretPaths = [...(calls[0].secretPaths ?? [])].sort();
  const expected = ['auth.ts', 'secrets.env'];
  if (JSON.stringify(secretPaths) === JSON.stringify(expected)) {
    pass(`secretPaths matched exactly the staged files: ${JSON.stringify(secretPaths)}`);
  } else {
    fail(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(secretPaths)}`);
  }
}

async function testIssueReviewCommandDoesNotStageUntracked(
  sonarStageService: SonarStageService,
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 1: resolveSonarOutputForTarget forwards only pre-staged files'));
  const tempDir = setupCmdTestRepo();
  const calls: Array<{ secretPaths?: string[] }> = [];
  try {
    await runCmdScan(sonarStageService, tempDir, calls);
    checkCmdSecretPaths(calls);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function setupAgentTestRepo(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-secrets-agent-'));
  initGit(tempDir);
  fs.writeFileSync(path.join(tempDir, 'auth.ts'), 'initial');
  execSync('git add auth.ts', { cwd: tempDir });
  execSync('git commit -q -m initial', { cwd: tempDir });
  fs.appendFileSync(path.join(tempDir, 'auth.ts'), 'modified');
  fs.writeFileSync(path.join(tempDir, 'new-secret.ts'), 'untracked');
  return tempDir;
}

function setupAgentMocks(
  agent: ReviewerAgent,
  configService: ConfigService,
  calls: Array<{ secretPaths?: string[] }>,
): () => void {
  const restoreSonar = mockSonarScan(calls);
  const restoreConfig = forceSonarConfig(configService, true);
  const restoreReview = mockReviewDiff(agent);
  return () => {
    restoreSonar();
    restoreConfig();
    restoreReview();
  };
}

async function runAgentScan(
  agent: ReviewerAgent,
  configService: ConfigService,
  tempDir: string,
): Promise<Array<{ secretPaths?: string[] }>> {
  const calls: Array<{ secretPaths?: string[] }> = [];
  const restore = setupAgentMocks(agent, configService, calls);
  const ticket = { ticketKey: 'TEST-1', content: '# TEST-1', path: path.join(tempDir, 'TEST-1.md') };
  try {
    await agent.execute(ticket, { repoDir: tempDir, silent: true });
    return calls;
  } finally {
    restore();
  }
}

function checkAgentSecretPaths(calls: Array<{ secretPaths?: string[] }>): void {
  if (calls.length !== 1) {
    fail(`Expected exactly 1 runSonarScan call, got ${calls.length}`);
    return;
  }
  const secretPaths = [...(calls[0].secretPaths ?? [])].sort();
  const expected = ['auth.ts', 'new-secret.ts'];
  if (JSON.stringify(secretPaths) === JSON.stringify(expected)) {
    pass(`secretPaths matched the full staged list after stage-all: ${JSON.stringify(secretPaths)}`);
  } else {
    fail(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(secretPaths)}`);
  }
}

async function testReviewerAgentStagesEverythingFirst(
  agent: ReviewerAgent,
  configService: ConfigService,
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 2: ReviewerAgent.execute forwards the post-stage-all staged list to sonar'));
  const tempDir = setupAgentTestRepo();
  try {
    const calls = await runAgentScan(agent, configService, tempDir);
    checkAgentSecretPaths(calls);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log('Manual smoke: secretPaths wiring into runSonarScan\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sonarStageService = app.get(SonarStageService);
  const agent = app.get(ReviewerAgent);
  const configService = app.get(ConfigService);

  await testIssueReviewCommandDoesNotStageUntracked(sonarStageService);
  await testReviewerAgentStagesEverythingFirst(agent, configService);

  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
