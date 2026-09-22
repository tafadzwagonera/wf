/**
 * Manual smoke test: wf issue:commit without --conventional produces an
 * unscoped, type-free description
 *
 * Run: nr test:manual issue-commit-freeform-vs-conventional.smoke.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { CommitStageService } from '../../src/workflows/stages/commit-stage.service';
import { GitService } from '../../src/integrations/git/git.service';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const CONVENTIONAL_TYPE_PATTERN = /^(?:[A-Z][A-Z0-9]*-\d+:\s*)?[a-z]+(?:\([^)]+\))?:/;

const { counts, pass, fail } = createReporter();

function setupGitCommand(tmpDir: string): (cmd: string) => void {
  return (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  };
}

function setupTmpRepo(tmpDir: string): void {
  const git = setupGitCommand(tmpDir);
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  fs.writeFileSync(path.join(tmpDir, 'auth.ts'), 'export const login = () => true;\n');
  git('add .');
  git('commit -m init');
}

async function runCaseA(
  gitService: GitService,
  commitStageService: CommitStageService,
  tmpDir: string,
): Promise<string> {
  const git = setupGitCommand(tmpDir);
  // Case A: no conventional flag — expect an unscoped, type-free description
  fs.writeFileSync(
    path.join(tmpDir, 'auth.ts'),
    'export const login = (token: string) => {\n  if (!token) throw new Error("missing token");\n  return true;\n};\n'
  );
  git('add .');
  const diffA = await gitService.getDiff(true, tmpDir);
  return commitStageService.generateCommitMessage({ diff: diffA, ticketKey: 'WBP-9999', conventional: false });
}

async function runCaseB(
  gitService: GitService,
  commitStageService: CommitStageService,
  tmpDir: string,
): Promise<string> {
  const git = setupGitCommand(tmpDir);
  // Case B: same shape of change, now with conventional: true — expect a type(scope): prefix
  fs.writeFileSync(
    path.join(tmpDir, 'auth.ts'),
    'export const login = (token: string) => {\n  if (!token) throw new Error("missing token");\n'
    + '  if (token.length < 8) throw new Error("token too short");\n  return true;\n};\n'
  );
  git('add .');
  const diffB = await gitService.getDiff(true, tmpDir);
  return commitStageService.generateCommitMessage({ diff: diffB, ticketKey: 'WBP-9998', conventional: true });
}

function checkFreeformHasNoConventionalType(message: string): void {
  const withoutTicket = message.replace(/^WBP-9999:\s*/, '');
  if (CONVENTIONAL_TYPE_PATTERN.test(withoutTicket)) {
    fail('freeform message unexpectedly contains a conventional type prefix', message);
  } else {
    pass(`freeform message has no conventional type prefix: "${message}"`);
  }
}

function checkFreeformHasTicketKeyPrefix(message: string): void {
  if (message.startsWith('WBP-9999:')) {
    pass('freeform message is prefixed with the ticket key exactly once');
  } else {
    fail('freeform message missing ticket key prefix', message);
  }
}

function checkConventionalHasTypePrefix(message: string): void {
  const withoutTicket = message.replace(/^WBP-9998:\s*/, '');
  if (CONVENTIONAL_TYPE_PATTERN.test(withoutTicket)) {
    pass(`conventional=true message has a type prefix: "${message}"`);
  } else {
    fail('conventional=true message is missing a conventional type prefix', message);
  }
}

async function runAllChecks(
  gitService: GitService,
  commitStageService: CommitStageService,
  tmpDir: string,
): Promise<void> {
  setupTmpRepo(tmpDir);
  const freeformMessage = await runCaseA(gitService, commitStageService, tmpDir);
  checkFreeformHasNoConventionalType(freeformMessage);
  checkFreeformHasTicketKeyPrefix(freeformMessage);
  const conventionalMessage = await runCaseB(gitService, commitStageService, tmpDir);
  checkConventionalHasTypePrefix(conventionalMessage);
}

async function main(): Promise<void> {
  console.log('\nManual smoke test: issue:commit freeform vs conventional message format\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-freeform-commit-'));
  try {
    await runAllChecks(app.get(GitService), app.get(CommitStageService), tmpDir);
  } finally {
    await app.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
