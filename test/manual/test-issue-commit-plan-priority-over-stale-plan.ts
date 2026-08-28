/**
 * Manual smoke test: full workflow commit stage prefers its own plan artifact
 * over a stale on-disk plan for the same ticket
 *
 * Run: nr test:manual -- test-issue-commit-plan-priority-over-stale-plan
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

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(`  ✓ ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.error(`  ✗ ${msg}${detail ? `\n    → ${detail}` : ''}`);
  failed++;
};
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

async function main(): Promise<void> {
  console.log('\nManual smoke test: commit stage prefers its own plan over a stale on-disk plan\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueCommand);
  const commitStageService = app.get(CommitStageService);

  const originalGenerate = commitStageService.generateCommitMessage.bind(commitStageService);
  let capturedOptions: Parameters<typeof commitStageService.generateCommitMessage>[0] | undefined;
  commitStageService.generateCommitMessage = async options => {
    capturedOptions = options;
    return 'canned commit message for live smoke test';
  };

  const tmpWfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-priority-home-'));
  const originalWfHome = process.env.WF_HOME;
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-priority-repo-'));

  try {
    process.env.WF_HOME = tmpWfHome;

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

    const ticketKey = 'WBP-9001';
    const trackerName = 'jira';
    const repoBasename = path.basename(tmpRepo);
    const artifactDir = path.join(tmpWfHome, repoBasename, trackerName);
    fs.mkdirSync(artifactDir, { recursive: true });

    const stalePlanPath = path.join(artifactDir, '2020-01-01-aaa111-fix-plan.json');
    fs.writeFileSync(stalePlanPath, JSON.stringify({ action: 'fix', summary: 'STALE PLAN SUMMARY' }));
    writePlanArtifactManifest(
      buildPlanArtifactManifest({ artifactPath: stalePlanPath, action: 'fix', format: 'json', hash: 'aaa111', sourceName: ticketKey, sourceKind: 'ticket', createdAt: new Date('2020-01-01'), trackerName: trackerName })
    );

    const diskOnly = resolveCommitScopeSummary(tmpRepo, trackerName, ticketKey);
    assert(
      'sanity check: stale plan is genuinely discoverable via the generic disk search',
      diskOnly === 'STALE PLAN SUMMARY',
      `got: ${diskOnly}`
    );

    const planArtifact: PlanArtifact = {
      action: 'fix',
      path: path.join(artifactDir, '2026-08-21-bbb222-fix-plan.json'),
      plan: { action: 'fix', summary: 'FRESH PLAN SUMMARY', steps: [], estimatedComplexity: 'low' },
    };

    let consoleOutput = '';
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput += args.join(' ') + '\n';
    };
    try {
      await (command as unknown as {
        executeCommitStage: (
          ticketKey: string, planArtifact: PlanArtifact, repos: string[], options: unknown, trackerName: string
        ) => Promise<void>;
      }).executeCommitStage(ticketKey, planArtifact, [tmpRepo], { silent: false }, trackerName);
    } finally {
      console.log = originalLog;
    }

    assert(
      "commit message generator received the run's own FRESH plan summary, not the stale on-disk one",
      capturedOptions?.ticketContext === 'FRESH PLAN SUMMARY',
      `got: ${JSON.stringify(capturedOptions)}`
    );
    assert(
      'no divergence note printed — the fresh plan is exactly what was used',
      !consoleOutput.includes('Using scope summary from prior review/plan'),
      consoleOutput
    );

    const gitLog = execSync('git log -1 --format=%B', { cwd: tmpRepo, encoding: 'utf-8' });
    assert('a real git commit was created', gitLog.includes('canned commit message for live smoke test'), gitLog);
  } finally {
    commitStageService.generateCommitMessage = originalGenerate;
    if (originalWfHome) process.env.WF_HOME = originalWfHome;
    else delete process.env.WF_HOME;
    fs.rmSync(tmpWfHome, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    await app.close();
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
