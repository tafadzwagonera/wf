/**
 * Manual Test: --from defaults to plan when --custom-plan is provided
 *
 * Run: nr test:manual default-from-with-custom-plan.smoke.ts
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
import { restoreEnv, withEnv } from '../../src/common/testing/env';

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

const scaffoldCustomPlan = (tmpDir: string): string => {
  const appBaseName = path.basename(tmpDir);
  const customArtifactDir = path.join(tmpDir, '.wf', appBaseName);
  fs.mkdirSync(customArtifactDir, { recursive: true });

  const planFileName = 'smoke-test-plan.md';
  const planPath = path.join(customArtifactDir, planFileName);
  fs.writeFileSync(planPath, '# Smoke Test Plan\n\nTest custom plan default from stage.\n');

  return planFileName;
};

const saveProcessExit = (): { restore: () => void } => {
  const origExit = process.exit;
  const restore = () => {
    process.exit = origExit;
  };
  return { restore };
};

const setupTmpDir = (): { tmpDir: string; cleanup: () => void } => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-plan-'));
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
};

const cleanupTest = (origExit: any, cleanup: () => void): void => {
  process.exit = origExit;
  restoreEnv();
  cleanup();
};

const printTestHeader = (num: number, label: string): void => {
  console.log(`\n🧪 Test ${num}: ${label}\n` + '─'.repeat(60));
};

const printResults = (): void => {
  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));
};

type CommandOutput = { stderr: string; stdout: string };

async function runCommandWithCwd(command: IssueCommand, opts: any, tmpDir: string): Promise<CommandOutput> {
  const origCwd = process.cwd;
  process.cwd = () => tmpDir;
  const stderrCapture = captureStderr();
  const stdoutCapture = captureStdout();
  try {
    await command.run([], opts);
  } finally {
    process.cwd = origCwd;
  }
  return { stderr: stderrCapture.restore(), stdout: stdoutCapture.restore() };
}

async function testCustomPlanDefaultsToPlan(cmd: IssueCommand, origExit: any): Promise<void> {
  const { tmpDir, cleanup } = setupTmpDir();
  withEnv({ HOME: tmpDir });
  process.exit = (() => {}) as any;
  const planFileName = scaffoldCustomPlan(tmpDir);
  try {
    const { stderr, stdout } = await runCommandWithCwd(cmd, { customPlan: planFileName, action: 'fix' as const, to: 'plan' as const, dryRun: true, from: undefined }, tmpDir);
    if (stderr.includes('--from option is required')) fail('Should not require --from', stderr.slice(0, 300));
    else if (stdout.includes('plan')) pass('--custom-plan without --from bypassed guard (defaults to plan)');
    else fail('Unexpected result', stderr.slice(0, 300));
  } finally { cleanupTest(origExit, cleanup); }
}

async function testCustomPlanWithExplicitFrom(cmd: IssueCommand, origExit: any): Promise<void> {
  const { tmpDir, cleanup } = setupTmpDir();
  withEnv({ HOME: tmpDir });
  process.exit = (() => {}) as any;
  const planFileName = scaffoldCustomPlan(tmpDir);
  try {
    const { stderr } = await runCommandWithCwd(cmd, { customPlan: planFileName, from: 'implement' as const, to: 'implement' as const, dryRun: true }, tmpDir);
    if (stderr.includes('--from option is required')) fail('Explicit --from should not trigger', stderr.slice(0, 300));
    else pass('Explicit --from implement is honoured with --custom-plan');
  } finally { cleanupTest(origExit, cleanup); }
}

async function testTicketKeyRequiresFrom(cmd: IssueCommand, origExit: any): Promise<void> {
  let exitCode: number | undefined;
  const updateExit = (code: number) => {
    exitCode = code;
  };
  process.exit = updateExit as any;
  try {
    const stderrCapture = captureStderr();
    await cmd.run([], { ticketKey: 'WBP-42', action: 'fix' });
    const stderr = stderrCapture.restore();
    if (exitCode === 1 && stderr.includes('--from option is required')) pass('Ticket key without --from correctly requires --from');
    else fail('Expected exit(1) with --from required', `exitCode: ${exitCode}`);
  } finally { process.exit = origExit; }
}

async function main(): Promise<void> {
  const origExit = process.exit;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueCommand);

  printTestHeader(1, '--custom-plan without --from defaults to plan');
  await testCustomPlanDefaultsToPlan(command, origExit);
  printTestHeader(2, '--custom-plan with explicit --from implement honours the value');
  await testCustomPlanWithExplicitFrom(command, origExit);
  printTestHeader(3, 'ticket key without --from still requires --from');
  await testTicketKeyRequiresFrom(command, origExit);

  await app.close();
  printResults();
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
