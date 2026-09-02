/**
 * Smoke test: multi-repo review scopes resumeProviderSessionId to the primary repo only
 *
 * Run: nr test:manual -- multi-repo-review-session-scope
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
import { createReporter } from './support/reporter';
import type { TicketArtifact } from '../../src/agents/interfaces';

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: multi-repo review session scoping\n'));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-review-scope-'));
  const repoADir = path.join(tempRoot, 'repoA');
  const repoBDir = path.join(tempRoot, 'repoB');
  fs.mkdirSync(repoADir, { recursive: true });
  fs.mkdirSync(repoBDir, { recursive: true });

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const command = app.get(IssueCommand);
    const capturedOpts: Record<string, unknown>[] = [];

    (command as any).agents = {
      reviewer: {
        execute: async (_ticket: unknown, opts: Record<string, unknown>) => {
          capturedOpts.push({ ...opts });
          return null;
        },
        persistArtifact: async () => {},
      },
    };

    const ticketArtifact: TicketArtifact = { ticketKey: 'TEST-1', content: '# TEST-1', path: '/tmp/test.md' };
    const sessionContext = {
      resumeProviderSessionId: 'sess-impl-1',
      priorStageSummary: 'prior summary',
      forkSession: undefined,
      estimatedComplexity: undefined,
      passCount: undefined,
    };
    const baseContext = {
      isMultiRepo: true,
      options: { silent: true },
      planArtifact: undefined,
      repos: [repoADir, repoBDir],
      sessionContext,
      ticketArtifact,
      ticketKey: 'TEST-1',
      primaryRepo: repoADir,
    };

    await (command as any).runReviewForRepo(repoADir, baseContext);
    await (command as any).runReviewForRepo(repoBDir, baseContext);

    const primaryOpts = capturedOpts[0] ?? {};
    const secondaryOpts = capturedOpts[1] ?? {};

    if (primaryOpts['resumeProviderSessionId'] === 'sess-impl-1') {
      pass('primary repo (repoA) reviewer receives resumeProviderSessionId: sess-impl-1');
    } else {
      fail('primary repo reviewer should receive resumeProviderSessionId', JSON.stringify(primaryOpts));
    }

    if (!secondaryOpts['resumeProviderSessionId']) {
      pass('secondary repo (repoB) reviewer has no resumeProviderSessionId');
    } else {
      fail('secondary repo reviewer should NOT receive resumeProviderSessionId', JSON.stringify(secondaryOpts));
    }

    if (secondaryOpts['priorStageSummary'] === 'prior summary') {
      pass('secondary repo reviewer preserves priorStageSummary despite stripping session ID');
    } else {
      fail('secondary repo reviewer should preserve priorStageSummary', JSON.stringify(secondaryOpts));
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
