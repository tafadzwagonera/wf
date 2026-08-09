/**
 * Manual smoke test: ReviewPresenter colorized terminal output via live app.
 *
 * Validates that ReviewPresenter.displayReview() produces ANSI-colored
 * terminal output through a live NestJS application context — covering
 * summary, severity-colored issues, call stack, state transition,
 * suggestions, and approval status sections.
 *
 * Run:
 *   nr test:manual -- test-review-presenter-colorized-output
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ReviewPresenter } from '../../src/shared/presentation/review-presenter.service';
import chalk from 'chalk';

async function run(): Promise<void> {
  console.log('Manual smoke: ReviewPresenter colorized terminal output\n');

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

  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };

  const ESC = String.fromCharCode(27);
  const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*m`);
  const ansiGlobal = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
  const stripAnsi = (s: string) => s.replaceAll(ansiGlobal, '');

  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };

  presenter.displayReview({
    summary: 'Extraction looks good overall',
    issues: [
      { severity: 'error', message: 'Missing null check', file: 'src/auth.ts', line: 42 },
      { severity: 'warning', message: 'Unused import', file: 'src/util.ts', line: 1 },
    ],
    suggestions: ['Add input validation'],
    approved: true,
    callStack: [{ frame: 'Controller.handle (src/api.ts:10)', children: [] }],
    stateTransition: { from: 'idle', to: 'active' },
    executionMode: 'cli' as const,
    traceProvenance: 'evidence-based' as const,
  });

  console.log = originalLog;
  const output = captured.join('\n');
  const clean = stripAnsi(output);

  console.log(chalk.bold.cyan('\nTest 1: approved review with full sections'));

  if (ansiPattern.test(output)) {
    pass('Output contains ANSI escape sequences (chalk is active)');
  } else if (chalk.level === 0) {
    pass('Chalk color level is 0 (non-TTY) — ANSI codes correctly absent');
  } else {
    fail('Output has no ANSI codes — chalk may be disabled');
  }

  const expectedMarkers = [
    ['Summary:', 'summary header'],
    ['Extraction looks good overall', 'summary text'],
    ['error', 'error severity label'],
    ['warning', 'warning severity label'],
    ['Missing null check', 'error issue message'],
    ['Unused import', 'warning issue message'],
    ['src/auth.ts', 'issue file location'],
    ['Call Stack', 'call stack header'],
    ['Controller.handle', 'call stack frame'],
    ['State Transition', 'state transition header'],
    ['Suggestions', 'suggestions header'],
    ['Add input validation', 'suggestion text'],
    ['Approval Status', 'approval status header'],
    ['Approved', 'approved verdict'],
  ];

  for (const [marker, label] of expectedMarkers) {
    if (clean.includes(marker)) {
      pass(`Contains "${label}"`);
    } else {
      fail(`Missing "${label}" (expected "${marker}")`);
    }
  }

  if (clean.includes('✔')) {
    pass('Shows checkmark for approved review');
  } else {
    fail('Missing checkmark for approved review');
  }

  console.log(chalk.bold.cyan('\nTest 2: rejected review'));

  const captured2: string[] = [];
  console.log = (...args: unknown[]) => {
    captured2.push(args.map(String).join(' '));
  };

  presenter.displayReview({
    summary: 'Needs work',
    issues: [{ severity: 'error', message: 'Critical bug' }],
    suggestions: [],
    approved: false,
  });

  console.log = originalLog;
  const clean2 = stripAnsi(captured2.join('\n'));

  if (clean2.includes('✗')) {
    pass('Shows cross for rejected review');
  } else {
    fail('Missing cross for rejected review');
  }

  if (clean2.includes('Changes requested')) {
    pass('Shows "Changes requested" verdict');
  } else {
    fail('Missing "Changes requested" verdict');
  }

  if (clean2.includes('Address the issues above')) {
    pass('Shows warning to address issues');
  } else {
    fail('Missing warning to address issues');
  }

  console.log(chalk.bold.cyan('\nTest 3: empty issues and suggestions'));

  const captured3: string[] = [];
  console.log = (...args: unknown[]) => {
    captured3.push(args.map(String).join(' '));
  };

  presenter.displayReview({
    summary: 'Clean',
    issues: [],
    suggestions: [],
    approved: true,
  });

  console.log = originalLog;
  const clean3 = stripAnsi(captured3.join('\n'));

  if (clean3.includes('No issues found')) {
    pass('Shows "No issues found" for empty issues');
  } else {
    fail('Missing "No issues found"');
  }

  if (clean3.includes('No suggestions')) {
    pass('Shows "No suggestions" for empty suggestions');
  } else {
    fail('Missing "No suggestions"');
  }

  console.log(`\n${passed} passed, ${failed} failed`);

  await app.close();

  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: ReviewPresenter colorized terminal output');
}

run().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
