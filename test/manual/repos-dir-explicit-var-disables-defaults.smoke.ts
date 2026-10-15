import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { summarise } from './support/reporter';
import {
  ANTHROPIC_MARKER, assertLoaded, check, homeEnv, reporter, runCli, writeProviderConfig,
} from './support/repos-dir-harness';

const COMMAND = 'issue:commit --dry-run -r shadowed-repo';
const HINT = 'set WF_REPOS_DIR to the directory containing your repositories.';

function checkExplicitVar(fakeHome: string, emptyDir: string, cwd: string): void {
  const result = runCli(COMMAND, cwd, homeEnv(fakeHome, { WF_REPOS_DIR: emptyDir }));
  check(result.exitCode !== 0, 'explicit var: exits non-zero', result.stderr);
  check(result.stdout === '', 'explicit var: stdout is empty', result.stdout);
  check(result.stderr.includes("Repository 'shadowed-repo' not found"), 'explicit var: not-found error', result.stderr);
  check(result.stderr.includes(path.join(emptyDir, 'shadowed-repo')), 'explicit var: lists the var candidate', result.stderr);
  check(!result.stderr.includes(path.join(fakeHome, 'Projects')), 'explicit var: skips the Projects default', result.stderr);
  check(!result.stderr.includes(path.join(fakeHome, 'Apps')), 'explicit var: skips the Apps default', result.stderr);
  check(result.stderr.includes(HINT), 'explicit var: includes the WF_REPOS_DIR hint', result.stderr);
}

function runScenario(tempRoot: string): void {
  const fakeHome = path.join(tempRoot, 'home');
  const emptyDir = path.join(tempRoot, 'empty-checkouts');
  const cwd = path.join(tempRoot, 'unrelated');
  writeProviderConfig(path.join(fakeHome, 'Projects', 'shadowed-repo'), 'anthropic');
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  checkExplicitVar(fakeHome, emptyDir, cwd);
  const control = runCli(COMMAND, cwd, homeEnv(fakeHome, { WF_REPOS_DIR: undefined }));
  assertLoaded(control, 'control (var unset)', ANTHROPIC_MARKER);
}

function main(): void {
  console.log('\nManual smoke test: explicit WF_REPOS_DIR disables default probing\n');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repos-explicit-'));
  try {
    runScenario(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(reporter.counts);
}

main();
