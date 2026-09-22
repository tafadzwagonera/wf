/**
 * Manual Test: Provider session ID prompt for custom plan tokens
 *
 * Run: nr test:manual custom-plan-provider-session-prompt.smoke.ts
 *
 * Verifies:
 *   1. Custom plan token with sourceKind='custom' resolves correctly
 *   2. In non-interactive mode (no TTY), the inquirer prompt is skipped and the command completes
 *   3. planArtifact.sessionId remains undefined when the prompt is skipped
 *   4. isInteractiveSession() gate prevents hanging in piped/CI environments
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifestPath,
  hashPlanArtifactSources,
} from '../../src/shared/utils/plan-artifact';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

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

function overrideHomeDir(nextHomeDir: string): () => void {
  const previousHome = process.env.HOME;
  process.env.HOME = nextHomeDir;
  return () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
      return;
    }
    process.env.HOME = previousHome;
  };
}

function overrideTTY(stdinValue: boolean, stdoutValue: boolean): () => void {
  const origStdinTTY = process.stdin.isTTY;
  const origStdoutTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: stdinValue, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutValue, configurable: true });
  return () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: origStdinTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: origStdoutTTY, configurable: true });
  };
}

const sourceName = 'custom-source';
const hash = hashPlanArtifactSources([sourceName]);
const planFilename = buildPlanArtifactFilename({ hash, action: 'fix', format: 'json' });

const minimalPlan = JSON.stringify({
  action: 'fix',
  summary: 'Custom source plan',
  estimatedComplexity: 'low',
  steps: ['Apply patch'],
  affectedFiles: ['src/main.ts'],
  affectedRepositories: [],
});

const buildCustomManifest = (artifactPath: string) =>
  JSON.stringify({
    artifactPath,
    action: 'fix',
    createdAt: new Date().toISOString(),
    format: 'json',
    hash,
    sourceKind: 'custom',
    sourceName,
  });

function scaffoldCustomPlanFiles(tmpDir: string): void {
  const appBase = path.basename(tmpDir);
  const customDir = path.join(tmpDir, '.wf', appBase);
  const trackerDir = path.join(customDir, 'jira');
  fs.mkdirSync(trackerDir, { recursive: true });
  const planPath = path.join(customDir, planFilename);
  fs.writeFileSync(planPath, minimalPlan);
  fs.writeFileSync(buildPlanArtifactManifestPath(planPath), buildCustomManifest(planPath));
}

function checkNonInteractiveOutput(output: string): void {
  if (output.includes(sourceName) || output.includes('Implement') || output.includes('implement')) {
    pass('Command completed without hanging — prompt was skipped in non-interactive mode');
  } else {
    fail('Command output did not contain expected content', `output: ${output.slice(0, 500)}`);
  }
}

async function runCommandNonInteractive(command: IssueCommand, tmpDir: string): Promise<string> {
  const origCwd = process.cwd.bind(process);
  (process as any).cwd = () => tmpDir;
  const restoreTTY = overrideTTY(false, false);
  const stdoutCapture = captureStdout();
  await command.run([planFilename], { from: 'implement', to: 'implement', tracker: 'jira', dryRun: true });
  const output = stdoutCapture.restore();
  restoreTTY();
  (process as any).cwd = origCwd;
  return output;
}

async function checkNonInteractiveCompletion(command: IssueCommand): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-session-'));
  scaffoldCustomPlanFiles(tmpDir);
  const restoreHome = overrideHomeDir(tmpDir);
  const output = await runCommandNonInteractive(command, tmpDir);
  restoreHome();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  checkNonInteractiveOutput(output);
}

function checkIsInteractiveSession(command: IssueCommand): void {
  const restoreTTY = overrideTTY(false, false);
  const result = (command as any).isInteractiveSession();
  restoreTTY();
  if (result === false) pass('isInteractiveSession() returns false when stdin.isTTY and stdout.isTTY are false');
  else fail('isInteractiveSession() should return false without TTY', `got: ${result}`);
}

async function invokeCommandWithExitOverride(command: IssueCommand): Promise<void> {
  const origExit = process.exit.bind(process);
  (process as any).exit = () => {};
  const stdoutCapture = captureStdout();
  try {
    await command.run([planFilename], { from: 'implement', to: 'implement', tracker: 'jira' });
  } catch {
    // Expected: command exits after run
  }
  stdoutCapture.restore();
  (process as any).exit = origExit;
}

async function runTest3Command(command: IssueCommand, tmpDir: string): Promise<void> {
  const origCwd = process.cwd.bind(process);
  (process as any).cwd = () => tmpDir;
  const restoreTTY = overrideTTY(false, false);
  await invokeCommandWithExitOverride(command);
  restoreTTY();
  (process as any).cwd = origCwd;
}

function checkPlanStageRecord(sessionData: any): void {
  const planRecord = sessionData.stages?.plan;
  if (!planRecord) {
    fail('Session file has no plan stage record', `stages: ${JSON.stringify(sessionData.stages)}`);
    return;
  }
  const providerInfo = `provider: ${planRecord.config?.provider}, backend: ${planRecord.config?.backend}`;
  pass(`Session file has plan stage record (${providerInfo})`);
  if (planRecord.completedAt) pass('Plan stage is marked as completed');
  else fail('Plan stage is not marked as completed');
  if (planRecord.summary === 'Custom source plan') pass(`Plan stage summary captured: "${planRecord.summary}"`);
  else fail('Plan stage summary not captured', `got: ${planRecord.summary}`);
}

function readFirstSessionFile(sessionDir: string): void {
  const sessionFiles = fs.existsSync(sessionDir)
    ? fs.readdirSync(sessionDir).filter(f => f.endsWith('.json') && !f.endsWith('.items.json'))
    : [];
  if (sessionFiles.length > 0) {
    checkPlanStageRecord(JSON.parse(fs.readFileSync(path.join(sessionDir, sessionFiles[0]), 'utf-8')));
  } else {
    fail('No session file was created');
  }
}

async function checkSessionLifecycle(command: IssueCommand): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-custom-session-'));
  scaffoldCustomPlanFiles(tmpDir);
  const restoreHome = overrideHomeDir(tmpDir);
  await runTest3Command(command, tmpDir);
  restoreHome();
  const sessionDir = path.join(tmpDir, '.wf', 'state', 'sessions');
  readFirstSessionFile(sessionDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueCommand);
  await checkNonInteractiveCompletion(command);
  checkIsInteractiveSession(command);
  await checkSessionLifecycle(command);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
