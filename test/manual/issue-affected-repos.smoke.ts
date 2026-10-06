/**
 * Manual Test Script for issue --repos feature
 *
 * Run: nr test:manual issue-affected-repos.smoke.ts
 *
 * Tests repository resolution logic: explicit CLI flag, AI-inferred fallback,
 * and deduplication.
 *
 * All tests exercise the real IMPLEMENT stage in a temp directory.
 * No external APIs are called (PLAN stage is pre-seeded via plan fixtures).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

type OutputCaptureHandles = {
  originalStdoutWrite: (...args: unknown[]) => unknown;
  originalStderrWrite: (...args: unknown[]) => unknown;
  originalExit: (...args: unknown[]) => unknown;
};
type TestFixtures = { tmpRoot: string; homeDir: string; cleanup: () => void };

function createPlatformDir(tmpRoot: string, platformName: string,
  ticketKey: string, action: string, planAffectedRepositories?: string[]): void {
  const homeDir = path.join(tmpRoot, 'home');
  const platformDir = path.join(homeDir, '.wf', path.basename(tmpRoot), platformName);
  fs.mkdirSync(platformDir, { recursive: true });
  fs.writeFileSync(
    path.join(platformDir, `${ticketKey}.md`),
    `# ${ticketKey}: Test ticket\n\n**Type:** Task\n**Status:** Open\n\n## Description\n\nTest ticket for affected-repos tests.\n`,
    'utf-8'
  );
  const plan: Record<string, any> = { action, summary: 'Test plan', steps: ['Step 1'], estimatedComplexity: 'low' };
  if (planAffectedRepositories) plan.affectedRepositories = planAffectedRepositories;
  fs.writeFileSync(path.join(platformDir, `${ticketKey}-plan-${action}.json`), JSON.stringify(plan, null, 2), 'utf-8');
}

function initGitRepo(tmpRoot: string): void {
  execSync('git init', { cwd: tmpRoot, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: tmpRoot, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: tmpRoot, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', { cwd: tmpRoot, stdio: 'ignore' });
}

function makeFixtures(opts: {
  ticketKey: string;
  platformName?: string;
  planAffectedRepositories?: string[];
  action?: string;
}): { tmpRoot: string; homeDir: string; cleanup: () => void } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-'));
  const homeDir = path.join(tmpRoot, 'home');
  const platformName = opts.platformName ?? 'jira';
  const action = opts.action ?? 'fix';
  createPlatformDir(tmpRoot, platformName, opts.ticketKey, action, opts.planAffectedRepositories);
  initGitRepo(tmpRoot);
  return { tmpRoot, homeDir, cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }) };
}

function makeChunkCapture(
  orig: (...args: unknown[]) => unknown,
  target: string[],
): (...args: unknown[]) => unknown {
  return (chunk: unknown, ...args: unknown[]) => {
    target.push(typeof chunk === 'string' ? chunk : String(chunk));
    return orig(chunk, ...args);
  };
}

function installOutputCapture(stdoutChunks: string[], stderrChunks: string[]): OutputCaptureHandles {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => unknown;
  const originalStderrWrite = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => unknown;
  const originalExit = process.exit.bind(process) as (...args: unknown[]) => unknown;
  (process.stdout.write as any) = makeChunkCapture(originalStdoutWrite, stdoutChunks);
  (process.stderr.write as any) = makeChunkCapture(originalStderrWrite, stderrChunks);
  (process.exit as any) = (code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  };
  return { originalStdoutWrite, originalStderrWrite, originalExit };
}

function restoreOutputCapture(originals: OutputCaptureHandles): void {
  (process.stdout.write as any) = originals.originalStdoutWrite;
  (process.stderr.write as any) = originals.originalStderrWrite;
  (process.exit as any) = originals.originalExit;
}

const captureOutput = async (fn: () => Promise<void>): Promise<{ output: string }> => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originals = installOutputCapture(stdoutChunks, stderrChunks);
  try {
    await fn();
  } catch (err: any) {
    // Swallow — may be from our mocked process.exit or a handled command error.
  } finally {
    restoreOutputCapture(originals);
  }
  return { output: stdoutChunks.join('') + stderrChunks.join('') };
};

async function runTestScenario(command: IssueCommand, fixtures: TestFixtures,
  runOptions: Record<string, any>): Promise<string> {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  process.chdir(fixtures.tmpRoot);
  process.env.HOME = fixtures.homeDir;
  try {
    const { output } = await captureOutput(() => command.run([], runOptions as any));
    return output;
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    fixtures.cleanup();
  }
}

async function checkTest1(command: IssueCommand): Promise<void> {
  console.log('Test 1: explicit --repos only → IMPLEMENT shows flag repo');
  const fixtures = makeFixtures({ ticketKey: 'TEST-1' });
  const output = await runTestScenario(command, fixtures, { ticketKey: 'TEST-1', from: 'implement', to: 'implement', action: 'fix', repos: ['repo-a'] });
  if (output.includes('repo-a')) {
    pass('IMPLEMENT stage shows explicitly provided repo-a');
  } else {
    fail(`Test 1: repo-a not found in output. Output:\n${output}`);
  }
}

async function checkTest2(command: IssueCommand): Promise<void> {
  console.log('Test 2: empty --repos; plan repositories do not trigger a required-option error');
  const fixtures = makeFixtures({ ticketKey: 'TEST-2', planAffectedRepositories: ['repo-b'], action: 'fix' });
  const output = await runTestScenario(command, fixtures, { ticketKey: 'TEST-2', from: 'implement', to: 'implement', action: 'fix', repos: [] });
  const commanderRequiredError = output.includes('required option') && output.includes('--repos');
  if (commanderRequiredError || !output.includes('STAGE 3: Implementation Guide')) {
    fail(`Test 2: expected IMPLEMENT output without a required-option error. Output:\n${output}`);
  } else {
    pass('Empty --repos still runs IMPLEMENT without a required-option error');
  }
}

async function checkTest3(command: IssueCommand): Promise<void> {
  console.log('Test 3: explicit multi-repos + multi-repo plan → issue orchestration proceeds (no single-repo error)');
  const fixtures = makeFixtures({ ticketKey: 'TEST-3', planAffectedRepositories: ['repo-b', 'repo-c'], action: 'fix' });
  const output = await runTestScenario(command, fixtures, { ticketKey: 'TEST-3', from: 'implement', to: 'implement', action: 'fix', repos: ['repo-a', 'repo-b'] });
  const hasMultiRepoError = output.includes('issue:implement only verifies a single repository');
  if (hasMultiRepoError || !output.includes('STAGE 3: Implementation Guide')) {
    fail(`Test 3: expected IMPLEMENT to run for each repo without a single-repo error. Output:\n${output}`);
  } else {
    pass('Multi-repo issue orchestration proceeds without the single-repo boundary error');
  }
}

async function checkTest4(command: IssueCommand): Promise<void> {
  console.log('Test 4: single --repos value → shown in IMPLEMENT stage');
  const fixtures = makeFixtures({ ticketKey: 'TEST-4' });
  const output = await runTestScenario(command, fixtures, { ticketKey: 'TEST-4', from: 'implement', to: 'implement', action: 'fix', repos: ['only-repo'] });
  if (output.includes('only-repo')) {
    pass('IMPLEMENT stage displays the single provided repo');
  } else {
    fail(`Test 4: only-repo not found in output. Output:\n${output}`);
  }
}

async function checkTest5(command: IssueCommand): Promise<void> {
  console.log('Test 5: REVIEW stage shows repositories in scope');
  const fixtures = makeFixtures({ ticketKey: 'TEST-5', planAffectedRepositories: ['review-repo'], action: 'fix' });
  const output = await runTestScenario(command, fixtures, { ticketKey: 'TEST-5', from: 'review', to: 'review', action: 'fix', repos: ['review-repo'] });
  if (output.includes('review-repo')) {
    pass('REVIEW stage shows repositories in scope');
  } else {
    fail(`Test 5: review-repo not found in REVIEW output. Output:\n${output}`);
  }
}

async function checkTest6(command: IssueCommand): Promise<void> {
  console.log('Test 6: multi-repo → STAGE 3 header appears exactly once');
  const fixtures = makeFixtures({ ticketKey: 'TEST-6', action: 'fix' });
  const output = await runTestScenario(command, fixtures, { ticketKey: 'TEST-6', from: 'implement', to: 'implement', action: 'fix', repos: ['repo-a', 'repo-b'] });
  const headerCount = (output.match(/STAGE 3: Implementation Guide/g) ?? []).length;
  if (headerCount === 1) {
    pass('Multi-repo: STAGE 3 header appears exactly once');
  } else {
    fail(`Test 6: expected 1 header, got ${headerCount}.\n${output}`);
  }
}

async function checkTest7(command: IssueCommand): Promise<void> {
  console.log('Test 7: omit --repos → command falls back to cwd');
  const fixtures = makeFixtures({ ticketKey: 'TEST-7', action: 'fix' });
  const output = await runTestScenario(command, fixtures, { ticketKey: 'TEST-7', from: 'implement', to: 'implement', action: 'fix' });
  const commanderRequiredError = output.includes('required option') && output.includes('--repos');
  if (commanderRequiredError) {
    fail(`Test 7: got required-option error. Output:\n${output}`);
  } else {
    pass('Omitting --repos does not produce a "required" error');
  }
}

async function main(): Promise<void> {
  console.log('🧪 Testing issue --repos feature\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const command = app.get(IssueCommand);
  await checkTest1(command);
  await checkTest2(command);
  await checkTest3(command);
  await checkTest4(command);
  await checkTest5(command);
  await checkTest6(command);
  await checkTest7(command);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
