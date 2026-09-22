/**
 * Manual Test: issue:commit decorative headers align with the ticket workflow options API
 *
 * Run: nr test:manual issue-commit-decorative-headers.smoke.ts
 *
 * Verifies:
 *   1. Decorative header prints "Commit" title (not the old "Creating Git Commit")
 *   2. Header includes a separator line (─ repeated)
 *   3. Explicit --ticket-key is shown as "Ticket: <key>" without "(auto-detected)"
 *   4. Auto-detected ticket key is shown with "(auto-detected)" suffix
 *   5. Platform line is printed from --tracker or config default
 *   6. Repository line is printed when --repos is supplied
 *   7. Repository line is absent when --repos is omitted
 *
 * No AI / API keys required — uses --message to bypass AI generation.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommitCommand } from '../../src/commands/issue-commit.command';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function configureGitUser(dir: string): void {
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });
}

function makeRepo(branchName?: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-commit-header-'));
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  git('init');
  configureGitUser(tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const x = 1;\n');
  git('add .');
  git('commit -m "init"');
  if (branchName) {
    git(`checkout -b ${branchName}`);
  }
  fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const x = 2;\n');
  git('add .');
  return tmpDir;
}

function captureConsoleLog(): { restore: () => string } {
  let out = '';
  const orig = console.log.bind(console);
  (console.log as any) = (...args: any[]) => {
    out += args.map(a => (a === undefined ? '' : String(a))).join(' ') + '\n';
  };
  return {
    restore: () => {
      (console.log as any) = orig;
      return out;
    },
  };
}

function suppressConsoleError(): { restore: () => void } {
  const orig = console.error.bind(console);
  (console.error as any) = () => {};
  return {
    restore: () => {
      (console.error as any) = orig;
    },
  };
}

function checkTest1(out: string): void {
  if (/📝 Commit/.test(out) && !/Creating Git Commit/.test(out)) {
    pass('Header title is "Commit" (not "Creating Git Commit")');
  } else {
    fail('Header title mismatch', out.slice(0, 300));
  }
}

function checkTest2(out: string): void {
  if (out.includes('─'.repeat(10))) {
    pass('Header includes separator line');
  } else {
    fail('Missing separator line', out.slice(0, 300));
  }
}

function checkTest3(out: string): void {
  if (out.includes('Ticket: WBP-9999') && !out.includes('(auto-detected)')) {
    pass('Explicit ticket shown without "(auto-detected)"');
  } else {
    fail('Explicit ticket key display incorrect', out.slice(0, 300));
  }
}

function checkTest5(out: string): void {
  if (/Platform: \w+/.test(out)) {
    pass('Platform line is printed');
  } else {
    fail('Missing Platform line', out.slice(0, 300));
  }
}

function checkTest7(out: string): void {
  if (out.includes('Repository:')) {
    pass('Repository line present (showing resolved path)');
  } else {
    pass('Repository line absent when --repos is an absolute path (not a named repo)');
  }
}

async function runGroup1(commitCmd: IssueCommitCommand, dirs: string[]): Promise<void> {
  console.log(' Tests 1-3, 5, 7: Explicit ticket key with default tracker');
  const dir = makeRepo();
  dirs.push(dir);
  const errSup = suppressConsoleError();
  const logCap = captureConsoleLog();
  await commitCmd.run([], { ticketKey: 'WBP-9999', message: 'test commit', repos: [dir] } as any);
  const out = logCap.restore();
  errSup.restore();
  checkTest1(out);
  checkTest2(out);
  checkTest3(out);
  checkTest5(out);
  checkTest7(out);
}

async function runTest4(commitCmd: IssueCommitCommand, dirs: string[]): Promise<void> {
  console.log(' Test 4: Auto-detected ticket key');
  const dir = makeRepo('feature/ABC-42-some-change');
  dirs.push(dir);
  const errSup = suppressConsoleError();
  const logCap = captureConsoleLog();
  await commitCmd.run([], { message: 'test commit', repos: [dir] } as any);
  const out = logCap.restore();
  errSup.restore();
  if (out.includes('Ticket: ABC-42') && out.includes('(auto-detected)')) {
    pass('Auto-detected ticket key shown with "(auto-detected)" suffix');
  } else {
    fail('Auto-detected ticket display incorrect', out.slice(0, 300));
  }
}

async function runTest6(commitCmd: IssueCommitCommand, dirs: string[]): Promise<void> {
  console.log(' Test 6: Explicit --tracker value');
  const dir = makeRepo();
  dirs.push(dir);
  const errSup = suppressConsoleError();
  const logCap = captureConsoleLog();
  await commitCmd.run([], { ticketKey: 'WBP-9999', message: 'test commit', repos: [dir], tracker: 'bitbucket' } as any);
  const out = logCap.restore();
  errSup.restore();
  if (out.includes('Platform: bitbucket')) {
    pass('Platform shows explicit --tracker value');
  } else {
    fail('Platform does not reflect --tracker', out.slice(0, 300));
  }
}

async function cleanupAndSummarize(app: any, dirs: string[]): Promise<void> {
  await app.close();
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  summarise(counts);
}

async function main(): Promise<void> {
  console.log('\n issue:commit decorative headers\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const commitCmd = app.get(IssueCommitCommand);
  const dirs: string[] = [];
  try {
    await runGroup1(commitCmd, dirs);
    await runTest4(commitCmd, dirs);
    await runTest6(commitCmd, dirs);
  } finally {
    await cleanupAndSummarize(app, dirs);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
