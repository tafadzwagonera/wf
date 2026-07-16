/**
 * Manual smoke test — PR discovery transient-error retry
 *
 * Run: nr test:manual -- test-pr-discovery-transient-retry
 *
 * Verifies that `probeAdapterForPrs()` retries once on transient network
 * errors (e.g. "Premature close") and surfaces non-transient errors without
 * retry. No external APIs are called — adapter methods are monkey-patched.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';

async function main() {
  console.log('Testing PR discovery transient-error retry\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const command = app.get(IssueReviewCommand);

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`  PASS ${msg}`);
    passed++;
  };
  const fail = (msg: string) => {
    console.error(`  FAIL ${msg}`);
    failed++;
  };

  // Access private method via index signature
  const probe = (command as any).probeAdapterForPrs.bind(command);

  // ── Test 1: retry succeeds on second attempt ─────────────────────────
  console.log('Test 1: transient error retried, second attempt succeeds');
  {
    let callCount = 0;
    const adapter = {
      findPullRequestsByTicketKey: async () => {
        callCount++;
        if (callCount === 1) throw new Error('Premature close');
        return ['https://bitbucket.org/ws/repo/pull-requests/42'];
      },
    };
    const errors: string[] = [];
    const result = await probe(adapter, 'bitbucket', 'TAD-1', 'my-repo', errors);
    if (callCount === 2) pass('adapter called exactly 2 times');
    else fail(`expected 2 calls, got ${callCount}`);
    if (result && result[0].includes('42')) pass('returned PR URL from second attempt');
    else fail(`unexpected result: ${JSON.stringify(result)}`);
  }

  // ── Test 2: transient error persists → returns null ──────────────────
  console.log('Test 2: transient error persists after retry, returns null');
  {
    let callCount = 0;
    const adapter = {
      findPullRequestsByTicketKey: async () => {
        callCount++;
        throw new Error('ECONNRESET');
      },
    };
    const errors: string[] = [];
    const result = await probe(adapter, 'bitbucket', 'TAD-2', 'my-repo', errors);
    if (callCount === 2) pass('adapter called exactly 2 times');
    else fail(`expected 2 calls, got ${callCount}`);
    if (result === null) pass('returned null after exhausting retries');
    else fail(`expected null, got ${JSON.stringify(result)}`);
  }

  // ── Test 3: non-transient error is NOT retried ───────────────────────
  console.log('Test 3: non-transient error is not retried');
  {
    let callCount = 0;
    const adapter = {
      findPullRequestsByTicketKey: async () => {
        callCount++;
        throw new Error('No BitBucket repository specified.');
      },
    };
    const errors: string[] = [];
    const result = await probe(adapter, 'bitbucket', 'TAD-3', 'my-repo', errors);
    if (callCount === 1) pass('adapter called exactly 1 time (no retry)');
    else fail(`expected 1 call, got ${callCount}`);
    if (result === null) pass('returned null on non-transient error');
    else fail(`expected null, got ${JSON.stringify(result)}`);
  }

  // ── Test 4: all transient patterns are recognized ────────────────────
  console.log('Test 4: all transient error patterns trigger retry');
  const patterns = ['Premature close', 'ECONNRESET', 'socket hang up', 'ETIMEDOUT', 'ECONNREFUSED', 'fetch failed'];
  for (const pattern of patterns) {
    let callCount = 0;
    const adapter = {
      findPullRequestsByTicketKey: async () => {
        callCount++;
        if (callCount === 1) throw new Error(`Connection error: ${pattern}`);
        return ['https://example.com/pr/1'];
      },
    };
    const errors: string[] = [];
    await probe(adapter, 'test', 'TAD-4', '', errors);
    if (callCount === 2) pass(`"${pattern}" triggered retry`);
    else fail(`"${pattern}" — expected 2 calls, got ${callCount}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  await app.close();
  process.exit(failed > 0 ? 1 : 0);
}

main();
