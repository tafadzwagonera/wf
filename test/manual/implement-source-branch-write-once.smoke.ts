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
 * Run: nr test:manual -- test-implement-source-branch-write-once
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
import { CliPresenter } from '../../src/shared/presentation/cli-presenter.service';
import type { PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import {
  buildPlanArtifactManifest, buildPlanArtifactManifestPath, readPlanArtifactManifest, writePlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

async function main(): Promise<void> {
  console.log('Manual smoke: ImplementerAgent source-branch write-once\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const implementer = app.get(ImplementerAgent);
  const gitService = app.get(GitService);
  const presenter = app.get(CliPresenter);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-write-once-'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'implement-write-once-artifacts-'));

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

  const ticket: TicketArtifact = {
    ticketKey: 'WBP-9001',
    content: '# WBP-9001: Write-once source branch smoke test\n',
    path: path.join(tempRoot, 'WBP-9001.md'),
  };
  const planArtifact: PlanArtifact = {
    action: 'feature',
    path: path.join(tempRoot, 'WBP-9001-plan-feature.json'),
    plan: {
      action: 'feature',
      summary: 'Write-once source branch smoke test',
      steps: ['n/a'],
      estimatedComplexity: 'low',
      affectedFiles: [],
      affectedRepositories: ['repo'],
      risks: [],
    },
  };
  const manifestPath = buildPlanArtifactManifestPath(planArtifact.path);
  // ImplementerAgent only UPDATES an existing manifest (normally created by `issue:plan`) — it
  // never creates one itself, so the write-once update has nothing to write onto otherwise.
  writePlanArtifactManifest(
    buildPlanArtifactManifest({ artifactPath: planArtifact.path, action: 'feature', format: 'json', hash: 'abc123', sourceName: 'WBP-9001', sourceKind: 'ticket', createdAt: new Date() })
  );

  console.log(chalk.bold.cyan('\nTest 1: first run creates the branch for real and records its source'));
  const createBranchCalls: string[] = [];
  const originalCreateBranch = gitService.createBranch.bind(gitService);
  (gitService as any).createBranch = async (branchName: string, options?: CreateBranchOptions) => {
    createBranchCalls.push(branchName);
    return originalCreateBranch(branchName, options);
  };

  // handleBranchWorkflow covers exactly the branch creation/reuse + manifest-recording logic
  // under test, without reaching the AI backend call further down execute() — avoiding a real,
  // costly AI invocation for a test that has nothing to do with AI behavior.
  const options = { trackerName: 'jira', repoDir, silent: true, suppressHeader: true };
  const branchName = await (implementer as any).handleBranchWorkflow(ticket, planArtifact, options);

  if (createBranchCalls.length === 1 && branchName) {
    pass(`Real branch '${branchName}' created (createBranch called once)`);
  } else {
    fail('Expected exactly one real createBranch call', `calls: ${JSON.stringify(createBranchCalls)}`);
  }

  const manifestAfterRun1 = readPlanArtifactManifest(manifestPath);
  if (manifestAfterRun1?.sourceBranch === 'develop') {
    pass("Manifest recorded sourceBranch: 'develop' (the only dev-like branch at this point)");
  } else {
    fail("Expected sourceBranch to be 'develop'", `got: ${JSON.stringify(manifestAfterRun1)}`);
  }

  console.log(chalk.bold.cyan('\nTest 2: a new, earlier-sorting dev branch cannot override the recorded value'));
  git(repoDir, ['checkout', '-q', 'master']);
  git(repoDir, ['checkout', '-q', '-b', 'aaa-dev']); // sorts before 'develop'; would win the heuristic if re-resolved
  fs.appendFileSync(path.join(repoDir, 'README.md'), 'aaa-dev\n');
  git(repoDir, ['commit', '-q', '-am', 'aaa-dev work']);
  git(repoDir, ['checkout', '-q', branchName as string]); // back onto the already-created feature branch

  createBranchCalls.length = 0;
  const presenterDetailCalls: Array<[string, string]> = [];
  const originalDetail = presenter.detail.bind(presenter);
  (presenter as any).detail = (label: string, value: string) => {
    presenterDetailCalls.push([label, value]);
    return originalDetail(label, value);
  };

  const branchName2 = await (implementer as any).handleBranchWorkflow(ticket, planArtifact, options);

  const manifestAfterRun2 = readPlanArtifactManifest(manifestPath);
  if (manifestAfterRun2?.sourceBranch === 'develop') {
    pass("Manifest still records sourceBranch: 'develop' — write-once guard held despite aaa-dev now existing");
  } else {
    fail('Expected sourceBranch to remain develop', `got: ${JSON.stringify(manifestAfterRun2)}`);
  }

  if (presenterDetailCalls.some(([label]) => label === 'Source branch')) {
    pass('CliPresenter still reported a "Source branch" status line on the reuse run');
  } else {
    fail('Expected a "Source branch" presenter.detail call on the reuse run');
  }

  if (branchName2 !== branchName) {
    fail('Expected the second run to resolve the same branch name', `expected: ${branchName}, got: ${branchName2}`);
  }

  (gitService as any).createBranch = originalCreateBranch;
  (presenter as any).detail = originalDetail;

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: ImplementerAgent source-branch write-once');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
