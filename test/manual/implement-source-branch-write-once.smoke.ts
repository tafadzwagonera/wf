/**
 * Manual smoke test: ImplementerAgent records the source branch once via a
 * real branch creation, and a later reuse run cannot overwrite it
 *
 * Verifies:
 *   1. A real branch creation (via real GitService.createBranch) records the
 *      resolved source branch onto the plan manifest, persisted to disk.
 *   2. Introducing a second, earlier-sorting dev-like branch before a second
 *      run would change what the heuristic re-resolves — but the manifest's
 *      already-recorded value survives unchanged (write-once), even though
 *      the second run switches source branches and re-touches the existing
 *      feature branch via GitService.createBranch's checkout-existing path.
 *   3. The second run still resolves to the same feature branch and still
 *      reports a "Source branch" status line via CliPresenter.
 *
 * Run: nr test:manual implement-source-branch-write-once.smoke.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import chalk from 'chalk';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { GitService, type CreateBranchOptions } from '../../src/integrations/git/git.service';
import { CliPresenter } from '../../src/common/presentation/cli-presenter.service';
import type { PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import {
  buildPlanArtifactManifest, buildPlanArtifactManifestPath, readPlanArtifactManifest, writePlanArtifactManifest,
} from '../../src/common/utils/plan-artifact';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

function createTestRepo(repoDir: string): void {
  git(repoDir, ['init', '-q', '-b', 'master']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# repo\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  git(repoDir, ['checkout', '-q', '-b', 'develop']);
  fs.appendFileSync(path.join(repoDir, 'README.md'), 'develop\n');
  git(repoDir, ['commit', '-q', '-am', 'develop work']);
  git(repoDir, ['checkout', '-q', 'master']);
}

function buildTestArtifacts(tempRoot: string): {
  ticket: TicketArtifact;
  planArtifact: PlanArtifact;
  manifestPath: string;
} {
  const ticket: TicketArtifact = { ticketKey: 'WBP-9001', content: '# WBP-9001: Write-once source branch smoke test\n', path: path.join(tempRoot, 'WBP-9001.md') };
  const planArtifact: PlanArtifact = {
    action: 'feature',
    path: path.join(tempRoot, 'WBP-9001-plan-feature.json'),
    plan: { action: 'feature', summary: 'Write-once source branch smoke test', steps: ['n/a'], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: ['repo'], risks: [] },
  };
  const manifestPath = buildPlanArtifactManifestPath(planArtifact.path);
  writePlanArtifactManifest(buildPlanArtifactManifest({ artifactPath: planArtifact.path, action: 'feature', format: 'json', hash: 'abc123', sourceName: 'WBP-9001', sourceKind: 'ticket', createdAt: new Date() }));
  return { ticket, planArtifact, manifestPath };
}

function checkTest1Results(createBranchCalls: string[], branchName: string, manifestAfterRun1: any): void {
  if (createBranchCalls.length === 1 && branchName) {
    pass(`Real branch '${branchName}' created (createBranch called once)`);
  } else {
    fail('Expected exactly one real createBranch call', `calls: ${JSON.stringify(createBranchCalls)}`);
  }
  if (manifestAfterRun1?.sourceBranch === 'develop') {
    pass("Manifest recorded sourceBranch: 'develop' (the only dev-like branch at this point)");
  } else {
    fail("Expected sourceBranch to be 'develop'", `got: ${JSON.stringify(manifestAfterRun1)}`);
  }
}

function spyOnCreateBranch(
  gitService: GitService,
  calls: string[],
): (...args: unknown[]) => unknown {
  const original = gitService.createBranch.bind(gitService);
  (gitService as any).createBranch = async (branchName: string, options?: CreateBranchOptions) => {
    calls.push(branchName);
    return original(branchName, options);
  };
  return original as (...args: unknown[]) => unknown;
}

async function runTest1(
  implementer: ImplementerAgent, gitService: GitService, ticket: TicketArtifact,
  planArtifact: PlanArtifact, repoDir: string, manifestPath: string,
): Promise<{ branchName: string; createBranchCalls: string[]; originalCreateBranch: (...args: unknown[]) => unknown }> {
  console.log(chalk.bold.cyan('\nTest 1: first run creates the branch for real and records its source'));
  const createBranchCalls: string[] = [];
  const originalCreateBranch = spyOnCreateBranch(gitService, createBranchCalls);
  const options = { trackerName: 'jira', repoDir, silent: true, suppressHeader: true };
  const branchName = await (implementer as any).handleBranchWorkflow(ticket, planArtifact, options);
  const manifestAfterRun1 = readPlanArtifactManifest(manifestPath);
  checkTest1Results(createBranchCalls, branchName, manifestAfterRun1);
  return { branchName, createBranchCalls, originalCreateBranch };
}

function prepareTest2(repoDir: string, branchName: string): void {
  git(repoDir, ['checkout', '-q', 'master']);
  git(repoDir, ['checkout', '-q', '-b', 'aaa-dev']);
  fs.appendFileSync(path.join(repoDir, 'README.md'), 'aaa-dev\n');
  git(repoDir, ['commit', '-q', '-am', 'aaa-dev work']);
  git(repoDir, ['checkout', '-q', branchName]);
}

function checkSourceBranchWriteOnce(manifestAfterRun2: any): void {
  if (manifestAfterRun2?.sourceBranch === 'develop') {
    pass("Manifest still records sourceBranch: 'develop' — write-once guard held despite aaa-dev now existing");
  } else {
    fail('Expected sourceBranch to remain develop', `got: ${JSON.stringify(manifestAfterRun2)}`);
  }
}

function checkPresenterReportedSource(presenterDetailCalls: Array<[string, string]>): void {
  if (presenterDetailCalls.some(([label]) => label === 'Source branch')) {
    pass('CliPresenter still reported a "Source branch" status line on the reuse run');
  } else {
    fail('Expected a "Source branch" presenter.detail call on the reuse run');
  }
}

function checkBranchNameConsistency(branchName2: string, branchName: string): void {
  if (branchName2 === branchName) {
    pass('Expected the second run to resolve the same branch name');
  } else {
    fail('Expected the second run to resolve the same branch name', `expected: ${branchName}, got: ${branchName2}`);
  }
}

function spyOnPresenterDetail(
  presenter: CliPresenter,
  calls: Array<[string, string]>,
): (...args: unknown[]) => unknown {
  const original = presenter.detail.bind(presenter);
  (presenter as any).detail = (label: string, value: string) => {
    calls.push([label, value]);
    return original(label, value);
  };
  return original as (...args: unknown[]) => unknown;
}

function prepareTest2Spy(presenter: CliPresenter, createBranchCalls: string[]): Array<[string, string]> {
  createBranchCalls.length = 0;
  const presenterDetailCalls: Array<[string, string]> = [];
  spyOnPresenterDetail(presenter, presenterDetailCalls);
  return presenterDetailCalls;
}

async function runTest2(
  implementer: ImplementerAgent, presenter: CliPresenter, repoDir: string,
  branchName: string, createBranchCalls: string[], ticket: TicketArtifact, planArtifact: PlanArtifact,
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 2: a new, earlier-sorting dev branch cannot override the recorded value'));
  const presenterDetailCalls = prepareTest2Spy(presenter, createBranchCalls);
  const branchName2 = await (implementer as any)
    .handleBranchWorkflow(ticket, planArtifact, { trackerName: 'jira', repoDir, silent: true, suppressHeader: true });
  const manifestAfterRun2 = readPlanArtifactManifest(buildPlanArtifactManifestPath(planArtifact.path));
  checkSourceBranchWriteOnce(manifestAfterRun2);
  checkPresenterReportedSource(presenterDetailCalls);
  checkBranchNameConsistency(branchName2, branchName);
}

async function cleanupTest(
  app: any,
  gitService: GitService,
  originalCreateBranch: (...args: unknown[]) => unknown,
  repoDir: string,
  tempRoot: string,
): Promise<void> {
  (gitService as any).createBranch = originalCreateBranch;
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
  await app.close();
}

async function buildContext(): Promise<{
  app: any;
  implementer: ImplementerAgent;
  gitService: GitService;
  presenter: CliPresenter;
}> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  return {
    app,
    implementer: app.get(ImplementerAgent),
    gitService: app.get(GitService),
    presenter: app.get(CliPresenter),
  };
}

async function main(): Promise<void> {
  console.log('Manual smoke: ImplementerAgent source-branch write-once\n');
  const { app, implementer, gitService, presenter } = await buildContext();
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-write-once-'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-write-once-artifacts-'));
  createTestRepo(repoDir);
  const { ticket, planArtifact, manifestPath } = buildTestArtifacts(tempRoot);
  const { branchName, createBranchCalls, originalCreateBranch }
    = await runTest1(implementer, gitService, ticket, planArtifact, repoDir, manifestPath);
  prepareTest2(repoDir, branchName);
  await runTest2(implementer, presenter, repoDir, branchName, createBranchCalls, ticket, planArtifact);
  await cleanupTest(app, gitService, originalCreateBranch, repoDir, tempRoot);
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
