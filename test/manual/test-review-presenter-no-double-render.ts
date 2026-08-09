/**
 * Manual smoke test: ReviewerAgent no longer renders reviews (no double render).
 *
 * After the ReviewPresenter extraction, ReviewerAgent.execute() no longer
 * injects or calls ReviewPresenter. Display responsibility lives solely in
 * the command layer (IssueCommand.printReviewStatus, IssueReviewCommand.displayReview).
 *
 * This test verifies:
 *   1. ReviewerAgent resolves without ReviewPresenter in its constructor
 *   2. IssueCommand.printReviewStatus renders exactly one review (not two)
 *   3. Silent mode prints only the artifact path
 *
 * Run:
 *   nr test:manual -- test-review-presenter-no-double-render
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { ReviewPresenter } from '../../src/shared/presentation/review-presenter.service';
import { IssueCommand } from '../../src/commands/issue.command';
import chalk from 'chalk';

async function run(): Promise<void> {
  console.log('Manual smoke: ReviewPresenter no double render\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  let passed = 0;
  let failed = 0;

  const originalLog = console.log;
  const pass = (msg: string) => {
    originalLog(chalk.green(`  PASS  ${msg}`));
    passed++;
  };
  const fail = (msg: string) => {
    originalLog(chalk.red(`  FAIL  ${msg}`));
    failed++;
  };

  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string) => s.replaceAll(/\x1B\[[0-9;]*m/g, '');

  originalLog(chalk.bold.cyan('Test 1: ReviewerAgent has no ReviewPresenter dependency'));

  const agent = app.get(ReviewerAgent);
  const agentProto = Object.getPrototypeOf(agent);
  const constructorSource = agentProto.constructor.toString();

  if (constructorSource.includes('reviewPresenter') || constructorSource.includes('ReviewPresenter')) {
    fail('ReviewerAgent constructor still references ReviewPresenter');
  } else {
    pass('ReviewerAgent constructor has no ReviewPresenter reference');
  }

  const agentKeys = Object.keys(agent);
  const presenterKey = agentKeys.find(k => {
    const val = (agent as unknown as Record<string, unknown>)[k];
    return val instanceof ReviewPresenter;
  });

  if (presenterKey) {
    fail(`ReviewerAgent has ReviewPresenter instance on key "${presenterKey}"`);
  } else {
    pass('ReviewerAgent holds no ReviewPresenter instance');
  }

  originalLog(chalk.bold.cyan('\nTest 2: printReviewStatus renders exactly once (non-silent)'));

  const command = app.get(IssueCommand);
  const mockArtifact = {
    review: {
      summary: 'UNIQUE_MARKER_SUMMARY',
      issues: [{ severity: 'warning', message: 'test issue' }],
      suggestions: ['test suggestion'],
      approved: true,
    },
    path: '/tmp/.wf/test/review.md',
    approved: true,
  };

  const captured: string[] = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };

  (command as any).printReviewStatus(mockArtifact, false);

  console.log = originalLog;
  const output = stripAnsi(captured.join('\n'));

  const summaryCount = output.split('UNIQUE_MARKER_SUMMARY').length - 1;
  if (summaryCount === 1) {
    pass(`Summary rendered exactly once (found ${summaryCount})`);
  } else {
    fail(`Summary rendered ${summaryCount} times, expected 1`);
  }

  const approvalCount = output.split('Approval Status').length - 1;
  if (approvalCount === 1) {
    pass(`Approval status rendered exactly once (found ${approvalCount})`);
  } else {
    fail(`Approval status rendered ${approvalCount} times, expected 1`);
  }

  originalLog(chalk.bold.cyan('\nTest 3: printReviewStatus silent mode prints path only'));

  const capturedSilent: string[] = [];
  console.log = (...args: unknown[]) => {
    capturedSilent.push(args.map(String).join(' '));
  };

  (command as any).printReviewStatus(mockArtifact, true);

  console.log = originalLog;
  const silentOutput = capturedSilent.join('\n').trim();

  if (silentOutput === mockArtifact.path) {
    pass('Silent mode outputs only the artifact path');
  } else {
    fail(`Silent mode output: "${silentOutput}", expected: "${mockArtifact.path}"`);
  }

  if (!silentOutput.includes('Summary')) {
    pass('Silent mode does not contain review content');
  } else {
    fail('Silent mode unexpectedly contains review content');
  }

  originalLog(`\n${passed} passed, ${failed} failed`);

  await app.close();

  if (failed > 0) process.exit(1);
  originalLog('\nManual smoke test passed: no double render');
}

run().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
