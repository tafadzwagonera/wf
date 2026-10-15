import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { summarise } from './support/reporter';
import {
  ANTHROPIC_MARKER, assertLoaded, check, countOccurrences, homeEnv, reporter, runCli, writeProviderConfig,
} from './support/repos-dir-harness';

const WARNING = 'WF_REPOS_DIR is set to a relative path';

function checkRelativeValue(tempRoot: string, value: string): void {
  const fakeHome = path.join(tempRoot, 'home');
  const unrelatedCwd = path.join(tempRoot, 'unrelated');
  writeProviderConfig(path.join(fakeHome, 'Projects', 'rel-repo'), 'anthropic');
  fs.mkdirSync(unrelatedCwd, { recursive: true });

  const result = runCli('issue:commit --dry-run -r rel-repo', unrelatedCwd, homeEnv(fakeHome, { WF_REPOS_DIR: value }));
  assertLoaded(result, `value '${value}'`, ANTHROPIC_MARKER);
  check(countOccurrences(result.stderr, WARNING) === 1, `value '${value}': warns exactly once`, result.stderr);
  check(result.stderr.includes(`('${value}')`), `value '${value}': warning names the raw value`, result.stderr);
}

function main(): void {
  console.log('\nManual smoke test: relative WF_REPOS_DIR warns once and falls back to defaults\n');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repos-relative-'));
  try {
    checkRelativeValue(tempRoot, 'relative/dir');
    checkRelativeValue(tempRoot, '~/checkouts');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(reporter.counts);
}

main();
