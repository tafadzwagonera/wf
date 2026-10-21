/**
 * Manual Test: issue:implement custom plan path resolution
 *
 * Run: nr test:manual issue-implement-plan-resolution.smoke.ts
 *
 * Verifies:
 *   1. Bare filename (e.g. plan.json) resolves to ~/.wf/<app>/plan.json (custom artifact dir)
 *   2. Relative path (e.g. subdir/plan.json) resolves from the app root
 *   3. Bare filename with --repos resolves to ~/.wf/<repo>/plan.json (custom artifact dir)
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/common/testing/env';

const { counts, pass, fail } = createReporter();

function captureStdout(): { restore: () => string } {
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any) => {
    out += String(chunk);
    return true;
  };
  return {
    restore: () => {
      process.stdout.write = orig;
      return out;
    },
  };
}

const minimalPlan = JSON.stringify({ action: 'feature', steps: [], affectedFiles: [], affectedRepositories: [] });

async function test1Env(command: IssueImplementCommand, tmpDir: string, expectedPath: string): Promise<void> {
  const origCwd = process.cwd.bind(process);
  (process as any).cwd = () => tmpDir;
  const stdoutCapture = captureStdout();
  await command.run(['my-plan.json'], { tracker: 'jira', dryRun: true });
  const output = stdoutCapture.restore();
  (process as any).cwd = origCwd;
  if (output.includes(expectedPath)) pass(`Dry-run output references artifact path: ${expectedPath}`);
  else fail('Dry-run output does not contain expected artifact path', `expected: ${expectedPath}\noutput snippet: ${output.slice(0, 400)}`);
}

async function runTest1(command: IssueImplementCommand): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-resolution-'));
  withEnv({ HOME: tmpDir, WF_HOME: path.join(tmpDir, '.wf') });
  const customDir = path.join(tmpDir, '.wf', path.basename(tmpDir));
  fs.mkdirSync(customDir, { recursive: true });
  const expectedPath = path.join(customDir, 'my-plan.json');
  fs.writeFileSync(expectedPath, minimalPlan);
  try {
    await test1Env(command, tmpDir, expectedPath);
  } finally {
    restoreEnv();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function test2Env(command: IssueImplementCommand, tmpDir: string, expectedPath: string): Promise<void> {
  const origCwd = process.cwd.bind(process);
  (process as any).cwd = () => tmpDir;
  const stdoutCapture = captureStdout();
  await command.run(['subdir/my-plan.json'], { dryRun: true });
  const output = stdoutCapture.restore();
  (process as any).cwd = origCwd;
  if (output.includes(expectedPath)) pass(`Dry-run output references resolved path: ${expectedPath}`);
  else fail('Dry-run output does not contain expected resolved path', `expected: ${expectedPath}\noutput snippet: ${output.slice(0, 400)}`);
}

function setupTest2Env(tmpDir: string): string {
  fs.mkdirSync(path.join(tmpDir, '.wf', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.wf', 'state'), { recursive: true });
  const subDir = path.join(tmpDir, 'subdir');
  fs.mkdirSync(subDir, { recursive: true });
  const expectedPath = path.resolve(tmpDir, 'subdir', 'my-plan.json');
  fs.writeFileSync(expectedPath, minimalPlan);
  return expectedPath;
}

async function runTest2(command: IssueImplementCommand): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-resolution-'));
  withEnv({ HOME: tmpDir, WF_HOME: path.join(tmpDir, '.wf') });
  const expectedPath = setupTest2Env(tmpDir);
  try {
    await test2Env(command, tmpDir, expectedPath);
  } finally {
    restoreEnv();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function test3Env(command: IssueImplementCommand, appDir: string, expectedPath: string): Promise<void> {
  const origCwd = process.cwd.bind(process);
  (process as any).cwd = () => appDir;
  const stdoutCapture = captureStdout();
  await command.run(['bar-plan-fix.json'], { tracker: 'jira', repos: ['bar'], dryRun: true });
  const output = stdoutCapture.restore();
  (process as any).cwd = origCwd;
  if (output.includes(expectedPath)) pass(`Dry-run output references repo artifact path: ${expectedPath}`);
  else fail('Dry-run output does not contain expected repo artifact path', `expected: ${expectedPath}\noutput snippet: ${output.slice(0, 400)}`);
}

function setupTest3Env(tmpBase: string): { appDir: string; expectedPath: string } {
  const appDir = path.join(tmpBase, 'myapp');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(tmpBase, 'bar'), { recursive: true });
  const customDir = path.join(tmpBase, '.wf', 'bar');
  fs.mkdirSync(customDir, { recursive: true });
  const expectedPath = path.join(customDir, 'bar-plan-fix.json');
  fs.writeFileSync(expectedPath, minimalPlan);
  return { appDir, expectedPath };
}

async function runTest3(command: IssueImplementCommand): Promise<void> {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-repos-'));
  withEnv({ HOME: tmpBase, WF_HOME: path.join(tmpBase, '.wf') });
  const { appDir, expectedPath } = setupTest3Env(tmpBase);
  try {
    await test3Env(command, appDir, expectedPath);
  } finally {
    restoreEnv();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

function reportResults(): void {
  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) console.log('✓ All tests passed!');
  console.log('━'.repeat(60));
}

async function runAllTests(command: IssueImplementCommand): Promise<void> {
  console.log('\n🧪 Test 1: bare filename resolves to custom artifact dir\n' + '─'.repeat(60));
  await runTest1(command);
  console.log('\n🧪 Test 2: relative path resolves from app root\n' + '─'.repeat(60));
  await runTest2(command);
  console.log('\n🧪 Test 3: bare filename with --repos resolves to repo custom artifact dir\n' + '─'.repeat(60));
  await runTest3(command);
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
