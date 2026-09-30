/**
 * Manual smoke test: quality-checks.sh bypasses itself under WF_MANAGED_SESSION
 *
 * Run: nr test:manual quality-checks-hook-bypass-live.smoke
 *
 * Scenario: quality-checks.sh gates interactive (UI) sessions only — a
 * wf-managed headless run must never be blocked by it, because wf's own
 * verification loop owns lint/test resolution there. The runners stamping
 * WF_MANAGED_SESSION=1 onto spawned CLI children is already covered by
 * jest unit tests (codex-cli-runner.spec.ts, claude-cli-runner.spec.ts) via
 * mocked spawn assertions — no live process is needed to prove that. What
 * unit tests cannot prove is the actual bash script's behavior, so this
 * test runs the real quality-checks.sh as a subprocess.
 *
 * Config under test: none — this runs the raw shell script directly, not
 * the wf.config.ts pipeline.
 *
 * Verify:
 *   1. Running quality-checks.sh inside a temp git repo with a staged
 *      eslint violation, with WF_MANAGED_SESSION=1 in env, exits 0 and
 *      prints nothing to stdout.
 *   2. The same run with WF_MANAGED_SESSION unset exits with a JSON
 *      decision: "block" on stdout naming the lint failure.
 *
 * Wire up: create a temp git repo with a minimal package.json, eslint
 * config, and one committed clean file, then stage a second file with an
 * obvious max-lines-per-function violation. Copy the real quality-checks.sh
 * into that repo root and invoke it via bash with/without the env var.
 * Teardown: remove the temp repo directory.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';

const projectRoot = path.resolve(__dirname, '../..');
const qualityChecksSource = path.join(projectRoot, 'quality-checks.sh');

const { counts, pass, fail } = createReporter();

const buildLintViolatingFile = (): string => {
  const lines = ['export const overLong = (): number => {'];
  for (let i = 0; i < 20; i++) lines.push(`  const x${i} = ${i};`);
  lines.push('  return 0;', '};', '');
  return lines.join('\n');
};

const buildEslintConfig = (): string => [
  'module.exports = [',
  '  { rules: { "max-lines-per-function": ["warn", { max: 5 }] } },',
  '];',
  '',
].join('\n');

const buildPackageJson = (): string => JSON.stringify({
  name: 'quality-checks-smoke-repo',
  version: '1.0.0',
  scripts: {},
}, null, 2);

const initHookRepoGit = (repoDir: string): void => {
  spawnSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
};

const writeHookRepoFiles = (repoDir: string): void => {
  fs.writeFileSync(path.join(repoDir, 'package.json'), buildPackageJson(), 'utf-8');
  fs.writeFileSync(path.join(repoDir, 'eslint.config.js'), buildEslintConfig(), 'utf-8');
  fs.writeFileSync(path.join(repoDir, 'yarn.lock'), '', 'utf-8');
};

const setupHookRepo = (tempRoot: string): string => {
  const repoDir = path.join(tempRoot, 'hook-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  initHookRepoGit(repoDir);
  writeHookRepoFiles(repoDir);
  spawnSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoDir, 'violation.js'), buildLintViolatingFile(), 'utf-8');
  spawnSync('git', ['add', 'violation.js'], { cwd: repoDir, stdio: 'pipe' });
  fs.copyFileSync(qualityChecksSource, path.join(repoDir, 'quality-checks.sh'));
  fs.chmodSync(path.join(repoDir, 'quality-checks.sh'), 0o755);
  return repoDir;
};

const runHook = (repoDir: string, managed: boolean): { status: number | null; stdout: string } => {
  const env = { ...process.env, PATH: process.env['PATH'] ?? '' };
  if (managed) env['WF_MANAGED_SESSION'] = '1';
  else delete env['WF_MANAGED_SESSION'];
  const result = spawnSync('bash', ['./quality-checks.sh'], {
    cwd: repoDir, env, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 10,
  });
  return { status: result.status, stdout: (result.stdout ?? '').trim() };
};

const verifyHookBypassedWhenManaged = (repoDir: string): void => {
  const result = runHook(repoDir, true);
  if (result.status === 0 && result.stdout === '') {
    pass('quality-checks.sh exits 0 with no output when WF_MANAGED_SESSION=1');
    return;
  }
  fail('quality-checks.sh did not bypass under WF_MANAGED_SESSION=1', `status=${result.status} stdout=${result.stdout}`);
};

const verifyHookBlocksWhenNotManaged = (repoDir: string): void => {
  const result = runHook(repoDir, false);
  const isBlocked = result.stdout.includes('"decision": "block"') && result.stdout.includes('lint failed');
  if (isBlocked) {
    pass('quality-checks.sh emits a block decision naming the lint failure when WF_MANAGED_SESSION is unset');
    return;
  }
  fail('quality-checks.sh did not emit a block decision as expected', `status=${result.status} stdout=${result.stdout}`);
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  quality-checks.sh WF_MANAGED_SESSION bypass — live smoke test\n'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-hook-bypass-'));
  try {
    const repoDir = setupHookRepo(tempRoot);
    verifyHookBypassedWhenManaged(repoDir);
    verifyHookBlocksWhenNotManaged(repoDir);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
