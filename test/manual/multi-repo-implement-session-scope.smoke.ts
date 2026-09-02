/**
 * Smoke test: multi-repo implement scopes resumeProviderSessionId to the primary repo only
 *
 * Run: nr test:manual -- multi-repo-implement-session-scope
 *
 * Scenario: When runImplementLoop runs across two repos with an active session ID,
 * scopeSessionContextToRepo must pass resumeProviderSessionId only to the primary repo
 * and strip it for every secondary repo. The loop's return value must carry the PRIMARY
 * repo's emitted session ID — not the last-processed repo's.
 *
 * Verify:
 *   1. First implementer call (repoA) receives resumeProviderSessionId: 'sess-plan-1'
 *   2. Second implementer call (repoB) has no resumeProviderSessionId
 *   3. priorStageSummary is preserved on the second call despite stripping the session ID
 *   4. result.primaryRepoSessionId equals 'sess-impl-repo-a' (primary repo's emitted ID)
 *   5. result.primaryRepoSessionId is NOT 'sess-impl-repo-b' (secondary repo's emitted ID)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import { createReporter } from './support/reporter';
import type { PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: multi-repo implement session scoping\n'));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-impl-scope-'));
  const repoADir = path.join(tempRoot, 'repoA');
  const repoBDir = path.join(tempRoot, 'repoB');
  fs.mkdirSync(repoADir, { recursive: true });
  fs.mkdirSync(repoBDir, { recursive: true });

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const command = app.get(IssueCommand);
    const capturedOpts: Record<string, unknown>[] = [];

    (command as any).agents = {
      implementer: {
        execute: async (_ticket: unknown, _plan: unknown, opts: Record<string, unknown>) => {
          capturedOpts.push({ ...opts });
          const repoDir = String(opts['repoDir'] ?? '');
          const sessionId = repoDir.endsWith('repoA') ? 'sess-impl-repo-a' : 'sess-impl-repo-b';
          return { type: 'implementation', hasChanges: true, branchName: null, sessionId, verificationOutcomes: [] };
        },
      },
    };

    const ticketArtifact: TicketArtifact = { ticketKey: 'TEST-1', content: '# TEST-1', path: '/tmp/test.md' };
    const planArtifact: PlanArtifact = {
      action: 'fix',
      path: '/tmp/plan.json',
      plan: {
        action: 'fix', summary: 'test', steps: [],
        estimatedComplexity: 'low' as const,
        affectedFiles: [], affectedRepositories: [],
      },
    };

    const result = await (command as any).runImplementLoop(
      ticketArtifact, planArtifact,
      [repoADir, repoBDir],
      { silent: true },
      { resumeProviderSessionId: 'sess-plan-1', priorStageSummary: 'prior summary' },
      repoADir,
    );

    const firstOpts = capturedOpts[0] ?? {};
    const secondOpts = capturedOpts[1] ?? {};

    if (firstOpts['resumeProviderSessionId'] === 'sess-plan-1') {
      pass('primary repo (repoA) receives resumeProviderSessionId: sess-plan-1');
    } else {
      fail('primary repo should receive resumeProviderSessionId', JSON.stringify(firstOpts));
    }

    if (secondOpts['resumeProviderSessionId'] === undefined) {
      pass('secondary repo (repoB) resumeProviderSessionId is undefined');
    } else {
      fail('secondary repo should NOT receive resumeProviderSessionId', JSON.stringify(secondOpts));
    }

    if (secondOpts['priorStageSummary'] === 'prior summary') {
      pass('secondary repo preserves priorStageSummary despite stripping session ID');
    } else {
      fail('secondary repo should preserve priorStageSummary', JSON.stringify(secondOpts));
    }

    if (result?.primaryRepoSessionId === 'sess-impl-repo-a') {
      pass("result.primaryRepoSessionId equals primary repo's emitted session ID");
    } else {
      fail('result.primaryRepoSessionId should equal sess-impl-repo-a', JSON.stringify(result));
    }

    if (result?.primaryRepoSessionId === 'sess-impl-repo-a') {
      pass("result.primaryRepoSessionId is the primary repo's session ID (secondary repo's excluded)");
    } else {
      fail('result.primaryRepoSessionId should be sess-impl-repo-a', JSON.stringify(result));
    }
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(chalk.bold(`\nSummary: ${counts.passed} passed, ${counts.failed} failed`));
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
