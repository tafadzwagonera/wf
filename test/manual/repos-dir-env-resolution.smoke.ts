import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { summarise } from './support/reporter';
import {
  ANTHROPIC_MARKER, GOOGLE_MARKER, assertLoaded, baseEnv, check, reporter, runCli, writeProviderConfig,
} from './support/repos-dir-harness';

function checkReposDirEnv(tempRoot: string): void {
  const reposDir = path.join(tempRoot, 'checkouts');
  const unrelatedCwd = path.join(tempRoot, 'unrelated');
  writeProviderConfig(path.join(reposDir, 'target-repo'), 'anthropic');
  fs.mkdirSync(unrelatedCwd, { recursive: true });

  const result = runCli('issue:commit --dry-run -r target-repo', unrelatedCwd, baseEnv({ WF_REPOS_DIR: reposDir }));
  assertLoaded(result, 'unrelated cwd + WF_REPOS_DIR', ANTHROPIC_MARKER);
}

function checkSiblingCollision(tempRoot: string): void {
  const reposDir = path.join(tempRoot, 'collision-checkouts');
  const workspace = path.join(tempRoot, 'workspace');
  const callerDir = path.join(workspace, 'caller');
  writeProviderConfig(path.join(reposDir, 'shared-name'), 'anthropic');
  writeProviderConfig(path.join(workspace, 'shared-name'), 'google');
  fs.mkdirSync(callerDir, { recursive: true });

  const result = runCli('issue:commit --dry-run -r shared-name', callerDir, baseEnv({ WF_REPOS_DIR: reposDir }));
  assertLoaded(result, 'sibling vs WF_REPOS_DIR', GOOGLE_MARKER);
  check(!result.stdout.includes(ANTHROPIC_MARKER), 'sibling vs WF_REPOS_DIR: repos-dir config not used', result.stdout);
}

function main(): void {
  console.log('\nManual smoke test: WF_REPOS_DIR resolves repos and loses to a sibling\n');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repos-dir-env-'));
  try {
    checkReposDirEnv(tempRoot);
    checkSiblingCollision(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(reporter.counts);
}

main();
