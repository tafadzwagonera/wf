/**
 * Manual Test: --ticket-key flag migration
 *
 * Run: nr test:manual ticket-key-flag-migration.smoke.ts
 *
 * Verifies:
 *   1. issue:implement rejects a ticket-key-shaped positional with a migration hint
 *   2. issue:implement accepts --ticket-key via the options object
 *   3. issue:plan rejects empty input when neither --ticket-key nor --custom-plan is set
 *   4. issue:plan accepts --ticket-key via the options object (dry-run)
 *   5. issue:review rejects a non-URL positional with a clear error
 *   6. issue (orchestrator) rejects --ticket-key + --custom-plan together
 *   7. issue (orchestrator) rejects --custom-plan with non-.md extension
 *   8. issue (orchestrator) rejects plan-token + --custom-plan together
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import { IssuePlanCommand } from '../../src/commands/issue-plan.command';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { IssueCommand } from '../../src/commands/issue.command';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function captureExit(): { restore: () => number } {
  let code = -1;
  const orig = process.exit.bind(process);
  (process.exit as unknown as (c: number) => void) = (c: number) => {
    code = c;
  };
  return {
    restore: () => {
      (process.exit as any) = orig;
      return code;
    },
  };
}

function captureConsoleError(): { restore: () => string } {
  let out = '';
  const orig = console.error.bind(console);
  (console.error as unknown as (...args: any[]) => void) = (...args: any[]) => {
    out += args.join(' ') + '\n';
  };
  return {
    restore: () => {
      (console.error as any) = orig;
      return out;
    },
  };
}

function suppressConsoleLog(): { restore: () => void } {
  const origLog = console.log.bind(console);
  (console.log as any) = () => {};
  return {
    restore: () => {
      (console.log as any) = origLog;
    },
  };
}

async function test1(implementCmd: IssueImplementCommand): Promise<void> {
  console.log('\n Test 1: issue:implement rejects ticket-key positional');
  const exitCap = captureExit();
  const errCap = captureConsoleError();
  const logCap = suppressConsoleLog();
  await implementCmd.run(['WBP-9999'], {});
  const code = exitCap.restore();
  const err = errCap.restore();
  logCap.restore();

  if (code === 1) pass('Exits with code 1');
  else fail('Expected exit code 1', `got ${code}`);
  if (err.includes('-k') && err.includes('WBP-9999')) pass('Error contains -k migration hint');
  else fail('Missing migration hint', err.slice(0, 200));
}

async function test2(implementCmd: IssueImplementCommand): Promise<void> {
  console.log('\n Test 2: issue:implement accepts --ticket-key');
  const exitCap = captureExit();
  const errCap = captureConsoleError();
  const logCap = suppressConsoleLog();
  await implementCmd.run([], { ticketKey: 'WBP-9999' });
  const code = exitCap.restore();
  const err = errCap.restore();
  logCap.restore();

  if (code === 1) pass('Exits with code 1 (missing artifact, expected)');
  else fail('Expected exit code 1', `got ${code}`);
  if (err.includes('Ticket artifact not found') || err.includes('issue:fetch'))
    pass('Error references missing artifact, not a flag error');
  else fail('Unexpected error', err.slice(0, 200));
}

async function test3(planCmd: IssuePlanCommand): Promise<void> {
  console.log('\n Test 3: issue:plan rejects empty input');
  const exitCap = captureExit();
  const errCap = captureConsoleError();
  const logCap = suppressConsoleLog();
  await planCmd.run([], { action: 'fix' } as any);
  const code = exitCap.restore();
  const err = errCap.restore();
  logCap.restore();

  if (code === 1) pass('Exits with code 1');
  else fail('Expected exit code 1', `got ${code}`);
  if (err.includes('--ticket-key')) pass('Error mentions --ticket-key');
  else fail('Missing --ticket-key in error', err.slice(0, 200));
}

async function test4(planCmd: IssuePlanCommand): Promise<void> {
  console.log('\n Test 4: issue:plan accepts --ticket-key (dry-run)');
  const exitCap = captureExit();
  const errCap = captureConsoleError();
  const logCap = suppressConsoleLog();
  await planCmd.run([], { action: 'fix', ticketKey: 'WBP-9999', dryRun: true } as any);
  const code = exitCap.restore();
  const err = errCap.restore();
  logCap.restore();

  if (code !== 1) pass('Does not exit with code 1 (dry-run accepted)');
  else fail('Exited with code 1 unexpectedly', err.slice(0, 200));
}

async function test5(reviewCmd: IssueReviewCommand): Promise<void> {
  console.log('\n Test 5: issue:review rejects non-URL positional');
  const exitCap = captureExit();
  const errCap = captureConsoleError();
  const logCap = suppressConsoleLog();
  await reviewCmd.run(['WBP-9999'], {});
  const code = exitCap.restore();
  const err = errCap.restore();
  logCap.restore();

  if (code === 1) pass('Exits with code 1');
  else fail('Expected exit code 1', `got ${code}`);
  if (err.includes('--ticket-key')) pass('Error suggests --ticket-key');
  else fail('Missing --ticket-key suggestion', err.slice(0, 200));
}

async function test6(issueCmd: IssueCommand): Promise<void> {
  console.log('\n Test 6: issue rejects --ticket-key + --custom-plan');
  const exitCap = captureExit();
  const errCap = captureConsoleError();
  const logCap = suppressConsoleLog();
  await issueCmd.run([], { ticketKey: 'WBP-1', customPlan: 'bar.md', from: 'plan', action: 'fix' } as any);
  const code = exitCap.restore();
  const err = errCap.restore();
  logCap.restore();

  if (code === 1) pass('Exits with code 1');
  else fail('Expected exit code 1', `got ${code}`);
  if (err.includes('--ticket-key') || err.includes('--custom-plan')) pass('Error mentions conflicting flags');
  else fail('Missing conflict message', err.slice(0, 200));
}

async function test7(issueCmd: IssueCommand): Promise<void> {
  console.log('\n Test 7: issue rejects --custom-plan with non-.md extension');
  const exitCap = captureExit();
  const errCap = captureConsoleError();
  const logCap = suppressConsoleLog();
  await issueCmd.run([], { customPlan: 'bar.yaml', from: 'plan', action: 'fix' } as any);
  const code = exitCap.restore();
  const err = errCap.restore();
  logCap.restore();

  if (code === 1) pass('Exits with code 1');
  else fail('Expected exit code 1', `got ${code}`);
  if (err.includes('.md')) pass('Error mentions .md requirement');
  else fail('Missing .md mention', err.slice(0, 200));
}

async function test8(issueCmd: IssueCommand): Promise<void> {
  console.log('\n Test 8: issue rejects plan-token + --custom-plan');
  const exitCap = captureExit();
  const errCap = captureConsoleError();
  const logCap = suppressConsoleLog();
  await issueCmd.run(['dark-plan.json'], { customPlan: 'bar.md', from: 'plan', action: 'fix' } as any);
  const code = exitCap.restore();
  const err = errCap.restore();
  logCap.restore();

  if (code === 1) pass('Exits with code 1');
  else fail('Expected exit code 1', `got ${code}`);
  if (err.includes('--custom-plan')) pass('Error mentions --custom-plan conflict');
  else fail('Missing conflict message', err.slice(0, 200));
}

async function runAllTests(
  implementCmd: IssueImplementCommand,
  planCmd: IssuePlanCommand,
  reviewCmd: IssueReviewCommand,
  issueCmd: IssueCommand,
): Promise<void> {
  await test1(implementCmd);
  await test2(implementCmd);
  await test3(planCmd);
  await test4(planCmd);
  await test5(reviewCmd);
  await test6(issueCmd);
  await test7(issueCmd);
  await test8(issueCmd);
}

function reportResults(): void {
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${counts.passed} passed   ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));
  if (counts.failed > 0) process.exit(1);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const implementCmd = app.get(IssueImplementCommand);
  const planCmd = app.get(IssuePlanCommand);
  const reviewCmd = app.get(IssueReviewCommand);
  const issueCmd = app.get(IssueCommand);
  await runAllTests(implementCmd, planCmd, reviewCmd, issueCmd);
  await app.close();
  reportResults();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
