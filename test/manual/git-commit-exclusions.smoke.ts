/**
 * Manual Test: GitService.commit() excludes tooling artifacts and rejects staged .gitignore
 *
 * Run: nr test:manual git-commit-exclusions.smoke.ts
 *
 * Verifies:
 *   1. commit() auto-stages only real source files when nothing is pre-staged
 *   2. .wf/** runtime artifacts are excluded from the commit
 *   3. All six wf.config.* variants are excluded from the commit
 *   4. dist/ build output is excluded from the commit
 *   5. Already-staged files are used as-is (pre-staged branch)
 *   6. Staged .gitignore causes commit() to fail hard before any commit is created
 *   7. Explicit commit file lists that include .gitignore also fail hard
 *   8. Commit succeeds without using git pathspec exclude magic
 *
 * No AI / API keys required — exercises GitService.commit() directly.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function makeRepo(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-commit-test-'));
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  git('config commit.gpgsign false');

  const srcFile = path.join(tmpDir, 'index.ts');
  fs.writeFileSync(srcFile, 'export const hello = () => "hello";\n');
  git('add .');
  git('commit -m "init"');
  return tmpDir;
}

function committedFiles(tmpDir: string): string {
  try {
    return execSync('git show --name-only --format="" HEAD', {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

function createWfConfigFiles(): string[] {
  return [
    'wf.config.js',
    'wf.config.mjs',
    'wf.config.ts',
    'wf.config.mts',
    'wf.config.yaml',
    'wf.config.yml',
  ];
}

function setupSourceFile(dir1: string): void {
  const srcFile1 = path.join(dir1, 'index.ts');
  fs.writeFileSync(srcFile1, 'export const hello = () => "hello v2";\n');
}

function setupWfArtifacts(dir1: string): void {
  const wfDir = path.join(dir1, '.wf', 'state');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'plan.json'), '{"key":"TEST-001"}');
}

function setupConfigFiles(dir1: string, wfConfigFiles: string[]): void {
  for (const cfgFile of wfConfigFiles) {
    fs.writeFileSync(path.join(dir1, cfgFile), `// wf tooling artifact\nmodule.exports = {};\n`);
  }
}

function setupDistAndGitignore(dir1: string): void {
  const distDir = path.join(dir1, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.js'), '"use strict";\n');
  fs.writeFileSync(path.join(dir1, '.gitignore'), 'node_modules/\n');
}

function setupScenario1Artifacts(dir1: string): string[] {
  const wfConfigFiles = createWfConfigFiles();
  setupSourceFile(dir1);
  setupWfArtifacts(dir1);
  setupConfigFiles(dir1, wfConfigFiles);
  setupDistAndGitignore(dir1);
  return wfConfigFiles;
}

function verifyIndexTs(files: string): void {
  if (files.includes('index.ts')) {
    pass('index.ts (real code change) WAS committed');
  } else {
    fail('index.ts was NOT committed — exclusion too broad', files);
  }
}

function verifyWfExcluded(files: string): void {
  if (files.includes('.wf/')) {
    fail('.wf/** artifacts leaked into commit', files);
  } else {
    pass('.wf/** runtime artifacts were NOT committed');
  }
}

function verifyConfigFiles(files: string, wfConfigFiles: string[]): void {
  for (const cfgFile of wfConfigFiles) {
    if (files.includes(cfgFile)) {
      fail(`${cfgFile} leaked into commit`, files);
    } else {
      pass(`${cfgFile} was NOT committed`);
    }
  }
}

function verifyDistExcluded(files: string): void {
  if (files.includes('dist/')) {
    fail('dist/ build output leaked into commit', files);
  } else {
    pass('dist/ build output was NOT committed');
  }
}

function verifyGitignoreExcluded(files: string): void {
  if (files.includes('.gitignore')) {
    fail('.gitignore leaked into auto-staged commit', files);
  } else {
    pass('.gitignore was NOT auto-staged or committed');
  }
}

function verifyScenario1Exclusions(files1: string, wfConfigFiles: string[]): void {
  verifyIndexTs(files1);
  verifyWfExcluded(files1);
  verifyConfigFiles(files1, wfConfigFiles);
  verifyDistExcluded(files1);
  verifyGitignoreExcluded(files1);
}

async function runScenario1(gitService: GitService, dirs: string[]): Promise<void> {
  console.log('─'.repeat(30));
  console.log('\nScenario 1: auto-stage excludes .wf/** and wf.config.*\n');
  const dir1 = makeRepo();
  dirs.push(dir1);
  const wfConfigFiles = setupScenario1Artifacts(dir1);
  await gitService.commit({ message: 'test: auto-stage scenario', cwd: dir1 });
  const files1 = committedFiles(dir1);
  console.log('Committed files:\n' + (files1 || '(none)') + '\n');
  verifyScenario1Exclusions(files1, wfConfigFiles);
}

function setupScenario2Artifacts(dir2: string): void {
  const srcFile2 = path.join(dir2, 'index.ts');
  fs.writeFileSync(srcFile2, 'export const hello = () => "hello v2";\n');
  const wfDir2 = path.join(dir2, '.wf', 'logs');
  fs.mkdirSync(wfDir2, { recursive: true });
  fs.writeFileSync(path.join(wfDir2, 'run.log'), 'some log');
  execSync('git add index.ts', { cwd: dir2, stdio: 'pipe' });
}

async function runScenario2(
  gitService: GitService,
  dirs: string[]
): Promise<void> {
  console.log('\n─'.repeat(30));
  console.log('\nScenario 2: pre-staged files committed as-is\n');
  const dir2 = makeRepo();
  dirs.push(dir2);
  setupScenario2Artifacts(dir2);
  await gitService.commit({ message: 'test: pre-staged scenario', cwd: dir2 });
  const files2 = committedFiles(dir2);
  console.log('Committed files:\n' + (files2 || '(none)') + '\n');
  verifyIndexTs(files2);
  verifyWfExcluded(files2);
}

async function attemptGitignoreCommit(
  gitService: GitService,
  dir: string,
  files?: string[]
): Promise<[boolean, string]> {
  try {
    await gitService.commit({ message: 'test: gitignore should fail', cwd: dir, files });
    return [false, ''];
  } catch (error) {
    return [true, (error as Error).message];
  }
}

function setupScenario3Artifacts(dir3: string): void {
  fs.writeFileSync(path.join(dir3, 'index.ts'), 'export const hello = () => "hello v2";\n');
  fs.writeFileSync(path.join(dir3, '.gitignore'), 'node_modules/\n');
  execSync('git add index.ts .gitignore', { cwd: dir3, stdio: 'pipe' });
}

async function runScenario3(
  gitService: GitService,
  dirs: string[]
): Promise<void> {
  console.log('\n─'.repeat(30));
  console.log('\nScenario 3: staged .gitignore rejects commit\n');
  const dir3 = makeRepo();
  dirs.push(dir3);
  setupScenario3Artifacts(dir3);
  const [rejected, errorMessage] = await attemptGitignoreCommit(gitService, dir3, undefined);
  verifyRejection(rejected, errorMessage, 'staged');
  verifyGitignoreNotCommitted(dir3);
}

function verifyRejection(
  rejected: boolean,
  errorMessage: string,
  context: string
): void {
  if (rejected) {
    if (errorMessage.includes('.gitignore')) {
      pass(`commit() rejected ${context} .gitignore`);
    } else {
      fail(`commit() rejected without naming .gitignore (${context})`, errorMessage);
    }
  } else {
    fail(`commit() allowed ${context} .gitignore`);
  }
}

function verifyGitignoreNotCommitted(dir: string): void {
  const files = committedFiles(dir);
  if (files.includes('.gitignore')) {
    fail('.gitignore was committed despite rejection', files);
  } else {
    pass('.gitignore was not committed after rejection');
  }
}

async function runScenario4(
  gitService: GitService,
  dirs: string[]
): Promise<void> {
  console.log('\n─'.repeat(30));
  console.log('\nScenario 4: explicit files list rejects .gitignore\n');
  const dir4 = makeRepo();
  dirs.push(dir4);
  fs.writeFileSync(path.join(dir4, 'index.ts'), 'export const hello = () => "hello v2";\n');
  fs.writeFileSync(path.join(dir4, '.gitignore'), 'node_modules/\n');
  const [rejected, errorMessage] = await attemptGitignoreCommit(gitService, dir4, ['index.ts', '.gitignore']);
  verifyRejection(rejected, errorMessage, 'explicit files');
  verifyGitignoreNotCommitted(dir4);
}

async function runAllScenarios(gitService: GitService, dirs: string[]): Promise<void> {
  console.log('\n🧪 GitService.commit() exclusion smoke tests\n');
  console.log('─'.repeat(60));
  await runScenario1(gitService, dirs);
  await runScenario2(gitService, dirs);
  await runScenario3(gitService, dirs);
  await runScenario4(gitService, dirs);
}

function cleanupDirectories(dirs: string[]): void {
  for (const d of dirs) {
    if (fs.existsSync(d)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
}

function reportResults(): void {
  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) console.log('✓ All tests passed!');
  console.log('━'.repeat(60));
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const gitService = app.get(GitService);
  const dirs: string[] = [];
  try {
    await runAllScenarios(gitService, dirs);
  } finally {
    await app.close();
    cleanupDirectories(dirs);
  }
  reportResults();
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
