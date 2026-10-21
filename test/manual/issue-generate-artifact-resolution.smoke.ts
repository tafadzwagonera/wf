/**
 * Manual Test: issue:generate cwd-inferred artifact resolution without --repos
 *
 * Run: nr test:manual issue-generate-artifact-resolution.smoke.ts
 *
 * Verifies:
 *   1. Bare filename resolves to ~/.wf/<basename(cwd)>/<filename>, not <cwd>/<filename>
 *   2. Bare filename does NOT resolve against the code repository directory
 *   3. Absolute path to an existing artifact passes through unchanged
 *   4. Missing bare filename surfaces an actionable error (not a silent skip)
 *   5. Dry-run and execute paths both resolve the artifact successfully
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { createReporter, summarise } from './support/reporter';
const MOCK_AI_RESPONSE = [
  '# MOCK-1: Test artifact resolution',
  '',
  '**Type:** task',
  '**Priority:** medium',
  '',
  '## Description',
  '',
  '### Summary',
  'Artifact resolution test.',
  '',
  '#### Technical Details',
  'None',
  '',
  '### Acceptance Criteria',
  '- None',
  '',
  '### Risks & Assumptions',
  '- None',
].join('\n');

const SOURCE_CONTENT = [
  '# Test source artifact',
  '',
  'This file simulates a source artifact stored in ~/.wf/<repo>/.',
].join('\n');

const wfHome = path.join(os.homedir(), '.wf');
const testId = `__test-gen-artifact-${Date.now()}`;
const testRepoDir = path.join(os.tmpdir(), testId);
const testArtifactDir = path.join(wfHome, testId);
const testFilename = '2026-08-11-test-source.md';

const { counts, pass, fail } = createReporter();

function setup() {
  fs.mkdirSync(testRepoDir, { recursive: true });
  fs.mkdirSync(testArtifactDir, { recursive: true });
  fs.writeFileSync(path.join(testArtifactDir, testFilename), SOURCE_CONTENT);

  fs.writeFileSync(path.join(testRepoDir, testFilename), 'WRONG: resolved from cwd, not artifact dir');
}

function cleanup() {
  fs.rmSync(testRepoDir, { recursive: true, force: true });
  fs.rmSync(path.join(wfHome, testId), { recursive: true, force: true });
}

function interceptConsoleMethod(
  key: 'log' | 'error',
  append: (...args: string[]) => void,
): () => void {
  const original = console[key];
  console[key] = append;
  return () => {
    console[key] = original;
  };
}

function captureConsole(): { output: string; errors: string; restore: () => void } {
  const capture = { output: '', errors: '', restore: (): void => undefined };
  const restoreLog = interceptConsoleMethod('log', (...args: string[]) => {
    capture.output += args.map(String).join(' ') + '\n';
  });
  const restoreError = interceptConsoleMethod('error', (...args: string[]) => {
    capture.errors += args.map(String).join(' ') + '\n';
  });
  capture.restore = (): void => {
    restoreLog();
    restoreError();
  };
  return capture;
}

async function setupApp(): Promise<{ command: IssueGenerateCommand; teardown: () => Promise<void> }> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const originalExecute = AiService.prototype.execute;
  (AiService.prototype as any).execute = async () => ({ content: MOCK_AI_RESPONSE });
  return {
    command: app.get(IssueGenerateCommand),
    teardown: async () => {
      AiService.prototype.execute = originalExecute;
      await app.close();
    },
  };
}

async function checkBareFilenameResolvesToArtifactDir(command: IssueGenerateCommand): Promise<void> {
  process.chdir(testRepoDir);
  const capture = captureConsole();
  try {
    await command.run([testFilename], { dryRun: true });
  } finally {
    capture.restore();
  }
  const expectedArtifactPath = path.join(testArtifactDir, testFilename);
  if (capture.output.includes(expectedArtifactPath)) {
    pass('bare filename resolves to artifact dir');
  } else {
    fail('bare filename resolves to artifact dir', `output did not contain ${expectedArtifactPath}\n      stdout: ${capture.output.trim()}`);
  }
}

async function checkBareFilenameDoesNotResolveToCwd(command: IssueGenerateCommand): Promise<void> {
  process.chdir(testRepoDir);
  const capture = captureConsole();
  try {
    await command.run([testFilename], { dryRun: true });
  } finally {
    capture.restore();
  }
  const cwdPath = path.join(testRepoDir, testFilename);
  if (capture.output.includes(cwdPath)) {
    fail('bare filename does not resolve to cwd', `output contained cwd path ${cwdPath}`);
  } else {
    pass('bare filename does not resolve to cwd');
  }
}

async function checkAbsolutePathPassesThrough(command: IssueGenerateCommand): Promise<void> {
  process.chdir(testRepoDir);
  const absPath = path.join(testArtifactDir, testFilename);
  const capture = captureConsole();
  try {
    await command.run([absPath], { dryRun: true });
  } finally {
    capture.restore();
  }
  if (capture.output.includes(absPath)) {
    pass('absolute path passes through unchanged');
  } else {
    fail('absolute path passes through unchanged', `output did not contain ${absPath}`);
  }
}

const setupMockExit = (): { isExited: () => boolean; restore: () => void } => {
  let exitCalled = false;
  const origExit = process.exit;
  (process as any).exit = () => {
    exitCalled = true;
  };
  return {
    isExited: () => exitCalled,
    restore: () => {
      (process as any).exit = origExit;
    },
  };
};

async function runMissingFileCommand(
  command: IssueGenerateCommand,
): Promise<{ exitCalled: boolean; allOutput: string }> {
  process.chdir(testRepoDir);
  const mockExit = setupMockExit();
  const capture = captureConsole();
  try {
    await command.run(['nonexistent-source.md'], { dryRun: true, silent: true });
  } finally {
    capture.restore();
    mockExit.restore();
  }
  return { exitCalled: mockExit.isExited(), allOutput: capture.output + capture.errors };
}

const checkMissingFileErrorOutput = (allOutput: string): void => {
  const isActionable = allOutput.includes('--repos') || allOutput.includes('could not be resolved');
  if (isActionable) {
    pass('missing file error is actionable');
  } else {
    fail('missing file error is actionable', `output: ${allOutput.trim()}`);
  }
  const cwdPathIncluded = allOutput.includes(path.join(testRepoDir, 'nonexistent-source.md'));
  if (cwdPathIncluded) {
    fail('missing file error does not reference cwd path');
  } else {
    pass('missing file error does not reference cwd path');
  }
};

async function checkMissingFileError(command: IssueGenerateCommand): Promise<void> {
  const { exitCalled, allOutput } = await runMissingFileCommand(command);
  if (!exitCalled) {
    fail('missing file triggers process.exit', 'process.exit was not called');
    return;
  }
  checkMissingFileErrorOutput(allOutput);
}

async function runExecuteCapture(command: IssueGenerateCommand): Promise<{ output: string; error: Error | null }> {
  const capture = captureConsole();
  let error: Error | null = null;
  try {
    await command.run([testFilename], { silent: false });
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    capture.restore();
  }
  return { output: capture.output, error };
}

const runDryRunCapture = async (command: IssueGenerateCommand): Promise<string> => {
  process.chdir(testRepoDir);
  const dryCapture = captureConsole();
  try {
    await command.run([testFilename], { dryRun: true });
  } finally {
    dryCapture.restore();
  }
  return dryCapture.output;
};

const checkExecError = (execError: Error | null): boolean => {
  if (execError) {
    fail('execute path resolves artifact without error', `execute threw: ${execError.message}`);
    return true;
  }
  return false;
};

const validateResolutionResults = (dryOutput: string, execOutput: string, execError: Error | null): void => {
  const expectedPath = path.join(testArtifactDir, testFilename);
  if (checkExecError(execError)) return;
  if (dryOutput.includes(expectedPath) && execOutput.includes('Fetched')) {
    pass('dry-run and execute both resolve the artifact successfully');
  } else {
    fail(
      'dry-run and execute both resolve the artifact successfully',
      `dry-run has path: ${dryOutput.includes(expectedPath)}, execute fetched: ${execOutput.includes('Fetched')}`,
    );
  }
};

async function checkDryRunAndExecuteBothResolve(command: IssueGenerateCommand): Promise<void> {
  const dryOutput = await runDryRunCapture(command);
  const { output: execOutput, error: execError } = await runExecuteCapture(command);
  validateResolutionResults(dryOutput, execOutput, execError);
}

async function runAllChecks(command: IssueGenerateCommand): Promise<void> {
  await checkBareFilenameResolvesToArtifactDir(command);
  await checkBareFilenameDoesNotResolveToCwd(command);
  await checkAbsolutePathPassesThrough(command);
  await checkMissingFileError(command);
  await checkDryRunAndExecuteBothResolve(command);
}

async function main(): Promise<void> {
  console.log('\ntest-issue-generate-artifact-resolution\n');
  setup();
  const { command, teardown } = await setupApp();
  const origCwd = process.cwd();
  try {
    await runAllChecks(command);
  } finally {
    process.chdir(origCwd);
    await teardown();
    cleanup();
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
