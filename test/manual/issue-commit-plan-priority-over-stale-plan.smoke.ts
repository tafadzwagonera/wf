/**
 * Manual smoke test: full workflow commit stage prefers its own plan artifact
 * over a stale on-disk plan for the same ticket
 *
 * Run: nr test:manual issue-commit-plan-priority-over-stale-plan.smoke.ts
 *
 * Spins up the real NestJS app context and drives IssueCommand's actual
 * executeCommitStage against a real git repo and a real WF_HOME artifact
 * tree. Only the outbound AI call (CommitStageService.generateCommitMessage)
 * is stubbed, so the fix under test — preferring the run's own planArtifact
 * over a generic ticketKey-matched disk search — is exercised through real
 * DI-wired collaborators (GitService, CommitterAgent, resolveCommitScopeSummary
 * reading real files), not by calling an isolated utility function directly.
 *
 * Verifies:
 *   1. A stale on-disk plan for the same ticketKey is genuinely discoverable
 *      via the generic disk search (sanity check on the test fixture itself)
 *   2. executeCommitStage threads the run's own (fresh) plan summary into the
 *      commit message generator, not the stale on-disk one
 *   3. No "prior review/plan" divergence note is printed (the fresh plan is
 *      what was used — there is nothing to flag as different)
 *   4. A real git commit is created in the target repo
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import { CommitStageService } from '../../src/workflows/stages/commit-stage.service';
import { resolveCommitScopeSummary } from '../../src/shared/utils/resolve-commit-scope-summary';
import { buildPlanArtifactManifest, writePlanArtifactManifest } from '../../src/shared/utils/plan-artifact';
import type { PlanArtifact } from '../../src/shared/types/agent.types';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/shared/testing/env';

const TICKET_KEY = 'WBP-9001';
const TRACKER_NAME = 'jira';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

function stubCommitStage(commitStageService: CommitStageService): { getCaptured: () => any; restore: () => void } {
  const original = commitStageService.generateCommitMessage.bind(commitStageService);
  let capturedOptions: Parameters<typeof commitStageService.generateCommitMessage>[0] | undefined;
  commitStageService.generateCommitMessage = async options => {
    capturedOptions = options;
    return 'canned commit message for live smoke test';
  };
  return {
    getCaptured: () => capturedOptions,
    restore: () => { commitStageService.generateCommitMessage = original; },
  };
}

function setupRepo(tmpRepo: string): void {
  const git = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: tmpRepo, stdio: 'pipe' });
  };
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  fs.writeFileSync(path.join(tmpRepo, 'a.ts'), 'export const a = 1;\n');
  git('add .');
  git('commit -m init');
  fs.writeFileSync(path.join(tmpRepo, 'a.ts'), 'export const a = 2;\n');
}

function writeStalePlan(artifactDir: string): void {
  const stalePlanPath = path.join(artifactDir, '2020-01-01-aaa111-fix-plan.json');
  fs.writeFileSync(stalePlanPath, JSON.stringify({ action: 'fix', summary: 'STALE PLAN SUMMARY' }));
  writePlanArtifactManifest(
    buildPlanArtifactManifest({
      artifactPath: stalePlanPath, action: 'fix', format: 'json', hash: 'aaa111',
      sourceName: TICKET_KEY, sourceKind: 'ticket', createdAt: new Date('2020-01-01'), trackerName: TRACKER_NAME,
    })
  );
}

function setupFixture(tmpWfHome: string, tmpRepo: string): string {
  const artifactDir = path.join(tmpWfHome, path.basename(tmpRepo), TRACKER_NAME);
  fs.mkdirSync(artifactDir, { recursive: true });
  writeStalePlan(artifactDir);
  return artifactDir;
}

function buildFreshPlanArtifact(artifactDir: string): PlanArtifact {
  return {
    action: 'fix',
    path: path.join(artifactDir, '2026-08-21-bbb222-fix-plan.json'),
    plan: { action: 'fix', summary: 'FRESH PLAN SUMMARY', steps: [], estimatedComplexity: 'low' },
  };
}

function setupConsoleCapture(): { restore: () => void; getOutput: () => string } {
  let consoleOutput = '';
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleOutput += args.join(' ') + '\n';
  };
  return {
    restore: () => {
      console.log = originalLog;
    },
    getOutput: () => consoleOutput,
  };
}

async function runWithCapturedConsole(
  command: IssueCommand, planArtifact: PlanArtifact, tmpRepo: string
): Promise<string> {
  const capture = setupConsoleCapture();
  try {
    await (command as unknown as {
      executeCommitStage: (k: string, p: PlanArtifact, r: string[], o: unknown, t: string, c: boolean) => Promise<void>;
    }).executeCommitStage(TICKET_KEY, planArtifact, [tmpRepo], { silent: false }, TRACKER_NAME, false);
  } finally {
    capture.restore();
  }
  return capture.getOutput();
}

function checkSanityStaleDiscoverable(tmpRepo: string): void {
  const diskOnly = resolveCommitScopeSummary({
    repoBaseDir: tmpRepo, trackerName: TRACKER_NAME, ticketKey: TICKET_KEY,
  });
  assert('sanity check: stale plan is genuinely discoverable via the generic disk search', diskOnly === 'STALE PLAN SUMMARY', `got: ${diskOnly}`);
}

function checkFreshPlanUsed(capturedOptions: { ticketContext?: string } | undefined): void {
  assert(
    "commit message generator received the run's own FRESH plan summary, not the stale on-disk one",
    capturedOptions?.ticketContext === 'FRESH PLAN SUMMARY',
    `got: ${JSON.stringify(capturedOptions)}`
  );
}

function checkNoDivergenceNote(consoleOutput: string): void {
  assert('no divergence note printed — the fresh plan is exactly what was used', !consoleOutput.includes('Using scope summary from prior review/plan'), consoleOutput);
}

function checkCommitCreated(gitLog: string): void {
  assert('a real git commit was created', gitLog.includes('canned commit message for live smoke test'), gitLog);
}

async function runScenarioBody(
  command: IssueCommand,
  tmpWfHome: string,
  tmpRepo: string,
  getCaptured: () => any,
): Promise<{ consoleOutput: string; gitLog: string; capturedOptions: any }> {
  setupRepo(tmpRepo);
  const artifactDir = setupFixture(tmpWfHome, tmpRepo);
  checkSanityStaleDiscoverable(tmpRepo);
  const planArtifact = buildFreshPlanArtifact(artifactDir);
  const consoleOutput = await runWithCapturedConsole(command, planArtifact, tmpRepo);
  const gitLog = execSync('git log -1 --format=%B', { cwd: tmpRepo, encoding: 'utf-8' });
  return { consoleOutput, gitLog, capturedOptions: getCaptured() };
}

async function executeScenario(
  command: IssueCommand,
  getCaptured: () => any,
): Promise<{ consoleOutput: string; gitLog: string; capturedOptions: any }> {
  const tmpWfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-priority-home-'));
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-priority-repo-'));
  withEnv({ WF_HOME: tmpWfHome });
  try {
    return await runScenarioBody(command, tmpWfHome, tmpRepo, getCaptured);
  } finally {
    restoreEnv();
    fs.rmSync(tmpWfHome, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log('\nManual smoke test: commit stage prefers its own plan over a stale on-disk plan\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const stub = stubCommitStage(app.get(CommitStageService));
  try {
    const { capturedOptions, consoleOutput, gitLog } = await executeScenario(app.get(IssueCommand), stub.getCaptured);
    checkFreshPlanUsed(capturedOptions);
    checkNoDivergenceNote(consoleOutput);
    checkCommitCreated(gitLog);
  } finally {
    stub.restore();
    await app.close();
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
