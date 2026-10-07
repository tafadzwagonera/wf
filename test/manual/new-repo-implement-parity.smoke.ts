/**
 * Manual smoke test: standalone issue:implement new-repo parity
 *
 * Run: nr test:manual new-repo-implement-parity.smoke.ts
 *
 * Verifies:
 *   1. isNewRepo propagates through buildImplementOpts in standalone implement
 *   2. Silent mode auto-scaffolds via standalone implement
 *   3. validateUnresolvedRepos throws for repos not in newRepositories
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import type { ImplementerOptions, PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/shared/testing/env';

const { counts, pass, fail } = createReporter();

function makeWriteCapture(
  orig: (...args: unknown[]) => unknown,
  chunks: string[],
): (...args: unknown[]) => unknown {
  return (chunk: unknown, ...args: unknown[]) => {
    chunks.push(String(chunk));
    return (orig as (...a: unknown[]) => boolean)(chunk, ...args);
  };
}

function patchProcessIO(chunks: string[]): {
  origStdout: (...args: unknown[]) => unknown;
  origStderr: (...args: unknown[]) => unknown;
  origExit: (...args: unknown[]) => unknown;
} {
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);
  (process.stdout.write as unknown) = makeWriteCapture(origStdout, chunks);
  (process.stderr.write as unknown) = makeWriteCapture(origStderr, chunks);
  (process.exit as unknown) = (code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  };
  return { origStdout, origStderr, origExit };
}

function restoreProcessIO(
  origStdout: (...args: unknown[]) => unknown,
  origStderr: (...args: unknown[]) => unknown,
  origExit: (...args: unknown[]) => unknown,
): void {
  (process.stdout.write as unknown) = origStdout;
  (process.stderr.write as unknown) = origStderr;
  (process.exit as unknown) = origExit;
}

const captureOutput = async (fn: () => Promise<void>): Promise<{ output: string }> => {
  const chunks: string[] = [];
  const { origStdout, origStderr, origExit } = patchProcessIO(chunks);
  try {
    await fn();
  } catch {
    // swallow
  } finally {
    restoreProcessIO(origStdout, origStderr, origExit);
  }
  return { output: chunks.join('') };
};

function initGitRepo(cwd: string): void {
  execSync('git init', { cwd, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', { cwd, stdio: 'ignore' });
}

function writePlanFile(
  artifactDir: string,
  planName: string,
  opts: { affectedRepositories: string[]; newRepositories?: string[] },
): string {
  const plan: Record<string, unknown> = { action: 'fix', summary: 'Test implement parity', steps: ['Step 1'], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: opts.affectedRepositories };
  if (opts.newRepositories) plan.newRepositories = opts.newRepositories;
  const planPath = path.join(artifactDir, `${planName}-fix.json`);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
  return planPath;
}

const makeCustomPlanFixtures = (opts: {
  planName: string;
  affectedRepositories: string[];
  newRepositories?: string[];
}): { tmpRoot: string; appDir: string; planPath: string; cleanup: () => void } => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-impl-parity-'));
  const appDir = path.join(tmpRoot, 'consumer-app');
  const customArtifactDir = path.join(tmpRoot, 'home', '.wf', 'consumer-app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(customArtifactDir, { recursive: true });
  initGitRepo(appDir);
  const planPath = writePlanFile(customArtifactDir, opts.planName, opts);
  return { tmpRoot, appDir, planPath, cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }) };
};

function setupImplementTest(
  tmpRoot: string,
  appDir: string,
): { originalCwd: () => string } {
  const originalCwd = process.cwd.bind(process);
  withEnv({ HOME: path.join(tmpRoot, 'home') });
  (process as any).cwd = () => appDir;
  return { originalCwd };
}

function teardownImplementTest(
  implementer: { execute: (...args: unknown[]) => unknown },
  origExecute: (...args: unknown[]) => unknown,
  originalCwd: () => string,
  cleanup: () => void,
): void {
  implementer.execute = origExecute;
  (process as any).cwd = originalCwd;
  restoreEnv();
  cleanup();
}

function makeCapturingMock(
  capturedOptions: ImplementerOptions[],
  branchName: string,
): (...args: unknown[]) => unknown {
  return async (_t: TicketArtifact, _p: PlanArtifact, opts: ImplementerOptions) => {
    capturedOptions.push(opts);
    return { type: 'implementation', branchName };
  };
}

function makeCalledTrackingMock(branchName: string): {
  fn: (...args: unknown[]) => unknown;
  wasCalled: () => boolean;
} {
  let called = false;
  return {
    fn: async () => {
      called = true;
      return { type: 'implementation', branchName };
    },
    wasCalled: () => called,
  };
}

function checkTest1Results(appDir: string, capturedOptions: ImplementerOptions[], output: string): void {
  const scaffoldedDir = path.resolve(appDir, '..', 'new-lib');
  if (fs.existsSync(scaffoldedDir)) pass('new-lib directory was auto-scaffolded');
  else fail('new-lib directory was NOT scaffolded', `expected at: ${scaffoldedDir}`);
  if (output.includes('Scaffolded new repository:')) fail('silent mode should suppress scaffold log output');
  else pass('silent mode suppresses scaffold log output');
  const newLibOpts = capturedOptions.find(o => o.isNewRepo === true);
  if (newLibOpts) pass('implementer received isNewRepo=true for new-lib');
  else fail('implementer did NOT receive isNewRepo=true for any repo', `captured: ${JSON.stringify(capturedOptions.map(o => ({ repoDir: o.repoDir, isNewRepo: o.isNewRepo })))}`);
  const consumerOpts = capturedOptions.find(o => o.isNewRepo === false);
  if (consumerOpts) pass('implementer received isNewRepo=false for consumer-app');
  else fail('implementer did NOT receive isNewRepo=false for consumer-app');
}

async function runTest1IsNewRepoPropagates(command: IssueImplementCommand,
  implementer: { execute: (...args: unknown[]) => unknown }): Promise<void> {
  console.log('\nTest 1: standalone implement propagates isNewRepo from plan\n' + '-'.repeat(60));
  const { tmpRoot, appDir, cleanup } = makeCustomPlanFixtures({ planName: 'extract-lib', affectedRepositories: ['consumer-app', 'new-lib'], newRepositories: ['new-lib'] });
  const { originalCwd } = setupImplementTest(tmpRoot, appDir);
  const capturedOptions: ImplementerOptions[] = [];
  const origExecute = implementer.execute.bind(implementer);
  implementer.execute = makeCapturingMock(capturedOptions, 'fix/extract-lib');
  try {
    const { output } = await captureOutput(() => command.run(['extract-lib-fix.json'], { repos: ['consumer-app'], silent: true }));
    checkTest1Results(appDir, capturedOptions, output);
  } finally {
    teardownImplementTest(implementer, origExecute, originalCwd, cleanup);
  }
}

function checkTest2Results(output: string, implementerCalled: boolean): void {
  if (output.includes('Plan references repositories not found locally: typo-repo')) pass('output includes unresolvable repo error');
  else fail('output missing unresolvable repo error', output.slice(-400));
  if (output.includes('newRepositories')) pass('error suggests adding to newRepositories');
  else fail('error missing newRepositories suggestion');
  if (implementerCalled) fail('implementer should not have been called');
  else pass('implementer was NOT called');
}

async function runTest2RejectsUnresolvableRepos(command: IssueImplementCommand,
  implementer: { execute: (...args: unknown[]) => unknown }): Promise<void> {
  console.log('\nTest 2: standalone implement rejects unresolvable repos not in newRepositories\n' + '-'.repeat(60));
  const { tmpRoot, appDir, cleanup } = makeCustomPlanFixtures({ planName: 'typo-plan', affectedRepositories: ['consumer-app', 'typo-repo'], newRepositories: [] });
  const { originalCwd } = setupImplementTest(tmpRoot, appDir);
  const origExecute = implementer.execute.bind(implementer);
  const mock = makeCalledTrackingMock('fix/typo');
  implementer.execute = mock.fn;
  try {
    const { output } = await captureOutput(() => command.run(['typo-plan-fix.json'], { repos: ['consumer-app'], silent: true }));
    checkTest2Results(output, mock.wasCalled());
  } finally {
    teardownImplementTest(implementer, origExecute, originalCwd, cleanup);
  }
}

function checkTest3Results(output: string, capturedOptions: ImplementerOptions[]): void {
  if (output.includes('Scaffolded new repository:')) fail('unexpected scaffold output');
  else pass('no scaffold output when newRepositories is absent');
  if (capturedOptions.length > 0 && capturedOptions.every(o => o.isNewRepo === false)) pass('all implementer calls have isNewRepo=false');
  else if (capturedOptions.length === 0) fail('implementer was not called at all');
  else fail('unexpected isNewRepo=true in options');
}

async function runTest3NoScaffoldingWithoutNewRepositories(command: IssueImplementCommand,
  implementer: { execute: (...args: unknown[]) => unknown }): Promise<void> {
  console.log('\nTest 3: no scaffolding when plan has no newRepositories\n' + '-'.repeat(60));
  const { tmpRoot, appDir, cleanup } = makeCustomPlanFixtures({ planName: 'no-new-repos', affectedRepositories: ['consumer-app'] });
  const { originalCwd } = setupImplementTest(tmpRoot, appDir);
  const capturedOptions: ImplementerOptions[] = [];
  const origExecute = implementer.execute.bind(implementer);
  implementer.execute = makeCapturingMock(capturedOptions, 'fix/no-new');
  try {
    const { output } = await captureOutput(() => command.run(['no-new-repos-fix.json'], { repos: ['consumer-app'], silent: true }));
    checkTest3Results(output, capturedOptions);
  } finally {
    teardownImplementTest(implementer, origExecute, originalCwd, cleanup);
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueImplementCommand);
  const implementer = (command as any).orchestrator.implementer as {
    execute: (ticket: TicketArtifact, plan: PlanArtifact, opts: ImplementerOptions) => Promise<unknown>;
  };
  await runTest1IsNewRepoPropagates(command, implementer);
  await runTest2RejectsUnresolvableRepos(command, implementer);
  await runTest3NoScaffoldingWithoutNewRepositories(command, implementer);
  await app.close();
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
