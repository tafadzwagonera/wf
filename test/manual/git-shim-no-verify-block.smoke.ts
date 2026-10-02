import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { buildGitShimEnvOverrides } from '../../src/shared/utils/git-shim-path';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

function makeRepo(): { dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-shim-test-'));
  const run = (cmd: string) => execSync(cmd, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  run('git init');
  run('git config user.email "test@example.com"');
  run('git config user.name "Test"');
  run('git config commit.gpgsign false');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello');
  run('git add file.txt');
  return { dir };
}

function runGit(args: string[], dir: string, env: NodeJS.ProcessEnv): { status: number; stderr: string } {
  const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf-8' });
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

function assertBlockedCommands(dir: string, shimEnv: NodeJS.ProcessEnv): void {
  const r1 = runGit(['commit', '--no-verify', '-m', 'test'], dir, shimEnv);
  assert('--no-verify is blocked', r1.status !== 0 && r1.stderr.includes('wf: git commit --no-verify is blocked'), r1.stderr);
  const r2 = runGit(['commit', '-n', '-m', 'test'], dir, shimEnv);
  assert('-n flag is blocked', r2.status !== 0 && r2.stderr.includes('wf: git commit --no-verify is blocked'), r2.stderr);
  const r3 = runGit(['commit', '-an', '-m', 'test'], dir, shimEnv);
  assert('-an cluster is blocked', r3.status !== 0 && r3.stderr.includes('wf: git commit --no-verify is blocked'), r3.stderr);
  const r4 = runGit(['-C', dir, 'commit', '--no-verify', '-m', 'test'], dir, shimEnv);
  assert('git -C <dir> commit --no-verify is blocked', r4.status !== 0 && r4.stderr.includes('wf: git commit --no-verify is blocked'), r4.stderr);
  const r5 = runGit(['-c', 'k=v', 'commit', '-n', '-m', 'test'], dir, shimEnv);
  assert('git -c k=v commit -n is blocked', r5.status !== 0 && r5.stderr.includes('wf: git commit --no-verify is blocked'), r5.stderr);
}

function assertPassthroughCommands(dir: string, shimEnv: NodeJS.ProcessEnv): void {
  const r6 = runGit(['commit', '-m', '-n is in the message'], dir, shimEnv);
  assert('commit -m "-n is in the message" is NOT blocked', r6.status === 0, r6.stderr);
  const r7 = runGit(['add', '-n', '.'], dir, shimEnv);
  assert('git add -n . passes through', r7.status === 0, r7.stderr);
  const { dir: logDir } = makeRepo();
  execSync('git commit -m "initial"', { cwd: logDir, env: shimEnv, stdio: 'pipe' });
  const r8 = runGit(['log', '-n', '1'], logDir, shimEnv);
  assert('git log -n 1 passes through', r8.status === 0, r8.stderr);
  fs.rmSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'file2.txt'), 'world');
  execSync('git add file2.txt', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' });
  const r9 = runGit(['commit', '-m', 'plain commit'], dir, shimEnv);
  assert('plain git commit succeeds with shim', r9.status === 0, r9.stderr);
}

function assertFallbackMode(shimEnv: NodeJS.ProcessEnv): void {
  const { dir: fallbackDir } = makeRepo();
  const shimEnvNoRealGit = { ...shimEnv };
  delete shimEnvNoRealGit['WF_REAL_GIT'];
  const r10 = runGit(['commit', '-m', 'fallback test'], fallbackDir, shimEnvNoRealGit);
  assert('plain git commit succeeds via PATH fallback (no WF_REAL_GIT)', r10.status === 0, r10.stderr);
  fs.rmSync(fallbackDir, { recursive: true });
}

async function main(): Promise<void> {
  const shimEnv = { ...process.env, ...buildGitShimEnvOverrides(process.env) };
  const { dir } = makeRepo();
  try {
    assertBlockedCommands(dir, shimEnv);
    assertPassthroughCommands(dir, shimEnv);
    assertFallbackMode(shimEnv);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
  summarise(counts);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
