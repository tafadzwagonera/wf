/**
 * Manual Test: issue:implement custom fix/feature plan execution
 *
 * Run: yarn test:manual -- test-issue-implement-custom-plan
 *
 * Verifies:
 *   1. Custom fix plans synthesize execution context and call the shared implementer flow
 *   2. Custom feature dry-runs preview branch and file work
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import type { ImplementerOptions, PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

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

function createFixPlanFile(basePath: string): string {
  const planPath = path.join(basePath, '.wf', 'repo-a', 'dark-building-creek-fix.json');
  const obj = { action: 'fix', summary: 'Repair the custom implementation path', steps: ['Route custom plans to the shared implementer'], estimatedComplexity: 'medium', affectedFiles: ['repo-a/src/commands/issue-implement.command.ts'], affectedRepositories: ['repo-a'] };
  fs.writeFileSync(planPath, JSON.stringify(obj), 'utf-8');
  return planPath;
}

async function assertTest1(cap: any, output: string, planPath: string): Promise<void> {
  if (cap.ticket?.ticketKey === 'dark-building-creek') pass('Synthetic ticket key strips the trailing action from the artifact stem');
  else fail('Synthetic ticket key did not match the expected artifact stem', JSON.stringify(cap.ticket, null, 2));
  if (cap.options?.customBranchSlug === 'dark-building-creek') pass('Custom branch slug is forwarded to the implementer');
  else fail('Custom branch slug was not forwarded to the implementer', JSON.stringify(cap.options, null, 2));
  if (cap.plan?.path === planPath && cap.plan.action === 'fix') pass('Custom fix plan artifact is passed through unchanged');
  else fail('Custom fix plan artifact was not forwarded correctly', JSON.stringify(cap.plan, null, 2));
  if (output.includes('synthetic execution context')) pass('Command warns when it creates a synthetic execution context');
  else fail('Command output did not include the synthetic execution context warning');
}

function setupTest1Dirs(tmpBaseDir: string): string {
  fs.mkdirSync(path.join(tmpBaseDir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(tmpBaseDir, '.wf', 'repo-a'), { recursive: true });
  return createFixPlanFile(tmpBaseDir);
}

function setupImplementerMock(impl: any): any {
  const cap: any = {};
  const origExec = impl.execute.bind(impl);
  impl.execute = async (t: TicketArtifact, p: PlanArtifact, o: ImplementerOptions) => {
    cap.ticket = t;
    cap.plan = p;
    cap.options = o;
    return { type: 'implementation', branchName: 'bugfix/dark-building-creek' };
  };
  return { cap, origExec };
}

async function executeTest1(cmd: IssueImplementCommand, planPath: string, cap: any, tmpBaseDir: string): Promise<void> {
  const stdout = captureStdout();
  (process as any).cwd = () => path.join(tmpBaseDir, 'app');
  await cmd.run(['dark-building-creek-fix.json'], { repos: ['repo-a'] });
  await assertTest1(cap, stdout.restore(), planPath);
}

function cleanupTest1(impl: any, origCwd: any, restoreHome: any, tmpBaseDir: string, origExec: any): void {
  impl.execute = origExec;
  (process as any).cwd = origCwd;
  restoreHome();
  fs.rmSync(tmpBaseDir, { recursive: true, force: true });
}

interface Test1Env {
  impl: any;
  cap: any;
  origExec: any;
  planPath: string;
  restoreHome: () => void;
  origCwd: any;
}

function setupTest1Environment(command: IssueImplementCommand, tmpBaseDir: string): Test1Env {
  const impl = (command as any).orchestrator.implementer;
  const { cap, origExec } = setupImplementerMock(impl);
  const planPath = setupTest1Dirs(tmpBaseDir);
  const restoreHome = overrideHomeDir(tmpBaseDir);
  const origCwd = process.cwd.bind(process);
  return { impl, cap, origExec, planPath, restoreHome, origCwd };
}

async function runTest1(command: IssueImplementCommand): Promise<void> {
  const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-implement-'));
  const { impl, cap, origExec, planPath, restoreHome, origCwd } = setupTest1Environment(command, tmpBaseDir);
  try {
    await executeTest1(command, planPath, cap, tmpBaseDir);
  } finally {
    cleanupTest1(impl, origCwd, restoreHome, tmpBaseDir, origExec);
  }
}

function createFeaturePlanFile(basePath: string): { planPath: string; trackedFile: string } {
  const repoDir = path.join(basePath, 'repo-a');
  const trackedFile = path.join(repoDir, 'src', 'commands', 'issue-implement.command.ts');
  fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
  fs.writeFileSync(trackedFile, '// existing file\n', 'utf-8');
  const planPath = path.join(basePath, '.wf', 'repo-a', 'dark-building-creek-feature.json');
  const obj = { action: 'feature', summary: 'Implement the custom plan flow', steps: ['Preview branch and file work'], estimatedComplexity: 'medium', affectedFiles: ['repo-a/src/commands/issue-implement.command.ts'], affectedRepositories: ['repo-a'] };
  fs.writeFileSync(planPath, JSON.stringify(obj), 'utf-8');
  return { planPath, trackedFile };
}

async function assertTest2(output: string, trackedFile: string): Promise<void> {
  if (output.includes('git branch')) pass('Dry-run previews branch work for custom feature plans');
  else fail('Dry-run output did not preview branch work', output);
  if (output.includes('feature/dark-building-creek')) pass('Dry-run previews the artifact-derived custom branch name');
  else fail('Dry-run output did not include the expected custom branch name', output);
  if (output.includes(trackedFile)) pass('Dry-run previews the repo-local file write target');
  else fail('Dry-run output did not include the expected file write target', output);
}

function setupTest2Dirs(tmpBaseDir: string): { planPath: string; trackedFile: string } {
  fs.mkdirSync(path.join(tmpBaseDir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(tmpBaseDir, '.wf', 'repo-a'), { recursive: true });
  return createFeaturePlanFile(tmpBaseDir);
}

async function executeTest2(command: IssueImplementCommand, trackedFile: string, tmpBaseDir: string): Promise<void> {
  const stdoutCapture = captureStdout();
  (process as any).cwd = () => path.join(tmpBaseDir, 'app');
  await command.run(['dark-building-creek-feature.json'], { repos: ['repo-a'], dryRun: true });
  const output = stdoutCapture.restore();
  await assertTest2(output, trackedFile);
}

async function runTest2(command: IssueImplementCommand): Promise<void> {
  const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-implement-'));
  const { trackedFile } = setupTest2Dirs(tmpBaseDir);
  const restoreHome = overrideHomeDir(tmpBaseDir);
  const originalCwd = process.cwd.bind(process);
  try {
    await executeTest2(command, trackedFile, tmpBaseDir);
  } finally {
    (process as any).cwd = originalCwd;
    restoreHome();
    fs.rmSync(tmpBaseDir, { recursive: true, force: true });
  }
}

function reportResults(): void {
  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) console.log('✓ All tests passed!');
  console.log('━'.repeat(60));
}

async function runAllTests(command: IssueImplementCommand): Promise<void> {
  console.log('\n🧪 Test 1: custom fix plan uses synthetic execution context\n' + '─'.repeat(60));
  await runTest1(command);
  console.log('\n🧪 Test 2: custom feature dry-run previews branch and file work\n' + '─'.repeat(60));
  await runTest2(command);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const command = app.get(IssueImplementCommand);
  await runAllTests(command);
  await app.close();
  reportResults();
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
