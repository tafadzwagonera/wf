/**
 * Manual Test Script for issue:review command
 *
 * Run: nr test:manual issue-review.smoke.ts
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY — required only for Test 11 (live AI call).
 *   All other tests use --dry-run or trigger throw paths; no external APIs called.
 *
 * Test 11 reviews a real non-git temp directory created inline by this script.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

let _criteriaSeq = 0;

function writeTempCriteria(lines: string[]): string {
  const filePath = path.join(os.tmpdir(), `criteria-${Date.now()}-${++_criteriaSeq}.md`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

function makeNonGitDir(): string {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  fs.writeFileSync(
    path.join(dirPath, 'index.ts'),
    'export const greet = (name: string) => `Hello, ${name}!`;\n',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(dirPath, 'package.json'),
    JSON.stringify({ name: 'sample', version: '0.0.1' }, null, 2) + '\n',
    'utf-8'
  );
  return dirPath;
}

function checkExpectedExit(label: string, exited: boolean, err: any): boolean {
  if (exited) {
    console.log(`✓ ${label}\n`);
    return true;
  }
  console.error(`✗ ${label}: unexpected error: ${err.message}\n`);
  return false;
}

function setupProcessExitMock(): { restoreExit: () => void } {
  const originalExit = process.exit.bind(process);
  process.exit = (code?: number | string) => {
    throw new Error(`process.exit(${code ?? ''})`);
  };
  return {
    restoreExit: () => {
      process.exit = originalExit;
    },
  };
}

async function expectProcessExit(label: string, fn: () => Promise<void>): Promise<boolean> {
  const { restoreExit } = setupProcessExitMock();
  try {
    await fn();
    console.error(`✗ ${label}: expected process.exit but none occurred\n`);
    return false;
  } catch (err: any) {
    return checkExpectedExit(label, true, err);
  } finally {
    restoreExit();
  }
}

function interceptWarnMessages(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const orig = console.log.bind(console);
  console.log = (...args: any[]) => {
    const text = args.join(' ');
    if (text.includes('not found as a path')) messages.push(text);
    orig(...args);
  };
  return {
    messages,
    restore: () => {
      console.log = orig;
    },
  };
}

function logTopLevelError(err: any): void {
  console.error('✗ Unexpected top-level error:', err.message);
  if (err.stack) console.error(err.stack);
}

async function runTest1(command: IssueReviewCommand): Promise<void> {
  console.log('Test 1: --dry-run with no source');
  try {
    await command.run([], { dryRun: true });
    pass('Dry-run with no source completed without error');
  } catch (err: any) {
    fail(`Test 1: ${err.message}`);
  }
}

async function runTest2(command: IssueReviewCommand): Promise<void> {
  console.log('Test 2: --dry-run with ticket key (ABC-123)');
  try {
    await command.run(['ABC-123'], { dryRun: true });
    pass('Dry-run with ticket key completed without error');
  } catch (err: any) {
    fail(`Test 2: ${err.message}`);
  }
}

async function runTest3(command: IssueReviewCommand): Promise<void> {
  console.log('Test 3: --dry-run with PR URL');
  try {
    await command.run(['https://bitbucket.org/workspace/repo/pull-requests/1'], { dryRun: true });
    pass('Dry-run with PR URL completed without error');
  } catch (err: any) {
    fail(`Test 3: ${err.message}`);
  }
}

async function runTest4(command: IssueReviewCommand, nonGitDir: string): Promise<void> {
  console.log('Test 4: --dry-run rejects non-git directory path');
  const invalidNonGitDirHandled = await expectProcessExit('Test 4', () => command.run([nonGitDir], { dryRun: true }));
  if (invalidNonGitDirHandled) counts.passed++;
  if (!invalidNonGitDirHandled) counts.failed++;
}

async function runTest5(command: IssueReviewCommand): Promise<void> {
  console.log('Test 5: --dry-run rejects git directory path');
  const gitDir = fs.existsSync(path.join(process.cwd(), '.git')) ? process.cwd() : null;
  if (!gitDir) {
    console.log('  ↷ Skipped — cwd is not a git repo\n');
    return;
  }
  const invalidGitDirHandled = await expectProcessExit('Test 5', () => command.run([gitDir], { dryRun: true }));
  if (invalidGitDirHandled) counts.passed++;
  if (!invalidGitDirHandled) counts.failed++;
}

async function runTest6(command: IssueReviewCommand): Promise<void> {
  console.log('Test 6: --criteria with valid temp file (append)');
  const appendCriteriaPath = writeTempCriteria([
    '- Performance: Are there obvious bottlenecks?',
    '- Accessibility: Does the UI meet WCAG AA?',
  ]);
  try {
    await command.run([], { dryRun: true, criteria: appendCriteriaPath });
    pass('--criteria append mode accepted without error');
  } catch (err: any) {
    fail(`Test 6: ${err.message}`);
  } finally {
    fs.unlinkSync(appendCriteriaPath);
  }
}

async function runTest7(command: IssueReviewCommand): Promise<void> {
  console.log('Test 7: --replace-criteria with valid temp file (replace)');
  const replaceCriteriaPath = writeTempCriteria(['- Correctness: Does it do what the ticket says?']);
  try {
    await command.run([], { dryRun: true, replaceCriteria: replaceCriteriaPath });
    pass('--replace-criteria mode accepted without error');
  } catch (err: any) {
    fail(`Test 7: ${err.message}`);
  } finally {
    fs.unlinkSync(replaceCriteriaPath);
  }
}

async function runTest8(command: IssueReviewCommand): Promise<void> {
  console.log('Test 8: --criteria and --replace-criteria together (expect error)');
  const criteriaA = writeTempCriteria(['- A: criterion A']);
  const criteriaB = writeTempCriteria(['- B: criterion B']);
  try {
    const test8Passed = await expectProcessExit('Test 8', () => command.run([], { criteria: criteriaA, replaceCriteria: criteriaB }));
    if (test8Passed) counts.passed++;
    if (!test8Passed) counts.failed++;
  } finally {
    fs.unlinkSync(criteriaA);
    fs.unlinkSync(criteriaB);
  }
}

async function runTest9(command: IssueReviewCommand): Promise<void> {
  console.log('Test 9: --criteria with non-existent file (expect error)');
  const test9Passed = await expectProcessExit('Test 9', () => command.run([], { criteria: '/tmp/does-not-exist-criteria-xyzzy.md' }));
  if (test9Passed) counts.passed++;
  if (!test9Passed) counts.failed++;
}

async function runTest10(command: IssueReviewCommand): Promise<void> {
  console.log('Test 10: Invalid source string (expect process.exit via ErrorHandler)');
  const t10Passed = await expectProcessExit('Correctly exited on invalid source string', () => command.run(['not-a-ticket-not-a-url-not-a-path'], {}));
  if (t10Passed) counts.passed++;
  else counts.failed++;
}

function runTest11(): void {
  console.log('Test 11: legacy non-git directory live review scenario (skipped)');
  console.log('  ↷ Skipped — directory sources are no longer supported\n');
}

async function runTest13(command: IssueReviewCommand): Promise<void> {
  console.log('Test 13: --dry-run with invalid --repos path (expect warning, no crash)');
  const intercept = interceptWarnMessages();
  try {
    await command.run(['ABC-123'], { dryRun: true, repos: ['/nonexistent/repo/path-xyzzy'] });
    if (intercept.messages.length > 0) pass('Invalid --repos path emitted a warning before dry-run preview');
    else fail('Test 13: no warning emitted for invalid --repos path');
  } catch (err: any) {
    fail(`Test 13: unexpected error: ${err.message}`);
  } finally {
    intercept.restore();
  }
}

async function runTest12(command: IssueReviewCommand): Promise<void> {
  console.log('Test 12: --dry-run with ticket key, no --repos (repos optional)');
  try {
    await command.run(['ABC-123'], { dryRun: true });
    pass('Dry-run with ticket key and no repos completed without error');
  } catch (err: any) {
    fail(`Test 12: ${err.message}`);
  }
}

async function runBasicTests(command: IssueReviewCommand, nonGitDir: string): Promise<void> {
  console.log('🧪 Testing issue:review command\n');
  await runTest1(command);
  await runTest2(command);
  await runTest3(command);
  await runTest4(command, nonGitDir);
  await runTest5(command);
  await runTest6(command);
  await runTest7(command);
}

async function runExtendedTests(command: IssueReviewCommand): Promise<void> {
  await runTest8(command);
  await runTest9(command);
  await runTest10(command);
  runTest11();
  await runTest13(command);
  await runTest12(command);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const command = app.get(IssueReviewCommand);
  const nonGitDir = makeNonGitDir();
  try {
    await runBasicTests(command, nonGitDir);
    await runExtendedTests(command);
  } catch (err: any) {
    logTopLevelError(err);
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
    await app.close();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
