/**
 * Manual Test: --silent mode for FetcherAgent, PlannerAgent, ReviewerAgent, CommitterAgent
 *
 * Run: nr test:manual silent-mode-agents.smoke.ts
 *
 * Verifies:
 * 1. FetcherAgent.execute() suppresses decorative output when silent
 * 2. FetcherAgent.loadFromDisk() suppresses decorative output when silent
 * 3. PlannerAgent.execute() suppresses decorative output when silent
 * 4. PlannerAgent.loadFromDisk() suppresses decorative output when silent
 * 5. ReviewerAgent.execute() suppresses decorative output when silent
 * 6. CommitterAgent.execute() suppresses decorative output when silent
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { FetcherAgent } from '../../src/agents/fetcher.agent';
import { PlannerAgent } from '../../src/agents/planner.agent';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { CommitterAgent } from '../../src/agents/committer.agent';
import { FetchStageService } from '../../src/workflows/stages/fetch-stage.service';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { CommitStageService } from '../../src/workflows/stages/commit-stage.service';
import { GitService } from '../../src/integrations/git/git.service';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const MOCK_TICKET_CONTENT = '# WBP-TEST: Silent mode test\n\nDescription here.';
const MOCK_PLAN = {
  action: 'fix',
  summary: 'Fix the silent mode',
  estimatedComplexity: 'low',
  steps: ['Step 1'],
  affectedFiles: ['src/test.ts'],
  affectedRepositories: ['wf'],
};

function captureConsole(): { getOutput: () => string; restore: () => void } {
  let captured = '';
  const origLog = console.log;
  console.log = (...args: any[]) => {
    captured += args.map(String).join(' ') + '\n';
  };
  return {
    getOutput: () => captured,
    restore: () => {
      console.log = origLog;
    },
  };
}

function assertSilent(output: string, subjectKey: string): void {
  if (output.trim() === '') {
    pass(`${subjectKey} produces no output when silent`);
  } else {
    fail(`${subjectKey} leaked output in silent mode`, output.slice(0, 200));
  }
}

function assertFetcherNonSilentOutput(output: string): void {
  if (output.includes('STAGE 1') && output.includes('Ticket fetched')) {
    pass('FetcherAgent.execute() produces output when not silent');
  } else {
    fail('FetcherAgent.execute() missing expected output when not silent', output.slice(0, 200));
  }
}

type TestEnv = { app: any; tmpDir: string; wfDir: string; ticketPath: string; planPath: string };

async function setupTestEnv(): Promise<TestEnv> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const tmpBaseName = `wf-silent-test-${Date.now()}`;
  const tmpDir = path.join(os.tmpdir(), tmpBaseName);
  fs.mkdirSync(tmpDir, { recursive: true });
  const wfDir = path.join(os.homedir(), '.wf', tmpBaseName);
  const platformDir = path.join(wfDir, 'jira');
  fs.mkdirSync(platformDir, { recursive: true });
  const ticketPath = path.join(platformDir, 'WBP-TEST.md');
  fs.writeFileSync(ticketPath, MOCK_TICKET_CONTENT, 'utf-8');
  const planPath = path.join(platformDir, 'WBP-TEST-plan-fix.json');
  fs.writeFileSync(planPath, JSON.stringify(MOCK_PLAN), 'utf-8');
  return { app, tmpDir, wfDir, ticketPath, planPath };
}

async function checkFetcherExecuteSilent(app: any, ticketPath: string, tmpDir: string): Promise<void> {
  const fetcher = app.get(FetcherAgent);
  const origFetch = FetchStageService.prototype.fetchArtifact;
  (FetchStageService.prototype as any).fetchArtifact
    = async () => ({ ticketKey: 'WBP-TEST', content: MOCK_TICKET_CONTENT, path: ticketPath, fromCache: false });
  const cap = captureConsole();
  try {
    await fetcher.execute('WBP-TEST', { trackerName: 'jira', silent: true, baseDir: tmpDir });
  } finally {
    cap.restore();
  }
  assertSilent(cap.getOutput(), 'FetcherAgent.execute()');
  FetchStageService.prototype.fetchArtifact = origFetch;
}

async function checkFetcherLoadFromDiskSilent(app: any, tmpDir: string): Promise<void> {
  const fetcher = app.get(FetcherAgent);
  const cap = captureConsole();
  try {
    fetcher.loadFromDisk('WBP-TEST', 'jira', tmpDir, true);
  } finally {
    cap.restore();
  }
  assertSilent(cap.getOutput(), 'FetcherAgent.loadFromDisk()');
}

async function checkPlannerExecuteSilent(app: any, ticketPath: string, planPath: string): Promise<void> {
  const planner = app.get(PlannerAgent);
  const origCreate = PlanStageService.prototype.createPlanArtifact;
  (PlanStageService.prototype as any).createPlanArtifact
    = async () => ({ plan: MOCK_PLAN, action: 'fix', path: planPath, fromCache: false });
  const ticket = { ticketKey: 'WBP-TEST', content: MOCK_TICKET_CONTENT, path: ticketPath };
  const cap = captureConsole();
  try {
    await planner.execute(ticket, { action: 'fix', silent: true });
  } finally {
    cap.restore();
  }
  assertSilent(cap.getOutput(), 'PlannerAgent.execute()');
  PlanStageService.prototype.createPlanArtifact = origCreate;
}

async function checkPlannerLoadFromDiskSilent(app: any, ticketPath: string, planPath: string): Promise<void> {
  const planner = app.get(PlannerAgent);
  const origLoad = PlanStageService.prototype.loadPlanArtifact;
  (PlanStageService.prototype as any).loadPlanArtifact
    = async () => ({ plan: MOCK_PLAN, action: 'fix', path: planPath, fromCache: false });
  const cap = captureConsole();
  try {
    await planner.loadFromDisk(ticketPath, 'fix', true);
  } finally {
    cap.restore();
  }
  assertSilent(cap.getOutput(), 'PlannerAgent.loadFromDisk()');
  PlanStageService.prototype.loadPlanArtifact = origLoad;
}

async function checkReviewerExecuteSilent(app: any, ticketPath: string): Promise<void> {
  const reviewer = app.get(ReviewerAgent);
  const origGetStatus = GitService.prototype.getStatus;
  (GitService.prototype as any).getStatus = async () => ({ files: [] });
  const cap = captureConsole();
  try {
    await reviewer.execute({ ticketKey: 'WBP-TEST', content: MOCK_TICKET_CONTENT, path: ticketPath }, { silent: true });
  } finally {
    cap.restore();
  }
  assertSilent(cap.getOutput(), 'ReviewerAgent.execute()');
  GitService.prototype.getStatus = origGetStatus;
}

async function checkCommitterExecuteSilent(app: any, tmpDir: string): Promise<void> {
  const committer = app.get(CommitterAgent);
  const origGetStatus = GitService.prototype.getStatus;
  (GitService.prototype as any).getStatus = async () => ({ files: [] });
  const cap = captureConsole();
  try {
    await committer.execute('WBP-TEST', tmpDir, undefined, false, true);
  } finally {
    cap.restore();
  }
  assertSilent(cap.getOutput(), 'CommitterAgent.execute()');
  GitService.prototype.getStatus = origGetStatus;
}

async function checkFetcherExecuteNonSilent(app: any, ticketPath: string, tmpDir: string): Promise<void> {
  const fetcher = app.get(FetcherAgent);
  const origFetch = FetchStageService.prototype.fetchArtifact;
  (FetchStageService.prototype as any).fetchArtifact
    = async () => ({ ticketKey: 'WBP-TEST', content: MOCK_TICKET_CONTENT, path: ticketPath, fromCache: false });
  const cap = captureConsole();
  try {
    await fetcher.execute('WBP-TEST', { trackerName: 'jira', silent: false, baseDir: tmpDir });
  } finally {
    cap.restore();
  }
  assertFetcherNonSilentOutput(cap.getOutput());
  FetchStageService.prototype.fetchArtifact = origFetch;
}

async function main(): Promise<void> {
  console.log('\n🧪 Manual Test: --silent mode for agents\n');
  const { app, tmpDir, wfDir, ticketPath, planPath } = await setupTestEnv();
  await checkFetcherExecuteSilent(app, ticketPath, tmpDir);
  await checkFetcherLoadFromDiskSilent(app, tmpDir);
  await checkPlannerExecuteSilent(app, ticketPath, planPath);
  await checkPlannerLoadFromDiskSilent(app, ticketPath, planPath);
  await checkReviewerExecuteSilent(app, ticketPath);
  await checkCommitterExecuteSilent(app, tmpDir);
  await checkFetcherExecuteNonSilent(app, ticketPath, tmpDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(wfDir, { recursive: true, force: true });
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
