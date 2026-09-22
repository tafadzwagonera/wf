/**
 * Smoke test: multi-repo review scopes resumeProviderSessionId to the primary repo only
 *
 * Run: nr test:manual multi-repo-review-session-scope.smoke.ts
 *
 * Scenario: When runReviewForRepo processes repos with a primaryRepo set in the
 * ReviewRepoContext, scopeSessionContextToRepo must pass resumeProviderSessionId only to
 * the primary repo's reviewer call and strip it for every secondary repo call.
 *
 * Verify:
 *   1. Primary repo (repoA) reviewer call receives resumeProviderSessionId: 'sess-impl-1'
 *   2. Secondary repo (repoB) reviewer call has no resumeProviderSessionId
 *   3. priorStageSummary is preserved on the secondary repo's call despite stripping
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import { createReporter, summarise } from './support/reporter';
import type { TicketArtifact } from '../../src/agents/interfaces';

const { counts, pass, fail } = createReporter();

function buildTempDirs(): { tempRoot: string; repoADir: string; repoBDir: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-review-scope-'));
  const repoADir = path.join(tempRoot, 'repoA');
  const repoBDir = path.join(tempRoot, 'repoB');
  fs.mkdirSync(repoADir, { recursive: true });
  fs.mkdirSync(repoBDir, { recursive: true });
  return { tempRoot, repoADir, repoBDir };
}

function buildSessionContext(): Record<string, unknown> {
  return {
    resumeProviderSessionId: 'sess-impl-1',
    priorStageSummary: 'prior summary',
    forkSession: undefined,
    estimatedComplexity: undefined,
    passCount: undefined,
  };
}

function buildBaseContext(repoADir: string, repoBDir: string, ticketArtifact: TicketArtifact): Record<string, unknown> {
  return {
    isMultiRepo: true,
    options: { silent: true },
    planArtifact: undefined,
    repos: [repoADir, repoBDir],
    sessionContext: buildSessionContext(),
    ticketArtifact,
    ticketKey: 'TEST-1',
    primaryRepo: repoADir,
  };
}

function buildReviewerMock(capturedOpts: Record<string, unknown>[]): Record<string, unknown> {
  return {
    reviewer: {
      execute: async (_ticket: unknown, opts: Record<string, unknown>) => {
        capturedOpts.push({ ...opts });
        return null;
      },
      persistArtifact: async () => {},
    },
  };
}

type ScenarioResult = {
  primaryOpts: Record<string, unknown>;
  secondaryOpts: Record<string, unknown>;
};

async function captureReviewOpts(
  app: any,
  repoADir: string,
  repoBDir: string,
): Promise<Record<string, unknown>[]> {
  const command = app.get(IssueCommand);
  const capturedOpts: Record<string, unknown>[] = [];
  command.agents = buildReviewerMock(capturedOpts);
  const ticketArtifact: TicketArtifact = { ticketKey: 'TEST-1', content: '# TEST-1', path: '/tmp/test.md' };
  const baseContext = buildBaseContext(repoADir, repoBDir, ticketArtifact);
  await command.runReviewForRepo(repoADir, baseContext);
  await command.runReviewForRepo(repoBDir, baseContext);
  return capturedOpts;
}

async function runScenario(): Promise<ScenarioResult> {
  const { tempRoot, repoADir, repoBDir } = buildTempDirs();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const capturedOpts = await captureReviewOpts(app, repoADir, repoBDir);
    return { primaryOpts: capturedOpts[0] ?? {}, secondaryOpts: capturedOpts[1] ?? {} };
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function checkPrimaryRepoReceivesSessionId(primaryOpts: Record<string, unknown>): void {
  if (primaryOpts['resumeProviderSessionId'] === 'sess-impl-1') {
    pass('primary repo (repoA) reviewer receives resumeProviderSessionId: sess-impl-1');
  } else {
    fail('primary repo reviewer should receive resumeProviderSessionId', JSON.stringify(primaryOpts));
  }
}

function checkSecondaryRepoStripsSessionId(secondaryOpts: Record<string, unknown>): void {
  if (secondaryOpts['resumeProviderSessionId'] === undefined) {
    pass('secondary repo (repoB) reviewer resumeProviderSessionId is undefined');
  } else {
    fail('secondary repo reviewer resumeProviderSessionId should be undefined', JSON.stringify(secondaryOpts));
  }
}

function checkSecondaryRepoPreservesPriorStageSummary(secondaryOpts: Record<string, unknown>): void {
  if (secondaryOpts['priorStageSummary'] === 'prior summary') {
    pass('secondary repo reviewer preserves priorStageSummary despite stripping session ID');
  } else {
    fail('secondary repo reviewer should preserve priorStageSummary', JSON.stringify(secondaryOpts));
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: multi-repo review session scoping\n'));
  const { primaryOpts, secondaryOpts } = await runScenario();
  checkPrimaryRepoReceivesSessionId(primaryOpts);
  checkSecondaryRepoStripsSessionId(secondaryOpts);
  checkSecondaryRepoPreservesPriorStageSummary(secondaryOpts);
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
