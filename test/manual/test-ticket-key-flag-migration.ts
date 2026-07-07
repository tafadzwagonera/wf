/**
 * Manual Test: --ticket-key flag migration
 *
 * Run: nr test:manual -- test-ticket-key-flag-migration
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

let passed = 0;
let failed = 0;
const pass = (msg: string) => {
  console.log(`  \u2713 ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string) => {
  console.error(`  \u2717 ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

function captureExit(): { restore: () => number } {
  let code = -1;
  const orig = process.exit.bind(process);
  (process.exit as any) = (c: number) => {
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
  (console.error as any) = (...args: any[]) => {
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

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const implementCmd = app.get(IssueImplementCommand);
  const planCmd = app.get(IssuePlanCommand);
  const reviewCmd = app.get(IssueReviewCommand);
  const issueCmd = app.get(IssueCommand);

  // Test 1: issue:implement rejects ticket-key-shaped positional
  console.log('\n Test 1: issue:implement rejects ticket-key positional');
  {
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

  // Test 2: issue:implement accepts --ticket-key (dry-run, will fail on missing artifact but with correct error)
  console.log('\n Test 2: issue:implement accepts --ticket-key');
  {
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

  // Test 3: issue:plan rejects empty input
  console.log('\n Test 3: issue:plan rejects empty input');
  {
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

  // Test 4: issue:plan accepts --ticket-key (dry-run)
  console.log('\n Test 4: issue:plan accepts --ticket-key (dry-run)');
  {
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

  // Test 5: issue:review rejects non-URL positional
  console.log('\n Test 5: issue:review rejects non-URL positional');
  {
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

  // Test 6: issue rejects --ticket-key + --custom-plan
  console.log('\n Test 6: issue rejects --ticket-key + --custom-plan');
  {
    const exitCap = captureExit();
    const errCap = captureConsoleError();
    const logCap = suppressConsoleLog();
    await issueCmd.run([], {
      ticketKey: 'WBP-1',
      customPlan: 'bar.md',
      from: 'plan',
      action: 'fix',
    } as any);
    const code = exitCap.restore();
    const err = errCap.restore();
    logCap.restore();

    if (code === 1) pass('Exits with code 1');
    else fail('Expected exit code 1', `got ${code}`);
    if (err.includes('--ticket-key') || err.includes('--custom-plan')) pass('Error mentions conflicting flags');
    else fail('Missing conflict message', err.slice(0, 200));
  }

  // Test 7: issue rejects --custom-plan with non-.md extension
  console.log('\n Test 7: issue rejects --custom-plan with non-.md extension');
  {
    const exitCap = captureExit();
    const errCap = captureConsoleError();
    const logCap = suppressConsoleLog();
    await issueCmd.run([], {
      customPlan: 'bar.yaml',
      from: 'plan',
      action: 'fix',
    } as any);
    const code = exitCap.restore();
    const err = errCap.restore();
    logCap.restore();

    if (code === 1) pass('Exits with code 1');
    else fail('Expected exit code 1', `got ${code}`);
    if (err.includes('.md')) pass('Error mentions .md requirement');
    else fail('Missing .md mention', err.slice(0, 200));
  }

  // Test 8: issue rejects plan-token + --custom-plan
  console.log('\n Test 8: issue rejects plan-token + --custom-plan');
  {
    const exitCap = captureExit();
    const errCap = captureConsoleError();
    const logCap = suppressConsoleLog();
    await issueCmd.run(['dark-plan.json'], {
      customPlan: 'bar.md',
      from: 'plan',
      action: 'fix',
    } as any);
    const code = exitCap.restore();
    const err = errCap.restore();
    logCap.restore();

    if (code === 1) pass('Exits with code 1');
    else fail('Expected exit code 1', `got ${code}`);
    if (err.includes('--custom-plan')) pass('Error mentions --custom-plan conflict');
    else fail('Missing conflict message', err.slice(0, 200));
  }

  await app.close();

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
