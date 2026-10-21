/**
 * Manual test: issue API alignment
 *
 * Run: nr test:manual issue-api-alignment.smoke.ts
 *
 * Verifies:
 *   1. --silent flag is accepted (dry-run exits 0)
 *   2. --interactive flag is rejected (unknown option)
 *   3. --skip-existing flag is rejected (unknown option)
 *   4. -f / --force flag is accepted (dry-run exits 0)
 *   5. Without --force, dry-run skips FETCH stage when artifact exists (idempotent default)
 *   6. With --force, dry-run shows "overwrite" even when artifact exists
 *
 * Tests 1–4 call `node dist/main.js` — requires a recent `yarn build`.
 * Tests 5–6 call command.run() directly via NestFactory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import { createReporter, summarise } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/common/testing/env';

const { counts, pass, fail } = createReporter();

const distMain = path.join(__dirname, '../../dist/main.js');

const cliSandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-align-cli-'));
const cliSandboxEnv = {
  ...process.env,
  WF_HOME: path.join(cliSandboxRoot, '.wf'),
  WF_REPOS_DIR: path.join(cliSandboxRoot, 'repos'),
};
fs.mkdirSync(path.join(cliSandboxEnv.WF_REPOS_DIR, 'test-repo'), { recursive: true });

function buildCliErrorResult(err: any): { output: string; exitCode: number } {
  return {
    output: (err.stdout ?? '') + (err.stderr ?? ''),
    exitCode: err.status ?? 1,
  };
}

const runCli = (args: string): { output: string; exitCode: number } => {
  try {
    const output = execSync(`node ${distMain} issue ${args}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd: os.tmpdir(),
      env: cliSandboxEnv,
      timeout: 15_000,
    });
    return { output, exitCode: 0 };
  } catch (err: any) {
    return buildCliErrorResult(err);
  }
};

type ArtifactFixture = { tmpRoot: string; wfHome: string; reposDir: string; cleanup: () => void };

const writeArtifactFixtureFiles = (wfHome: string, reposDir: string, ticketKey: string): void => {
  const platformDir = path.join(wfHome, 'test-repo', 'jira');
  fs.mkdirSync(platformDir, { recursive: true });
  fs.mkdirSync(path.join(reposDir, 'test-repo'), { recursive: true });
  fs.writeFileSync(path.join(platformDir, `${ticketKey}.md`), `# ${ticketKey}: Fixture ticket\n`, 'utf-8');
};

const makeArtifactFixture = (ticketKey: string): ArtifactFixture => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-align-'));
  const wfHome = path.join(tmpRoot, '.wf');
  const reposDir = path.join(tmpRoot, 'repos');
  writeArtifactFixtureFiles(wfHome, reposDir, ticketKey);
  return {
    tmpRoot,
    wfHome,
    reposDir,
    cleanup: () => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
};

const captureStdout = async (fn: () => Promise<void>): Promise<string> => {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any, ...rest: any[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return original(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    (process.stdout.write as any) = original;
  }
  return chunks.join('');
};

function applyTmpEnv(
  ticketKey: string,
): { cleanup: () => void; originalCwd: string } {
  const { tmpRoot, wfHome, reposDir, cleanup } = makeArtifactFixture(ticketKey);
  const originalCwd = process.cwd();
  process.chdir(tmpRoot);
  withEnv({ WF_HOME: wfHome, WF_REPOS_DIR: reposDir });
  return { cleanup, originalCwd };
}

function teardownTmpEnv(originalCwd: string, cleanup: () => void): void {
  process.chdir(originalCwd);
  restoreEnv();
  cleanup();
}

async function runWithTmpEnv(
  command: IssueCommand,
  ticketKey: string,
  opts: Record<string, any>,
): Promise<{ output: string; error?: Error }> {
  const { cleanup, originalCwd } = applyTmpEnv(ticketKey);
  try {
    const output = await captureStdout(() => command.run([], { ticketKey, ...opts } as any));
    return { output };
  } catch (err: any) {
    return { output: '', error: err };
  } finally {
    teardownTmpEnv(originalCwd, cleanup);
  }
}

function checkSilentAccepted(): void {
  console.log(chalk.bold('Test 1: --silent flag is accepted'));
  const { exitCode } = runCli('-k TEST-1 --from fetch --to fetch --repos test-repo --dry-run --silent');
  if (exitCode === 0) {
    pass('--silent accepted; dry-run exited 0');
  } else {
    fail(`--silent: dry-run exited ${exitCode}`);
  }
}

function checkInteractiveFlagRejected(): void {
  console.log(chalk.bold('Test 2: --interactive flag is rejected'));
  const { exitCode, output } = runCli('-k TEST-2 --from fetch --to fetch --repos test-repo --dry-run --interactive');
  if (exitCode !== 0 || output.toLowerCase().includes('unknown option')) {
    pass('--interactive correctly rejected');
  } else {
    fail(`--interactive was accepted (exit ${exitCode}) — old flag still registered`);
  }
}

function checkSkipExistingFlagRejected(): void {
  console.log(chalk.bold('Test 3: --skip-existing flag is rejected'));
  const { exitCode, output } = runCli('-k TEST-3 --from fetch --to fetch --repos test-repo --dry-run --skip-existing');
  if (exitCode !== 0 || output.toLowerCase().includes('unknown option')) {
    pass('--skip-existing correctly rejected');
  } else {
    fail(`--skip-existing was accepted (exit ${exitCode}) — old flag still registered`);
  }
}

function checkForceFlag(): void {
  console.log(chalk.bold('Test 4: --force accepted; -f rejected (no short form after CLI refactor)'));
  const { exitCode: exitLong } = runCli('-k TEST-4 --from fetch --to fetch --repos test-repo --dry-run --force');
  const { exitCode: exitShort, output: shortOutput } = runCli('-k TEST-4 --from fetch --to fetch --repos test-repo --dry-run -f');
  const shortRejected = exitShort !== 0 || shortOutput.toLowerCase().includes('unknown option');
  if (exitLong === 0 && shortRejected) {
    pass('--force accepted; -f correctly rejected (short form removed to avoid --format conflict)');
  } else {
    fail(`--force exited ${exitLong} (expected 0); -f exited ${exitShort} rejected=${shortRejected} (expected true)`);
  }
}

async function checkNoForceSkips(command: IssueCommand): Promise<void> {
  console.log(chalk.bold('Test 5: No --force → dry-run skips FETCH when artifact exists'));
  const { output, error } = await runWithTmpEnv(command, 'TEST-5', { from: 'fetch', to: 'fetch', repos: ['test-repo'], dryRun: true });
  if (error) {
    fail(`Test 5 threw: ${error.message}`);
  } else if (output.toLowerCase().includes('skip')) {
    pass('Without --force, dry-run skips FETCH because artifact exists');
  } else {
    fail(`Expected "skip" in dry-run output but got:\n${output}`);
  }
}

async function checkForceOverwrites(command: IssueCommand): Promise<void> {
  console.log(chalk.bold('Test 6: --force → dry-run overwrites even when artifact exists'));
  const { output, error } = await runWithTmpEnv(command, 'TEST-6', { from: 'fetch', to: 'fetch', repos: ['test-repo'], dryRun: true, force: true });
  if (error) {
    fail(`Test 6 threw: ${error.message}`);
  } else if (output.toLowerCase().includes('overwrite')) {
    pass('With --force, dry-run shows "overwrite" for FETCH stage');
  } else {
    fail(`Expected "overwrite" in dry-run output but got:\n${output}`);
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 issue API alignment tests\n'));
  checkSilentAccepted();
  checkInteractiveFlagRejected();
  checkSkipExistingFlagRejected();
  checkForceFlag();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const command = app.get(IssueCommand);
  await checkNoForceSkips(command);
  await checkForceOverwrites(command);
  await app.close();
  fs.rmSync(cliSandboxRoot, { recursive: true, force: true });
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
