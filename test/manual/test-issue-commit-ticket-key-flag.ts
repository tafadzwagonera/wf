/**
 * Manual Test: issue:commit --ticket-key flag migration
 *
 * Run: nr test:manual -- test-issue-commit-ticket-key-flag
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
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

let passed = 0;
let failed = 0;
const pass = (msg: string) => {
  console.log(`  \u2713 ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string) => {
  console.error(`  \u2717 ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

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
  const match = flags.match(/--([a-z][-a-z]*)/);
  return match ? match[1] : flags;
};

async function main() {
  console.log('\n issue:commit --ticket-key flag migration\n');

  // Tests 1–2 & 4: CLI help output via dist/main.js
  const DIST_MAIN = path.join(__dirname, '../../dist/main.js');
  let help: string;
  try {
    help = execSync(`node ${DIST_MAIN} issue:commit --help`, {
      encoding: 'utf-8',
      cwd: os.tmpdir(),
    });
  } catch (err: any) {
    help = (err.stdout ?? '') + (err.stderr ?? '');
  }

  // Test 1: --help shows -k, --ticket-key
  console.log(' Test 1: --help shows -k, --ticket-key');
  if (help.includes('-k, --ticket-key')) {
    pass('issue:commit --help shows -k, --ticket-key');
  } else {
    fail('issue:commit --help does NOT show -k, --ticket-key', help.slice(0, 300));
  }

  // Test 2: --help no longer shows [ticket-key] positional
  console.log(' Test 2: --help no longer shows [ticket-key] positional');
  if (!help.includes('[ticket-key]')) {
    pass('issue:commit --help does not show [ticket-key] positional');
  } else {
    fail('issue:commit --help still shows [ticket-key] positional');
  }

  // Test 3: issue:commit accepts --ticket-key via NestJS options
  console.log(' Test 3: issue:commit accepts --ticket-key via NestJS options');
  {
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

  // Test 4: options in alphabetical order
  console.log(' Test 4: options are in alphabetical order');
  {
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

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
