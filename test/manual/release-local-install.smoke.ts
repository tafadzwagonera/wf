/**
 * Manual Test: release:local builds, installs to WF_INSTALL_DIR and prints the right shell hint
 *
 * Run: nr test:manual release-local-install.smoke
 * Slow: run A performs a full `yarn release:local` (including `yarn build:sea`).
 *
 * Run B calls `sh scripts/sea/release-local.sh` (the body of the release:local package script)
 * with a `yarn` shim first on PATH so it does not rebuild; it does not prove the build step.
 *
 * Verifies:
 *   1. run A exits 0 and <tmp>/new/bin/wf exists and is executable (the folder was created)
 *   2. run A output contains "wf v<package.json version> is installed and working!"
 *   3. run A output contains the `hash -r` reminder (install folder on PATH)
 *   4. run B exits 0 and prints "Note: <dir> is not on your PATH." (folder off PATH)
 *   5. run B output has no `hash -r` reminder
 *   6. the real ~/.local/bin/wf is untouched by both runs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempDir, projectRoot, removeDir, seaBinaryPath } from './support/sea-binary-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const check = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

const realInstallPath = path.join(os.homedir(), '.local', 'bin', 'wf');
const hashReminder = "Run 'hash -r' in your current shell";

type RunResult = { exitCode: number | null; output: string };

const runCommand = (command: string, args: string[], env: Record<string, string | undefined>): RunResult => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 50,
    timeout: 15 * 60_000,
  });
  return { exitCode: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
};

const realInstallMtime = (): number | null =>
  fs.existsSync(realInstallPath) ? fs.statSync(realInstallPath).mtimeMs : null;

const isExecutableFile = (filePath: string): boolean => {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const checkRunA = (tempRoot: string): void => {
  const installDir = path.join(tempRoot, 'new', 'bin');
  const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')) as { version: string };
  const result = runCommand('yarn', ['release:local'], {
    ...process.env,
    WF_INSTALL_DIR: installDir,
    PATH: `${installDir}:${process.env.PATH}`,
  });
  check(result.exitCode === 0 && isExecutableFile(path.join(installDir, 'wf')),
    'run A exits 0 and installs an executable wf into a new folder', `exit ${result.exitCode}: ${result.output.slice(-400)}`);
  check(result.output.includes(`wf v${version} is installed and working!`),
    `run A prints wf v${version} is installed and working!`, result.output.slice(-400));
  check(result.output.includes(hashReminder), 'run A prints the hash -r reminder', result.output.slice(-400));
};

const runScriptWithShimmedYarn = (tempRoot: string, installDir: string): RunResult => {
  const shimDir = path.join(tempRoot, 'shim');
  fs.mkdirSync(shimDir);
  fs.writeFileSync(path.join(shimDir, 'yarn'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return runCommand('sh', ['scripts/sea/release-local.sh'], {
    ...process.env,
    WF_INSTALL_DIR: installDir,
    PATH: `${shimDir}:${process.env.PATH}`,
  });
};

const checkRunB = (tempRoot: string): void => {
  if (!fs.existsSync(seaBinaryPath)) {
    fail('dist-bundle/wf is missing after run A', seaBinaryPath);
    return;
  }
  const installDir = path.join(tempRoot, 'other', 'bin');
  const result = runScriptWithShimmedYarn(tempRoot, installDir);
  check(result.exitCode === 0 && result.output.includes(`Note: ${installDir} is not on your PATH.`),
    'run B exits 0 and prints the not-on-PATH note', `exit ${result.exitCode}: ${result.output.slice(-400)}`);
  check(!result.output.includes(hashReminder), 'run B does not print the hash -r reminder', result.output.slice(-400));
};

const main = (): void => {
  console.log('\n release:local install\n');
  const tempRoot = createTempDir('release-local-');
  const mtimeBefore = realInstallMtime();
  try {
    checkRunA(tempRoot);
    checkRunB(tempRoot);
  } finally {
    removeDir(tempRoot);
  }
  check(realInstallMtime() === mtimeBefore, 'the real ~/.local/bin/wf is untouched');
  summarise(counts);
};

main();
