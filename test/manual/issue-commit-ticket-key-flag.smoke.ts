/**
 * Manual Test: issue:commit --ticket-key flag migration
 *
 * Run: nr test:manual issue-commit-ticket-key-flag.smoke.ts
 *
 * Verifies:
 *   1. issue:commit --help shows -k, --ticket-key
 *   2. issue:commit --help no longer shows a [ticket-key] positional argument
 *   3. issue:commit accepts --ticket-key via the NestJS options object
 *   4. issue:commit --help options are in alphabetical order by long flag name
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommitCommand } from '../../src/commands/issue-commit.command';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function captureConsoleError(): { restore: () => string } {
  let out = '';
  const orig = console.error.bind(console);
  (console.error as any) = (...args: any[]) => {
    out += args.join(' ') + '\n';
  };
  return {
    restore: () => {
      (console.error as any) = orig;
      return out;
    },
  };
}

function suppressConsoleLog(): { restore: () => void } {
  const origLog = console.log.bind(console);
  (console.log as any) = () => {};
  return {
    restore: () => {
      (console.log as any) = origLog;
    },
  };
}

const extractLongFlag = (flags: string): string => {
  const match = /--([a-z][-a-z]*)/.exec(flags);
  return match ? match[1] : flags;
};

function getHelpOutput(): string {
  const DIST_MAIN = path.join(__dirname, '../../dist/main.js');
  try {
    return execSync(`node ${DIST_MAIN} issue:commit --help`, { encoding: 'utf-8', cwd: os.tmpdir() });
  } catch (err: any) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

function checkHelpShowsTicketKeyFlag(help: string): void {
  if (help.includes('-k, --ticket-key')) {
    pass('issue:commit --help shows -k, --ticket-key');
  } else {
    fail('issue:commit --help does NOT show -k, --ticket-key', help.slice(0, 300));
  }
}

function checkHelpShowsConventionalFlag(help: string): void {
  if (help.includes('-c, --conventional')) {
    pass('issue:commit --help shows -c, --conventional');
  } else {
    fail('issue:commit --help does NOT show -c, --conventional', help.slice(0, 300));
  }
}

function checkHelpHasNoPositional(help: string): void {
  if (!help.includes('[ticket-key]')) {
    pass('issue:commit --help does not show [ticket-key] positional');
  } else {
    fail('issue:commit --help still shows [ticket-key] positional');
  }
}

async function checkTicketKeyAccepted(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const commitCmd = app.get(IssueCommitCommand);
  const errCap = captureConsoleError();
  const logCap = suppressConsoleLog();
  await commitCmd.run([], { ticketKey: 'WBP-9999', dryRun: true });
  const err = errCap.restore();
  logCap.restore();
  if (!err.includes('Error') && !err.includes('error')) {
    pass('Dry-run with --ticket-key accepted without errors');
  } else {
    fail('Dry-run with --ticket-key produced an error', err.slice(0, 200));
  }
  await app.close();
}

function checkOptionsAlphabetical(help: string): void {
  const optionRegex = /^\s+(-\w,\s+)?--([a-z][-a-z]*)/gm;
  const flags: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = optionRegex.exec(help)) !== null) {
    flags.push(m[2]);
  }
  const sorted = [...flags].sort();
  if (JSON.stringify(flags) === JSON.stringify(sorted)) {
    pass(`Options alphabetically ordered: [${flags.join(', ')}]`);
  } else {
    fail(`Options not alphabetical: got [${flags.join(', ')}], expected [${sorted.join(', ')}]`);
  }
}

async function main(): Promise<void> {
  console.log('\n issue:commit --ticket-key flag migration\n');
  // Tests 1–2 & 4: CLI help output via dist/main.js
  console.log(' Test 1: --help shows -k, --ticket-key');
  const help = getHelpOutput();
  checkHelpShowsTicketKeyFlag(help);
  checkHelpShowsConventionalFlag(help);
  console.log(' Test 2: --help no longer shows [ticket-key] positional');
  checkHelpHasNoPositional(help);
  // Test 3: issue:commit accepts --ticket-key via NestJS options
  console.log(' Test 3: issue:commit accepts --ticket-key via NestJS options');
  await checkTicketKeyAccepted();
  // Test 4: options in alphabetical order
  console.log(' Test 4: options are in alphabetical order');
  checkOptionsAlphabetical(help);
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
