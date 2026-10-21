/**
 * Manual smoke test: new-repo interactive confirmation and silent auto-scaffold
 *
 * Run: nr test:manual new-repo-confirmation-and-scaffold.smoke.ts
 *
 * Verifies:
 *   1. Silent mode auto-scaffolds new repos via the full IssueCommand pipeline
 *   2. Interactive mode prompts user and validates directory + wf.config.* exist
 *   3. Interactive mode throws when user confirms but directory is missing
 *   4. Interactive mode throws when user confirms but wf.config.* is missing
 *   5. Interactive mode returns original repos when user declines
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import type { ImplementerOptions, PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import { hashPlanArtifactSources, buildPlanArtifactFilename, buildPlanArtifactManifestPath } from '../../src/common/utils/plan-artifact';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import inquirer from 'inquirer';
import { createReporter, summarise } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/common/testing/env';

const { counts, pass, fail } = createReporter();

type MockableImplementer = { execute: (...args: unknown[]) => unknown };

function initGitRepo(appDir: string): void {
  execSync('git init', { cwd: appDir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: appDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: appDir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', { cwd: appDir, stdio: 'ignore' });
}

function writeTicketFile(platformDir: string, ticketKey: string): void {
  fs.writeFileSync(
    path.join(platformDir, `${ticketKey}.md`),
    `# ${ticketKey}: Test\n\n**Type:** Task\n**Status:** Open\n\n## Description\n\nTest.\n`,
    'utf-8'
  );
}

function writePlanFiles(
  platformDir: string,
  opts: { ticketKey: string; affectedRepositories?: string[]; newRepositories?: string[] },
): void {
  const plan: Record<string, unknown> = { action: 'fix', summary: 'Test new repo scaffold', steps: ['Step 1'], estimatedComplexity: 'low', affectedRepositories: opts.affectedRepositories ?? ['primary-app'] };
  if (opts.newRepositories) plan.newRepositories = opts.newRepositories;
  const hash = hashPlanArtifactSources([opts.ticketKey]);
  const planFilename = buildPlanArtifactFilename({ hash, action: 'fix', format: 'json' });
  const planPath = path.join(platformDir, planFilename);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
  const manifestPath = buildPlanArtifactManifestPath(planPath);
  fs.writeFileSync(manifestPath, JSON.stringify({ artifactPath: planPath, action: 'fix', createdAt: new Date().toISOString(), format: 'json', hash, sourceKind: 'ticket', sourceName: opts.ticketKey, ticketKey: opts.ticketKey, trackerName: 'jira' }, null, 2), 'utf-8');
}

function setupFixtureDirs(tmpRoot: string): { homeDir: string; appDir: string; platformDir: string } {
  const homeDir = path.join(tmpRoot, 'home');
  const appDir = path.join(tmpRoot, 'primary-app');
  const platformDir = path.join(homeDir, '.wf', 'primary-app', 'jira');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(platformDir, { recursive: true });
  return { homeDir, appDir, platformDir };
}

const makeFixtures = (opts: {
  ticketKey: string;
  newRepositories?: string[];
  affectedRepositories?: string[];
}): { tmpRoot: string; homeDir: string; appDir: string; cleanup: () => void } => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-newrepo-'));
  const { homeDir, appDir, platformDir } = setupFixtureDirs(tmpRoot);
  initGitRepo(appDir);
  writeTicketFile(platformDir, opts.ticketKey);
  writePlanFiles(platformDir, opts);
  return { tmpRoot, homeDir, appDir, cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }) };
};

const buildPlanArtifactForExpand = (
  affectedRepositories: string[], newRepositories?: string[]
): PlanArtifact => ({
  action: 'fix',
  path: '/tmp/test-plan.json',
  plan: {
    action: 'fix', summary: 'Test', steps: [], estimatedComplexity: 'low' as const,
    affectedFiles: [], affectedRepositories, newRepositories,
  },
});

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
  } catch { /* swallow */ } finally {
    restoreProcessIO(origStdout, origStderr, origExit);
  }
  return { output: chunks.join('') };
};

function overrideCwd(appDir: string): { restoreCwd: () => void } {
  const originalCwd = process.cwd.bind(process);
  (process as any).cwd = () => appDir;
  return {
    restoreCwd: () => {
      (process as any).cwd = originalCwd;
    },
  };
}

function overrideTTY(): { restoreTTY: () => void } {
  const stdinTTY = process.stdin.isTTY;
  const stdoutTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  return {
    restoreTTY: () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTTY, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTTY, configurable: true });
    },
  };
}

function teardownInteractiveTest(
  origPrompt: typeof inquirer.prompt,
  restoreCwd: () => void,
  restoreTTY: () => void,
  tmpRoot: string,
): void {
  (inquirer as any).prompt = origPrompt;
  restoreCwd();
  restoreTTY();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function checkSilentAutoScaffold(appDir: string, capturedOptions: ImplementerOptions[]): void {
  const scaffoldedDir = path.resolve(appDir, '..', 'auto-svc');
  if (fs.existsSync(scaffoldedDir)) pass('auto-svc directory was scaffolded');
  else fail('auto-svc directory was NOT scaffolded', `expected: ${scaffoldedDir}`);
  if (fs.existsSync(path.join(scaffoldedDir, '.git'))) pass('auto-svc has a .git directory');
  else fail('auto-svc does not have a .git directory');
  const newRepoOpts = capturedOptions.find(o => o.isNewRepo);
  if (newRepoOpts) pass('implementer received isNewRepo=true for auto-svc');
  else fail('implementer did not receive isNewRepo=true');
}

function makeImplementerMock(
  capturedOptions: ImplementerOptions[],
): (...args: unknown[]) => unknown {
  return async (_t: TicketArtifact, _p: PlanArtifact, opts: ImplementerOptions) => {
    capturedOptions.push(opts);
    return { type: 'implementation', branchName: 'fix/NR-1' };
  };
}

function teardownTest1(
  implementer: { execute: (...args: unknown[]) => unknown },
  origExecute: (...args: unknown[]) => unknown,
  restoreCwd: () => void,
  cleanup: () => void,
): void {
  implementer.execute = origExecute;
  restoreCwd();
  restoreEnv();
  cleanup();
}

async function runTest1SilentAutoScaffold(command: IssueCommand, implementer: MockableImplementer): Promise<void> {
  console.log('\nTest 1: silent mode auto-scaffolds new repos without prompting\n' + '-'.repeat(60));
  const { homeDir, appDir, cleanup } = makeFixtures({ ticketKey: 'NR-1', affectedRepositories: ['primary-app', 'auto-svc'], newRepositories: ['auto-svc'] });
  const { restoreCwd } = overrideCwd(appDir);
  withEnv({ HOME: homeDir, WF_HOME: path.join(homeDir, '.wf') });
  const capturedOptions: ImplementerOptions[] = [];
  const origExecute = implementer.execute.bind(implementer);
  implementer.execute = makeImplementerMock(capturedOptions);
  try {
    await captureOutput(() => command.run([], { ticketKey: 'NR-1', from: 'implement', to: 'implement', action: 'fix', repos: ['primary-app'], silent: true }));
    checkSilentAutoScaffold(appDir, capturedOptions);
  } finally {
    teardownTest1(implementer, origExecute, restoreCwd, cleanup);
  }
}

async function checkConfirmedRepoExpansion(command: IssueCommand, appDir: string): Promise<void> {
  const planArtifact = buildPlanArtifactForExpand(['primary-app', 'confirmed-svc'], ['confirmed-svc']);
  const { output } = await captureOutput(async () => {
    const result = await (command as any).expandReposFromPlan([undefined], planArtifact, appDir, false);
    if (result.includes('confirmed-svc')) pass('confirmed-svc is in returned repos');
    else fail('confirmed-svc missing from returned repos', JSON.stringify(result));
  });
  if (output.includes('The plan requires new repositories')) pass('output includes manual setup instructions');
  else fail('output missing manual setup instructions');
  if (output.includes('Confirmed new repository:')) pass('output includes confirmation message');
  else fail('output missing confirmation message');
}

function makeConfirmedSvcPrompt(appDir: string): () => Promise<{ ready: boolean }> {
  return async () => {
    const nr = path.resolve(appDir, '..', 'confirmed-svc');
    fs.mkdirSync(nr, { recursive: true });
    fs.writeFileSync(path.join(nr, 'wf.config.ts'), 'export default {};', 'utf-8');
    return { ready: true };
  };
}

async function runTest2InteractiveConfirm(command: IssueCommand): Promise<void> {
  console.log('\nTest 2: interactive prompt confirms when directory and config exist\n' + '-'.repeat(60));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-expand-'));
  const appDir = path.join(tmpRoot, 'primary-app');
  fs.mkdirSync(appDir, { recursive: true });
  const { restoreCwd } = overrideCwd(appDir);
  const { restoreTTY } = overrideTTY();
  const origPrompt = inquirer.prompt;
  (inquirer as any).prompt = makeConfirmedSvcPrompt(appDir);
  try {
    await checkConfirmedRepoExpansion(command, appDir);
  } finally {
    teardownInteractiveTest(origPrompt, restoreCwd, restoreTTY, tmpRoot);
  }
}

function checkMissingDirOutput(threwValidation: boolean, output: string): void {
  if (threwValidation) pass('threw ValidationError with "directory not found"');
  else fail('did not throw expected ValidationError');
  if (output.includes('directory not found')) pass('output includes "directory not found"');
  else fail('output missing "directory not found"');
}

async function checkMissingDirThrows(command: IssueCommand, appDir: string): Promise<void> {
  const planArtifact = buildPlanArtifactForExpand(['primary-app', 'missing-dir-svc'], ['missing-dir-svc']);
  let threwValidation = false;
  const { output } = await captureOutput(async () => {
    try {
      await (command as any).expandReposFromPlan([undefined], planArtifact, appDir, false);
    } catch (err: unknown) {
      threwValidation = (err as Error).message.includes('directory not found');
      throw err;
    }
  });
  checkMissingDirOutput(threwValidation, output);
}

async function runTest3MissingDirThrows(command: IssueCommand): Promise<void> {
  console.log('\nTest 3: throws when user confirms but directory is missing\n' + '-'.repeat(60));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-expand-'));
  const appDir = path.join(tmpRoot, 'primary-app');
  fs.mkdirSync(appDir, { recursive: true });
  const { restoreCwd } = overrideCwd(appDir);
  const { restoreTTY } = overrideTTY();
  const origPrompt = inquirer.prompt;
  (inquirer as any).prompt = async () => ({ ready: true });
  try {
    await checkMissingDirThrows(command, appDir);
  } finally {
    teardownInteractiveTest(origPrompt, restoreCwd, restoreTTY, tmpRoot);
  }
}

function checkMissingConfigOutput(threwValidation: boolean, output: string): void {
  if (threwValidation) pass('threw ValidationError with "wf.config.* not found"');
  else fail('did not throw expected ValidationError');
  if (output.includes('wf.config.* not found')) pass('output includes "wf.config.* not found"');
  else fail('output missing "wf.config.* not found"');
}

async function checkMissingConfigThrows(command: IssueCommand, appDir: string): Promise<void> {
  const planArtifact = buildPlanArtifactForExpand(['primary-app', 'no-config-svc'], ['no-config-svc']);
  let threwValidation = false;
  const { output } = await captureOutput(async () => {
    try {
      await (command as any).expandReposFromPlan([undefined], planArtifact, appDir, false);
    } catch (err: unknown) {
      threwValidation = (err as Error).message.includes('wf.config.* not found');
      throw err;
    }
  });
  checkMissingConfigOutput(threwValidation, output);
}

function makeNoConfigSvcPrompt(appDir: string): () => Promise<{ ready: boolean }> {
  return async () => {
    fs.mkdirSync(path.resolve(appDir, '..', 'no-config-svc'), { recursive: true });
    return { ready: true };
  };
}

async function runTest4MissingConfigThrows(command: IssueCommand): Promise<void> {
  console.log('\nTest 4: throws when user confirms but wf.config.* is missing\n' + '-'.repeat(60));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-expand-'));
  const appDir = path.join(tmpRoot, 'primary-app');
  fs.mkdirSync(appDir, { recursive: true });
  const { restoreCwd } = overrideCwd(appDir);
  const { restoreTTY } = overrideTTY();
  const origPrompt = inquirer.prompt;
  (inquirer as any).prompt = makeNoConfigSvcPrompt(appDir);
  try {
    await checkMissingConfigThrows(command, appDir);
  } finally {
    teardownInteractiveTest(origPrompt, restoreCwd, restoreTTY, tmpRoot);
  }
}

async function checkDeclinedExpansion(command: IssueCommand, appDir: string): Promise<void> {
  const planArtifact = buildPlanArtifactForExpand(['primary-app', 'declined-svc'], ['declined-svc']);
  const result = await (command as any).expandReposFromPlan([undefined], planArtifact, appDir, false);
  const declinedDir = path.resolve(appDir, '..', 'declined-svc');
  if (result.includes('declined-svc')) fail('declined-svc should not be in returned repos');
  else pass('declined-svc is NOT in returned repos');
  if (result.includes(undefined)) pass('original repos preserved');
  else fail('original repos missing from result');
  if (fs.existsSync(declinedDir)) fail('declined-svc should not exist');
  else pass('declined-svc was NOT scaffolded');
}

async function runTest5UserDeclines(command: IssueCommand): Promise<void> {
  console.log('\nTest 5: returns original repos when user declines confirmation\n' + '-'.repeat(60));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-expand-'));
  const appDir = path.join(tmpRoot, 'primary-app');
  fs.mkdirSync(appDir, { recursive: true });
  const { restoreCwd } = overrideCwd(appDir);
  const { restoreTTY } = overrideTTY();
  const origPrompt = inquirer.prompt;
  (inquirer as any).prompt = async () => ({ ready: false });
  try {
    await checkDeclinedExpansion(command, appDir);
  } finally {
    teardownInteractiveTest(origPrompt, restoreCwd, restoreTTY, tmpRoot);
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueCommand);
  const implementer = (command as any).agents.implementer as {
    execute: (ticket: TicketArtifact, plan: PlanArtifact, opts: ImplementerOptions) => Promise<unknown>;
  };
  await runTest1SilentAutoScaffold(command, implementer);
  await runTest2InteractiveConfirm(command);
  await runTest3MissingDirThrows(command);
  await runTest4MissingConfigThrows(command);
  await runTest5UserDeclines(command);
  await app.close();
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
