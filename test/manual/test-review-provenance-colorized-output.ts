/**
 * Manual smoke test: colorized provenance output does not leak .map() indices.
 *
 * Validates that:
 * 1. Live chalk colorization of provenance lines produces clean output (no
 *    array index or stringified array appended to each line)
 * 2. The session-id help example uses `{UUID}` placeholder, not a hardcoded value
 * 3. README does not contain the old hardcoded session-id value
 *
 * Run:
 *   nr test:manual -- test-review-provenance-colorized-output
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ReviewPresenter } from '../../src/shared/presentation/review-presenter.service';

async function run(): Promise<void> {
  console.log('Manual smoke: colorized provenance output\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const presenter = app.get(ReviewPresenter);

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(chalk.green(`  PASS  ${msg}`));
    passed++;
  };
  const fail = (msg: string) => {
    console.error(chalk.red(`  FAIL  ${msg}`));
    failed++;
  };

  console.log('Test 1: colorized provenance output is clean');

  const mockReview = {
    summary: 'Test review',
    issues: [],
    suggestions: [],
    approved: true,
    executionMode: 'cli' as const,
    traceProvenance: 'evidence-based' as const,
    callStack: [{ frame: 'Controller.handle()' }],
    stateTransition: { from: 'idle', to: 'active' },
  };

  const callStackOutput: string = (presenter as any).formatCallStackInline(mockReview);
  const stateTransitionOutput: string = (presenter as any).formatStateTransitionInline(mockReview);

  // The bug caused output like: "Execution mode: cli 0   Execution mode: cli,  Provenance: ..."
  // A digit immediately after the execution mode value indicates index leakage.
  const indexLeakPattern = /Execution mode: \w+ \d/;

  if (indexLeakPattern.test(callStackOutput)) {
    fail(`Call stack output leaks .map() index:\n${callStackOutput}`);
  } else {
    pass('Call stack provenance lines are clean');
  }

  if (indexLeakPattern.test(stateTransitionOutput)) {
    fail(`State transition output leaks .map() index:\n${stateTransitionOutput}`);
  } else {
    pass('State transition provenance lines are clean');
  }

  // Verify the two expected lines are present and correctly separated
  const ansiEscape = String.fromCharCode(27);
  const ansiPattern = new RegExp(`${ansiEscape}\\[[0-9;]*m`, 'g');
  const stripAnsi = (s: string) => s.replaceAll(ansiPattern, '');
  const cleanCallStack = stripAnsi(callStackOutput);

  if (!cleanCallStack.includes('Execution mode: cli')) {
    fail('Missing "Execution mode: cli" in call stack output');
  } else {
    pass('Call stack contains "Execution mode: cli"');
  }

  if (!cleanCallStack.includes('Provenance: evidence-based')) {
    fail('Missing "Provenance: evidence-based" in call stack output');
  } else {
    pass('Call stack contains "Provenance: evidence-based"');
  }

  // Each line should appear exactly once (not duplicated)
  const modeLineCount = cleanCallStack.split('Execution mode:').length - 1;
  if (modeLineCount !== 1) {
    fail(`"Execution mode:" appears ${modeLineCount} times, expected 1`);
  } else {
    pass('"Execution mode:" appears exactly once');
  }

  const provenanceLineCount = cleanCallStack.split('Provenance:').length - 1;
  if (provenanceLineCount !== 1) {
    fail(`"Provenance:" appears ${provenanceLineCount} times, expected 1`);
  } else {
    pass('"Provenance:" appears exactly once');
  }

  console.log('\nTest 2: session-id help example uses {UUID}');

  const sourceFile = fs.readFileSync(
    path.join(__dirname, '../../src/commands/issue-review.command.ts'),
    'utf-8',
  );

  if (sourceFile.includes('--session-id review-session-42')) {
    fail('Source still contains hardcoded "review-session-42" in help example');
  } else {
    pass('No hardcoded "review-session-42" in help examples');
  }

  if (sourceFile.includes('--session-id {UUID}')) {
    pass('Source help example uses "--session-id {UUID}"');
  } else {
    fail('Source help example does not contain "--session-id {UUID}"');
  }

  console.log('\nTest 3: README has no hardcoded session-id example');

  const readme = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf-8');

  if (readme.includes('--session-id review-session-42')) {
    fail('README still contains hardcoded "review-session-42"');
  } else {
    pass('No hardcoded "review-session-42" in README');
  }

  console.log(`\n${passed} passed, ${failed} failed`);

  await app.close();

  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: colorized provenance output');
}

run().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
