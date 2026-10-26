/**
 * Manual Test: the release commit passes the repo's lefthook commit-msg validator
 *
 * Run: nr test:manual release-commit-message-lefthook.smoke
 *
 * Verifies:
 *   1. commit-and-tag-version exits 0 and the release commit subject is "chore(release): Set version to 0.1.1"
 *   2. that subject passes .lefthook/commit-msg/validate-conventional-commit.sh
 *   3. tag v0.1.1 exists and package.json version is 0.1.1
 *   4. no CHANGELOG.md is created (skip.changelog is honoured)
 *   5. a "feat!: Add thing" subject is rejected by the validator
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempDir, removeDir } from './support/sea-binary-harness';
import {
  createReleaseRepo, git, lefthookValidatorPath, readPackageVersion, runReleaseTool,
} from './support/release-repo-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const check = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

const expectedSubject = 'chore(release): Set version to 0.1.1';

const validatorExitCode = (workDir: string, subject: string): number | null => {
  const messageFile = path.join(workDir, 'COMMIT_EDITMSG');
  fs.writeFileSync(messageFile, `${subject}\n`);
  return spawnSync('sh', [lefthookValidatorPath, messageFile], { encoding: 'utf-8' }).status;
};

const checkReleaseCommit = (repoDir: string, validatorDir: string): void => {
  const result = runReleaseTool(repoDir);
  const subject = git(repoDir, ['log', '-1', '--format=%s']);
  check(result.exitCode === 0 && subject === expectedSubject,
    `release commit subject is "${expectedSubject}"`, `exit ${result.exitCode}, subject "${subject}": ${result.output.slice(-300)}`);
  const validatorStatus = validatorExitCode(validatorDir, subject);
  check(validatorStatus === 0, 'release commit subject passes the lefthook validator', `validator exit ${validatorStatus}`);
  const tags = git(repoDir, ['tag', '--list']).split('\n');
  check(tags.includes('v0.1.1') && readPackageVersion(repoDir) === '0.1.1',
    'tag v0.1.1 exists and package.json is 0.1.1', `tags ${tags.join(',')}, version ${readPackageVersion(repoDir)}`);
  check(!fs.existsSync(path.join(repoDir, 'CHANGELOG.md')), 'no CHANGELOG.md is created');
};

const checkBangSubjectRejected = (validatorDir: string): void => {
  const status = validatorExitCode(validatorDir, 'feat!: Add thing');
  check(status === 1, 'validator rejects "feat!: Add thing"', `validator exit ${status}`);
};

const main = (): void => {
  console.log('\n Release commit message vs lefthook validator\n');
  const repoDir = createReleaseRepo({ startVersion: '0.1.0', commits: ['feat: Add thing'] });
  const validatorDir = createTempDir('release-validator-');
  try {
    checkReleaseCommit(repoDir, validatorDir);
    checkBangSubjectRejected(validatorDir);
  } finally {
    removeDir(repoDir);
    removeDir(validatorDir);
  }
  summarise(counts);
};

main();
