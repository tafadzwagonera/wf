import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createTempDir, projectRoot } from './sea-binary-harness';

export const releaseToolPath = path.join(projectRoot, 'node_modules', '.bin', 'commit-and-tag-version');
export const lefthookValidatorPath = path.join(projectRoot, '.lefthook', 'commit-msg', 'validate-conventional-commit.sh');

const versionrcPath = path.join(projectRoot, '.versionrc.json');

export type ReleaseRepoSpec = { startVersion: string; commits: string[] };
export type ReleaseRunResult = { exitCode: number | null; output: string };

export const git = (repoDir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const configureGit = (repoDir: string): void => {
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.name', 'Release Smoke']);
  git(repoDir, ['config', 'user.email', 'release-smoke@example.com']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  git(repoDir, ['config', 'tag.gpgsign', 'false']);
};

const commitInitialFiles = (repoDir: string, startVersion: string): void => {
  const packageJson = `${JSON.stringify({ name: 'tmp', version: startVersion }, null, 2)}\n`;
  fs.writeFileSync(path.join(repoDir, 'package.json'), packageJson);
  fs.copyFileSync(versionrcPath, path.join(repoDir, '.versionrc.json'));
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'chore: Initial commit']);
  git(repoDir, ['tag', `v${startVersion}`]);
};

export const createReleaseRepo = (spec: ReleaseRepoSpec): string => {
  const repoDir = createTempDir('release-repo-');
  configureGit(repoDir);
  commitInitialFiles(repoDir, spec.startVersion);
  for (const message of spec.commits) {
    git(repoDir, ['commit', '-q', '--allow-empty', '-m', message]);
  }
  return repoDir;
};

export const runReleaseTool = (repoDir: string, args: string[] = []): ReleaseRunResult => {
  const result = spawnSync(releaseToolPath, args, { cwd: repoDir, encoding: 'utf-8', timeout: 60_000 });
  return { exitCode: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
};

export const readPackageVersion = (repoDir: string): string =>
  (JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf-8')) as { version: string }).version;
