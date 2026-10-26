/**
 * Manual Test: bump results before 1.0.0 match the rules documented in the README
 *
 * Run: nr test:manual release-pre-1-bump-rules.smoke
 *
 * Verifies, each in a fresh temp repo using the repo's .versionrc.json:
 *   1. 0.1.0 + feat commit -> 0.1.1
 *   2. 0.1.0 + BREAKING CHANGE footer -> 0.2.0 (not 1.0.0)
 *   3. 0.1.0 + fix commit -> 0.1.1
 *   4. 0.1.0-rc.2 + no flags -> 0.1.0
 *   5. 0.1.0-rc.2 + --prerelease rc -> 0.1.0-rc.3
 *   6. 0.1.0 + --release-as 1.0.0 -> 1.0.0
 *   7. the tag v<version> exists and equals package.json version in every case
 */
import { removeDir } from './support/sea-binary-harness';
import { createReleaseRepo, git, readPackageVersion, runReleaseTool } from './support/release-repo-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

type BumpCase = {
  name: string;
  startVersion: string;
  commits: string[];
  args: string[];
  expectedVersion: string;
};

const bumpCases: BumpCase[] = [
  { name: 'feat from 0.1.0 gives a patch', startVersion: '0.1.0', commits: ['feat: Add thing'], args: [], expectedVersion: '0.1.1' },
  {
    name: 'BREAKING CHANGE from 0.1.0 gives a minor',
    startVersion: '0.1.0',
    commits: ['feat: Add thing\n\nBREAKING CHANGE: Drops the old flag'],
    args: [],
    expectedVersion: '0.2.0',
  },
  { name: 'fix from 0.1.0 gives a patch', startVersion: '0.1.0', commits: ['fix: Correct thing'], args: [], expectedVersion: '0.1.1' },
  { name: 'plain release from 0.1.0-rc.2 promotes it', startVersion: '0.1.0-rc.2', commits: ['fix: Correct thing'], args: [], expectedVersion: '0.1.0' },
  {
    name: '--prerelease rc from 0.1.0-rc.2 gives rc.3',
    startVersion: '0.1.0-rc.2',
    commits: ['fix: Correct thing'],
    args: ['--prerelease', 'rc'],
    expectedVersion: '0.1.0-rc.3',
  },
  {
    name: '--release-as 1.0.0 from 0.1.0 gives 1.0.0',
    startVersion: '0.1.0',
    commits: ['feat: Add thing'],
    args: ['--release-as', '1.0.0'],
    expectedVersion: '1.0.0',
  },
];

const reportBumpCase = (bumpCase: BumpCase, repoDir: string): void => {
  const result = runReleaseTool(repoDir, bumpCase.args);
  const version = readPackageVersion(repoDir);
  const tags = git(repoDir, ['tag', '--list']).split('\n');
  if (result.exitCode === 0 && version === bumpCase.expectedVersion && tags.includes(`v${version}`)) {
    pass(`${bumpCase.name}: ${bumpCase.startVersion} -> ${version}`);
    return;
  }
  fail(`${bumpCase.name}: expected ${bumpCase.expectedVersion}, got ${version}`,
    `exit ${result.exitCode}, tags ${tags.join(',')}: ${result.output.slice(-300)}`);
};

const runBumpCase = (bumpCase: BumpCase): void => {
  const repoDir = createReleaseRepo({ startVersion: bumpCase.startVersion, commits: bumpCase.commits });
  try {
    reportBumpCase(bumpCase, repoDir);
  } finally {
    removeDir(repoDir);
  }
};

const main = (): void => {
  console.log('\n Release bump rules before 1.0.0\n');
  for (const bumpCase of bumpCases) runBumpCase(bumpCase);
  summarise(counts);
};

main();
