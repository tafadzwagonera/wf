import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { summarise } from './support/reporter';
import {
  ANTHROPIC_MARKER, GOOGLE_MARKER, OPENAI_MARKER, assertLoaded, check, homeEnv, reporter, runCli, writeProviderConfig,
} from './support/repos-dir-harness';

const COMMAND = 'issue:commit --dry-run -r twin-repo';

function checkAppsBeatsProjects(fakeHome: string, cwd: string): void {
  const result = runCli(COMMAND, cwd, homeEnv(fakeHome, { WF_REPOS_DIR: undefined }));
  assertLoaded(result, 'Apps vs Projects', GOOGLE_MARKER);
  check(!result.stdout.includes(ANTHROPIC_MARKER), 'Apps vs Projects: Projects config not used', result.stdout);
}

function checkSiblingBeatsDefaults(fakeHome: string, workspace: string): void {
  const result = runCli(COMMAND, path.join(workspace, 'caller'), homeEnv(fakeHome, { WF_REPOS_DIR: undefined }));
  assertLoaded(result, 'sibling vs defaults', OPENAI_MARKER);
  check(!result.stdout.includes(GOOGLE_MARKER), 'sibling vs defaults: Apps config not used', result.stdout);
  check(!result.stdout.includes(ANTHROPIC_MARKER), 'sibling vs defaults: Projects config not used', result.stdout);
}

function runScenario(tempRoot: string): void {
  const fakeHome = path.join(tempRoot, 'home');
  const workspace = path.join(tempRoot, 'workspace');
  const unrelatedCwd = path.join(tempRoot, 'unrelated');
  writeProviderConfig(path.join(fakeHome, 'Apps', 'twin-repo'), 'google');
  writeProviderConfig(path.join(fakeHome, 'Projects', 'twin-repo'), 'anthropic');
  writeProviderConfig(path.join(workspace, 'twin-repo'), 'openai');
  fs.mkdirSync(path.join(workspace, 'caller'), { recursive: true });
  fs.mkdirSync(unrelatedCwd, { recursive: true });
  checkAppsBeatsProjects(fakeHome, unrelatedCwd);
  checkSiblingBeatsDefaults(fakeHome, workspace);
}

function main(): void {
  console.log('\nManual smoke test: default base order and sibling precedence\n');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repos-order-'));
  try {
    runScenario(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(reporter.counts);
}

main();
