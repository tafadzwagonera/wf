/**
 * Manual smoke test: standalone issue:commit resolves scope summary from an
 * on-disk review artifact through the real command pipeline
 *
 * Run: nr test:manual issue-commit-standalone-review-scope-live.smoke.ts
 *
 * Spins up the real NestJS app context and drives IssueCommitCommand's real
 * `.run()` against a real git repo with a staged change and a real review
 * artifact on disk. Only the outbound commit-message call (CommitStageService.
 * generateCommitMessage) is stubbed, so the resolution path — trackerName
 * lookup, resolveArtifactDir, the commit-description freshness guard, the
 * printed note — is exercised through real DI-wired collaborators, not by
 * calling resolveCommitScopeSummary directly. Run 2 makes one live AI call
 * (inline commit-description generation from the staged diff).
 *
 * Verifies:
 *   1. With a review artifact and a FRESH commit-description sidecar (sha256
 *      matching the staged diff) on disk, the command prints the
 *      "prior review/plan" note and threads the sidecar's rendered
 *      description into the commit message generator without regenerating
 *   2. A real git commit is created reflecting the (stubbed) generated message
 *   3. With both artifacts removed, a second real run prints no note and
 *      falls back to a live inline-generated diff-grounded description
 *      ("... (change nature: <nature>)"), never an empty scope summary
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommitCommand } from '../../src/commands/issue-commit.command';
import { CommitStageService } from '../../src/workflows/stages/commit-stage.service';
import { resolveReviewArtifactPath } from '../../src/common/utils/resolve-review-summary';
import {
  deriveCommitDescriptionPath,
  hashCommitDescriptionDiff,
} from '../../src/common/utils/commit-description-artifact';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/common/testing/env';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const stageChange = (repoDir: string, contents: string): void => {
  const run = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: repoDir, stdio: 'pipe' });
  };
  fs.writeFileSync(path.join(repoDir, 'a.ts'), contents);
  run('add .');
};

function stubCommitStage(service: CommitStageService): { getCaptured: () => any; restore: () => void } {
  const original = service.generateCommitMessage.bind(service);
  let capturedOptions: Parameters<typeof service.generateCommitMessage>[0] | undefined;
  let callCount = 0;
  service.generateCommitMessage = async options => {
    capturedOptions = options;
    callCount++;
    return `canned commit message #${callCount}`;
  };
  return {
    getCaptured: () => capturedOptions,
    restore: () => { service.generateCommitMessage = original; },
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
}

function createReviewArtifact(tmpRepo: string, trackerName: string, ticketKey: string): string {
  const reviewPath = resolveReviewArtifactPath(tmpRepo, trackerName, ticketKey);
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  fs.writeFileSync(
    reviewPath,
    `# Code Review: ${ticketKey}\n\n## Summary\nLIVE REVIEW SCOPE SUMMARY\n\n## Issues\n- none\n`
  );
  return reviewPath;
}

function setupTempDirectories(prefix1: string, prefix2: string): [string, string] {
  const tmpWfHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix1));
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), prefix2));
  return [tmpWfHome, tmpRepo];
}

async function setupScenarioFixtures(tmpRepo: string, trackerName: string, ticketKey: string): Promise<string> {
  setupRepo(tmpRepo);
  return createReviewArtifact(tmpRepo, trackerName, ticketKey);
}

function cleanupScenarioFixtures(tmpWfHome: string, tmpRepo: string): void {
  restoreEnv();
  fs.rmSync(tmpWfHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
}

function buildScenarioOpts(ticketKey: string, tmpRepo: string, trackerName: string): object {
  return { ticketKey, repos: [tmpRepo], tracker: trackerName };
}

async function captureRun(commitCmd: IssueCommitCommand, opts: object): Promise<string> {
  let consoleOutput = '';
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleOutput += args.join(' ') + '\n';
  };
  try {
    await commitCmd.run([], opts);
  } finally {
    console.log = originalLog;
  }
  return consoleOutput;
}

function checkRun1Note(consoleOutput: string): void {
  assert('run 1: prints the prior review/plan note', consoleOutput.includes('Using scope summary from prior review/plan'), consoleOutput);
}

function checkRun1Summary(capturedOptions: any): void {
  assert(
    'run 1: commit message generator received the fresh sidecar description without regenerating',
    capturedOptions?.scopeSummary === 'LIVE SIDECAR DESCRIPTION (change nature: fix)',
    `got: ${JSON.stringify(capturedOptions)}`
  );
}

function checkRun1Commit(gitLog: string): void {
  assert('run 1: a real git commit was created', gitLog.toLowerCase().includes('canned commit message #1'), gitLog);
}

function checkRun2Note(consoleOutput: string): void {
  assert('run 2: no prior review/plan note once the artifacts are gone', !consoleOutput.includes('Using scope summary from prior review/plan'), consoleOutput);
}

function checkRun2Summary(capturedOptions: any): void {
  assert(
    'run 2: an inline diff-grounded description is generated once the artifacts are gone',
    /\(change nature: [a-z]+\)$/.test(capturedOptions?.scopeSummary ?? ''),
    `got: ${JSON.stringify(capturedOptions)}`
  );
}

function checkRun2Commit(gitLog: string): void {
  assert('run 2: a second real git commit was created', gitLog.toLowerCase().includes('canned commit message #2'), gitLog);
}

function writeFreshSidecar(tmpRepo: string, reviewPath: string): void {
  const stagedDiff = execSync('git diff --staged', { cwd: tmpRepo, encoding: 'utf-8' });
  fs.writeFileSync(
    deriveCommitDescriptionPath(reviewPath),
    JSON.stringify({
      nature: 'fix',
      description: 'LIVE SIDECAR DESCRIPTION',
      diffSha256: hashCommitDescriptionDiff(stagedDiff),
    })
  );
}

async function executeRun1(
  commitCmd: IssueCommitCommand,
  getCaptured: () => any,
  tmpRepo: string,
  reviewPath: string,
  opts: object,
): Promise<void> {
  stageChange(tmpRepo, 'export const a = 2;\n');
  writeFreshSidecar(tmpRepo, reviewPath);
  const run1Output = await captureRun(commitCmd, opts);
  checkRun1Note(run1Output);
  checkRun1Summary(getCaptured());
  checkRun1Commit(execSync('git log -1 --format=%B', { cwd: tmpRepo, encoding: 'utf-8' }));
}

async function executeRun2(
  commitCmd: IssueCommitCommand,
  getCaptured: () => any,
  tmpRepo: string,
  reviewPath: string,
  opts: object,
): Promise<void> {
  fs.rmSync(reviewPath);
  fs.rmSync(deriveCommitDescriptionPath(reviewPath), { force: true });
  stageChange(tmpRepo, 'export const a = 3;\n');
  const run2Output = await captureRun(commitCmd, opts);
  checkRun2Note(run2Output);
  checkRun2Summary(getCaptured());
  checkRun2Commit(execSync('git log -1 --format=%B', { cwd: tmpRepo, encoding: 'utf-8' }));
}

async function executeRuns(
  commitCmd: IssueCommitCommand,
  getCaptured: () => any,
  tmpRepo: string,
  reviewPath: string,
  opts: object,
): Promise<void> {
  await executeRun1(commitCmd, getCaptured, tmpRepo, reviewPath, opts);
  await executeRun2(commitCmd, getCaptured, tmpRepo, reviewPath, opts);
}

async function runScenario(
  commitCmd: IssueCommitCommand,
  getCaptured: () => any,
  ticketKey: string,
  trackerName: string,
): Promise<void> {
  const [tmpWfHome, tmpRepo] = setupTempDirectories('wf-standalone-review-home-', 'wf-standalone-review-repo-');
  withEnv({ WF_HOME: tmpWfHome });
  try {
    const reviewPath = await setupScenarioFixtures(tmpRepo, trackerName, ticketKey);
    await executeRuns(commitCmd, getCaptured, tmpRepo, reviewPath, buildScenarioOpts(ticketKey, tmpRepo, trackerName));
  } finally {
    cleanupScenarioFixtures(tmpWfHome, tmpRepo);
  }
}

async function main(): Promise<void> {
  console.log('\nManual smoke test: standalone issue:commit resolves scope summary from a real review artifact\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const commitCmd = app.get(IssueCommitCommand);
  const stub = stubCommitStage(app.get(CommitStageService));
  try {
    await runScenario(commitCmd, stub.getCaptured, 'WBP-9002', 'jira');
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
