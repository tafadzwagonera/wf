/**
 * Manual Test: SEA binary extracts the git shim and no-mcp.json for a Claude CLI stage
 *
 * Run: nr test:manual sea-binary-cli-backend-extracts-shim-and-mcp-config.smoke
 * Precondition: yarn build:sea
 *
 * Verifies:
 *   1. <HOME>/.wf/bin/git-shim/git exists, is mode 0755 and equals src/bootstrap/git-shim/git
 *   2. <HOME>/.wf/bin/no-mcp.json exists and equals src/bootstrap/no-mcp.json
 *   3. The spawned claude receives --mcp-config <HOME>/.wf/bin/no-mcp.json
 *   4. The spawned claude's PATH starts with <HOME>/.wf/bin/git-shim
 *   5. A second run leaves both extracted files untouched (same inode)
 *   6. When the git-shim directory cannot be created, the stage still starts and PATH has no shim first
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanupHarness, setupImplementHarness, type ImplementHarness } from './support/implement-cli-harness';
import {
  assertSeaBinaryBuilt, installRecordingFakeClaude, projectRoot, readRecordings, seaBinaryPath,
} from './support/sea-binary-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const check = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

const runWithSeaBinary = (harness: ImplementHarness): string => {
  const env = {
    HOME: harness.homeDir,
    PATH: `${harness.binDir}:/usr/bin:/bin`,
    SEA_RECORD_DIR: harness.promptDir,
  };
  const result = spawnSync(
    seaBinaryPath,
    ['issue:implement', harness.planPath, '--silent', '--no-branch', '--skip-install'],
    { cwd: harness.repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10, timeout: 90_000 },
  );
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
};

const createHarness = (): ImplementHarness => {
  const harness = setupImplementHarness('sea-cli-', 'noop', ['src/a.ts']);
  installRecordingFakeClaude(harness.binDir);
  return harness;
};

const read = (relative: string): string => fs.readFileSync(path.join(projectRoot, relative), 'utf-8');

function checkExtractedFiles(harness: ImplementHarness): void {
  const shimFile = path.join(harness.homeDir, '.wf', 'bin', 'git-shim', 'git');
  const mcpFile = path.join(harness.homeDir, '.wf', 'bin', 'no-mcp.json');
  const shimOk = fs.existsSync(shimFile)
    && (fs.statSync(shimFile).mode & 0o777) === 0o755
    && fs.readFileSync(shimFile, 'utf-8') === read('src/bootstrap/git-shim/git');
  check(shimOk, 'git shim extracted with mode 0755 and the embedded content', shimFile);
  const mcpOk = fs.existsSync(mcpFile) && fs.readFileSync(mcpFile, 'utf-8') === read('src/bootstrap/no-mcp.json');
  check(mcpOk, 'no-mcp.json extracted with the embedded content', mcpFile);
}

function checkSpawnedClaude(harness: ImplementHarness): void {
  const mcpFile = path.join(harness.homeDir, '.wf', 'bin', 'no-mcp.json');
  const shimDir = path.join(harness.homeDir, '.wf', 'bin', 'git-shim');
  const argvs = readRecordings(harness.promptDir, 'argv');
  const paths = readRecordings(harness.promptDir, 'path');
  check(argvs.length > 0, 'claude was spawned at least once');
  const argLines = argvs[0]?.split('\n') ?? [];
  check(argLines[argLines.indexOf('--mcp-config') + 1] === mcpFile, 'claude received --mcp-config with the extracted path', argLines.join(' '));
  check(paths[0]?.trim().split(':')[0] === shimDir, 'claude PATH starts with the extracted shim dir', paths[0]);
}

function checkSecondRunIsIdempotent(harness: ImplementHarness): void {
  const files = ['git-shim/git', 'no-mcp.json'].map(rel => path.join(harness.homeDir, '.wf', 'bin', rel));
  const before = files.map(f => fs.statSync(f).ino);
  runWithSeaBinary(harness);
  const after = files.map(f => fs.statSync(f).ino);
  check(JSON.stringify(before) === JSON.stringify(after), 'second run leaves extracted files untouched', `${before} vs ${after}`);
}

function checkShimFailureDegrades(): void {
  const harness = createHarness();
  try {
    const binDir = path.join(harness.homeDir, '.wf', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'git-shim'), 'not a directory');
    runWithSeaBinary(harness);
    const paths = readRecordings(harness.promptDir, 'path');
    const shimDir = path.join(binDir, 'git-shim');
    check(paths.length > 0, 'stage still starts when the shim dir cannot be created');
    check(paths.length > 0 && paths[0].trim().split(':')[0] !== shimDir, 'PATH has no shim first after extraction failure', paths[0]);
  } finally {
    cleanupHarness(harness);
  }
}

function main(): void {
  assertSeaBinaryBuilt();
  console.log('\n SEA binary: CLI backend extraction\n');
  const harness = createHarness();
  try {
    runWithSeaBinary(harness);
    checkExtractedFiles(harness);
    checkSpawnedClaude(harness);
    checkSecondRunIsIdempotent(harness);
  } finally {
    cleanupHarness(harness);
  }
  checkShimFailureDegrades();
  summarise(counts);
}

main();
