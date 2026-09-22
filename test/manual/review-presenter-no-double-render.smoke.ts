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
 *   nr test:manual review-presenter-no-double-render.smoke.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { ReviewPresenter } from '../../src/shared/presentation/review-presenter.service';
import { IssueCommand } from '../../src/commands/issue.command';
import chalk from 'chalk';
import { createReporter } from './support/reporter';

function checkConstructor(a: ReviewerAgent, pass: (msg: string) => void, fail: (msg: string) => void): void {
  const src = Object.getPrototypeOf(a).constructor.toString();
  if (src.includes('reviewPresenter') || src.includes('ReviewPresenter')) fail('ReviewerAgent constructor still references ReviewPresenter');
  else pass('ReviewerAgent constructor has no ReviewPresenter reference');
}

function checkPresenterInstance(
  a: ReviewerAgent,
  pass: (msg: string) => void,
  fail: (msg: string, msg2: string) => void,
): void {
  const key = Object.keys(a).find(
    k => (a as unknown as Record<string, unknown>)[k] instanceof ReviewPresenter,
  );
  if (!key) pass('ReviewerAgent holds no ReviewPresenter instance');
  else fail(`ReviewerAgent has ReviewPresenter instance on key "${key}"`, '');
}

function testAgent(a: ReviewerAgent, pass: (msg: string) => void, fail: any): void {
  checkConstructor(a, pass, fail);
  checkPresenterInstance(a, pass, fail);
}

function captureLog(fn: () => void): string[] {
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
  fn();
  console.log = orig;
  return captured;
}

function checkSummaryCount(output: string, pass: any, fail: any): void {
  const cnt = output.split('UNIQUE_MARKER_SUMMARY').length - 1;
  if (cnt === 1) pass(`Summary rendered exactly once (found ${cnt})`);
  else fail(`Summary rendered ${cnt} times, expected 1`);
}

function checkApprovalCount(output: string, pass: any, fail: any): void {
  const cnt = output.split('Approval Status').length - 1;
  if (cnt === 1) pass(`Approval status rendered exactly once (found ${cnt})`);
  else fail(`Approval status rendered ${cnt} times, expected 1`);
}

function testRenderCount(cmd: IssueCommand, artifact: unknown, strip: any, pass: any, fail: any): void {
  const captured = captureLog(() => {
    (cmd as any).printReviewStatus(artifact, false);
  });
  const output = strip(captured.join('\n'));
  checkSummaryCount(output, pass, fail);
  checkApprovalCount(output, pass, fail);
}

function checkSilentOutput(out: string, expected: string, pass: any, fail: any): void {
  if (out === expected) pass('Silent mode outputs only the artifact path');
  else fail(`Silent mode output: "${out}", expected: "${expected}"`);
}

function testSilent(cmd: IssueCommand, artifact: unknown, pass: any, fail: any): void {
  const captured = captureLog(() => {
    (cmd as any).printReviewStatus(artifact, true);
  });
  const out = captured.join('\n').trim();
  const expected = (artifact as any).path;
  checkSilentOutput(out, expected, pass, fail);
  if (out.includes('Summary')) fail('Silent mode unexpectedly contains review content');
  else pass('Silent mode does not contain review content');
}

function runTest1(originalLog: typeof console.log, agent: ReviewerAgent): void {
  originalLog(chalk.bold.cyan('Test 1: ReviewerAgent has no ReviewPresenter dependency'));
  const { pass, fail } = createReporter();
  testAgent(agent, pass, fail);
}

function mkArtifact(): unknown {
  return {
    review: {
      summary: 'UNIQUE_MARKER_SUMMARY',
      issues: [{ severity: 'warning', message: 'test issue' }],
      suggestions: ['test suggestion'],
      approved: true,
    },
    path: '/tmp/.wf/test/review.md',
    approved: true,
  };
}

function runTest2(originalLog: any, command: IssueCommand, stripAnsi: any): void {
  originalLog(chalk.bold.cyan('\nTest 2: printReviewStatus renders exactly once (non-silent)'));
  const { pass, fail } = createReporter();
  testRenderCount(command, mkArtifact(), stripAnsi, pass, fail);
}

function runTest3(originalLog: any, command: IssueCommand): void {
  originalLog(chalk.bold.cyan('\nTest 3: printReviewStatus silent mode prints path only'));
  const { pass, fail } = createReporter();
  testSilent(command, mkArtifact(), pass, fail);
}

function mkStripAnsi(): (s: string) => string {
  const pattern = `[${String.fromCharCode(27)}]\\[[0-9;]*m`;
  return (s: string) => s.replaceAll(new RegExp(pattern, 'g'), '');
}

async function runTests(
  app: any,
  originalLog: typeof console.log,
  stripAnsi: (s: string) => string,
): Promise<void> {
  const agent = app.get(ReviewerAgent);
  runTest1(originalLog, agent);
  const command = app.get(IssueCommand);
  runTest2(originalLog, command, stripAnsi);
  runTest3(originalLog, command);
}

async function main(): Promise<void> {
  console.log('Manual smoke: ReviewPresenter no double render\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const originalLog = console.log;
  const { counts } = createReporter();
  await runTests(app, originalLog, mkStripAnsi());
  originalLog(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  originalLog('\nManual smoke test passed: no double render');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
