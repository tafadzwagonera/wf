import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { summarise } from './support/reporter';
import {
  ANTHROPIC_MARKER, assertLoaded, check, homeEnv, reporter, runCli, writeProviderConfig,
} from './support/repos-dir-harness';

const searchedEntries = (stderr: string): string[] => stderr.split('\n').filter(line => line.startsWith('  - '));

function checkMissingRepo(env: NodeJS.ProcessEnv, cwd: string, reposDir: string): void {
  const result = runCli('issue:commit --dry-run -r acme/ghost-repo', cwd, env);
  check(result.exitCode !== 0, 'ghost long-form: exits non-zero', result.stderr);
  check(result.stderr.includes("Repository 'acme/ghost-repo' not found"), 'ghost long-form: not-found error', result.stderr);
  check(result.stderr.includes(path.join(reposDir, 'acme', 'ghost-repo')), 'ghost long-form: lists full token', result.stderr);
  check(result.stderr.includes(path.join(reposDir, 'ghost-repo')), 'ghost long-form: lists segment', result.stderr);
}

function checkAbsoluteMissing(env: NodeJS.ProcessEnv, cwd: string, reposDir: string): void {
  const result = runCli(`issue:commit --dry-run -r ${path.join(reposDir, 'ghost-repo')}`, cwd, env);
  const entries = searchedEntries(result.stderr);
  check(result.exitCode !== 0, 'ghost absolute: exits non-zero', result.stderr);
  check(entries.length === 1, 'ghost absolute: Searched list has one entry', result.stderr);
  check(entries[0] === `  - ${path.join(reposDir, 'ghost-repo')}`, 'ghost absolute: entry is the normalised path', result.stderr);
}

function runScenario(tempRoot: string): void {
  const reposDir = path.join(tempRoot, 'checkouts');
  const cwd = path.join(tempRoot, 'unrelated');
  const env = homeEnv(path.join(tempRoot, 'home'), { WF_REPOS_DIR: reposDir });
  const trailing = `${path.join(reposDir, 'target-repo')}/`;
  writeProviderConfig(path.join(reposDir, 'target-repo'), 'anthropic');
  fs.mkdirSync(cwd, { recursive: true });
  assertLoaded(runCli('issue:commit --dry-run -r acme/target-repo', cwd, env), 'long-form token', ANTHROPIC_MARKER);
  assertLoaded(runCli(`issue:commit --dry-run -r ${trailing}`, cwd, env), 'absolute with trailing slash', ANTHROPIC_MARKER);
  checkMissingRepo(env, cwd, reposDir);
  checkAbsoluteMissing(env, cwd, reposDir);
}

function main(): void {
  console.log('\nManual smoke test: workspace/repo segment and absolute-token normalisation\n');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repos-segment-'));
  try {
    runScenario(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(reporter.counts);
}

main();
