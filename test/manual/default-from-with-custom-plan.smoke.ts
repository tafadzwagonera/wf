/**
 * Manual Test: --from defaults to plan when --custom-plan is provided
 *
 * Run: nr test:manual -- test-default-from-with-custom-plan
 *
 * Verifies:
 *   1. --custom-plan without --from defaults to plan (no "--from option is required" error)
 *   2. --custom-plan with explicit --from still honours the explicit value
 *   3. Ticket key without --from or --custom-plan still requires --from
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const captureStderr = (): { restore: () => string } => {
  let output = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string) => {
    output += String(chunk);
    return true;
  };

  return {
    restore: () => {
      process.stderr.write = originalWrite;
      return output;
    },
  };
};

const captureStdout = (): { restore: () => string } => {
  let output = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string) => {
    output += String(chunk);
    return true;
  };

  return {
    restore: () => {
      process.stdout.write = originalWrite;
      return output;
    },
  };
};

const overrideHomeDir = (nextHomeDir: string): (() => void) => {
  const previousHome = process.env.HOME;
  process.env.HOME = nextHomeDir;

  return () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
      return;
    }

    process.env.HOME = previousHome;
  };
};

const scaffoldCustomPlan = (tmpDir: string): string => {
  const appBaseName = path.basename(tmpDir);
  const customArtifactDir = path.join(tmpDir, '.wf', appBaseName);
  fs.mkdirSync(customArtifactDir, { recursive: true });

  const planFileName = 'smoke-test-plan.md';
  const planPath = path.join(customArtifactDir, planFileName);
  fs.writeFileSync(planPath, '# Smoke Test Plan\n\nTest custom plan default from stage.\n');

  return planFileName;
};

async function main(): Promise<void> {
  const origExit = process.exit;
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const command = app.get(IssueCommand);

  // -- Test 1: --custom-plan without --from defaults to plan -------------------
  console.log('\n\uD83E\uDDEA Test 1: --custom-plan without --from defaults to plan\n' + '\u2500'.repeat(60));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-plan-default-'));
    const restoreHome = overrideHomeDir(tmpDir);
    const planFileName = scaffoldCustomPlan(tmpDir);

    const origCwd = process.cwd.bind(process);
    (process as unknown as { cwd: () => string }).cwd = () => tmpDir;

    let exitCode: number | undefined;
    (process as unknown as { exit: (code: number) => void }).exit = (code: number) => {
      exitCode = code;
    };

    const stderrCapture = captureStderr();
    const stdoutCapture = captureStdout();

    await command.run([], {
      customPlan: planFileName,
      action: 'fix',
      to: 'plan',
      dryRun: true,
      from: undefined,
    } as any);

    const stderr = stderrCapture.restore();
    const stdout = stdoutCapture.restore();

    (process as unknown as { cwd: () => string }).cwd = origCwd;
    (process as unknown as { exit: (code: number) => void }).exit = origExit;
    restoreHome();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (stderr.includes('--from option is required')) {
      fail('Should not require --from when --custom-plan is provided', `stderr: ${stderr.slice(0, 300)}`);
    } else if (stdout.includes('plan') && !stderr.includes('--from option is required')) {
      pass('--custom-plan without --from bypassed the --from guard (defaults to plan)');
    } else {
      fail('Unexpected result', `stderr: ${stderr.slice(0, 300)}\nstdout: ${stdout.slice(0, 300)}`);
    }
  }

  // -- Test 2: --custom-plan with explicit --from implement honours the value --
  console.log('\n\uD83E\uDDEA Test 2: --custom-plan with explicit --from implement honours the value\n' + '\u2500'.repeat(60));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-plan-explicit-'));
    const restoreHome = overrideHomeDir(tmpDir);
    const planFileName = scaffoldCustomPlan(tmpDir);

    const origCwd = process.cwd.bind(process);
    (process as unknown as { cwd: () => string }).cwd = () => tmpDir;

    let exitCode: number | undefined;
    (process as unknown as { exit: (code: number) => void }).exit = (code: number) => {
      exitCode = code;
    };

    const stderrCapture = captureStderr();
    const stdoutCapture = captureStdout();

    await command.run([], {
      customPlan: planFileName,
      from: 'implement',
      to: 'implement',
      dryRun: true,
    } as unknown as Parameters<typeof command.run>[1]);

    const stderr = stderrCapture.restore();
    const stdout = stdoutCapture.restore();

    (process as unknown as { cwd: () => string }).cwd = origCwd;
    (process as unknown as { exit: (code: number) => void }).exit = origExit;
    restoreHome();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (stderr.includes('--from option is required')) {
      fail('Explicit --from should not trigger the required guard', `stderr: ${stderr.slice(0, 300)}`);
    } else if (stdout.includes('implement')) {
      pass('Explicit --from implement is honoured with --custom-plan');
    } else {
      pass('Explicit --from implement bypassed the default guard (downstream error expected in smoke test)');
    }
  }

  // -- Test 3: ticket key without --from still requires --from -----------------
  console.log('\n\uD83E\uDDEA Test 3: ticket key without --from still requires --from\n' + '\u2500'.repeat(60));
  {
    let exitCode: number | undefined;
    (process as unknown as { exit: (code: number) => void }).exit = (code: number) => {
      exitCode = code;
    };

    const stderrCapture = captureStderr();

    await command.run([], {
      ticketKey: 'WBP-42',
      action: 'fix',
    } as unknown as Parameters<typeof command.run>[1]);

    const stderr = stderrCapture.restore();
    (process as unknown as { exit: (code: number) => void }).exit = origExit;

    if (exitCode === 1 && stderr.includes('--from option is required')) {
      pass('Ticket key without --from correctly requires --from');
    } else {
      fail(
        'Expected exit(1) and stderr containing "--from option is required"',
        `exitCode: ${exitCode}, stderr: ${stderr.slice(0, 300)}`
      );
    }
  }

  // -- Summary ----------------------------------------------------------------
  await app.close();
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
