/**
 * Manual Test: issue:implement preflight checks
 *
 * Run: nr test:manual -- test-issue-implement-preflight
 *
 * Verifies:
 *   1. Exits with code 1 and prints fetch hint when ticket artifact is missing
 *   2. Exits with code 1 and prints plan hint when ticket exists but plan is missing
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;
const pass = (msg: string) => {
  console.log(`  ✓ ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string) => {
  console.error(`  ✗ ${msg}${detail ? `\n    → ${detail}` : ''}`);
  failed++;
};

function captureExit(): { restore: () => number } {
  let code = 0;
  const orig = process.exit.bind(process);
  (process.exit as any) = (c: number) => {
    code = c;
  };
  return {
    restore: () => {
      (process.exit as any) = orig;
      return code;
    },
  };
}

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

function overrideHomeDir(nextHomeDir: string): () => void {
  const previousHome = process.env.HOME;
  process.env.HOME = nextHomeDir;
  return () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
      return;
    }

    process.env.HOME = previousHome;
  };
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const command = app.get(IssueImplementCommand);

  // ── Test 1: ticket artifact missing ──────────────────────────────────────
  console.log('\n🧪 Test 1: missing ticket artifact\n' + '─'.repeat(60));
  {
    const exitCapture = captureExit();
    const errCapture = captureConsoleError();
    // WBP-9999 will not exist in .wf/ of the current working directory
    await command.run([], { ticketKey: 'WBP-9999' });
    const exitCode = exitCapture.restore();
    const errorOutput = errCapture.restore();

    if (exitCode === 1) {
      pass('Exits with code 1 when ticket artifact is missing');
    } else {
      fail('Did not exit with code 1', `exitCode: ${exitCode}`);
    }
    if (errorOutput.includes('issue:fetch')) {
      pass('Error output contains issue:fetch hint');
    } else {
      fail('Error output missing issue:fetch hint', errorOutput.slice(0, 300));
    }
  }

  // ── Test 2: ticket exists, plan missing ──────────────────────────────────
  console.log('\n🧪 Test 2: ticket exists, plan missing\n' + '─'.repeat(60));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-implement-test-'));
    const restoreHome = overrideHomeDir(tmpDir);
    const artifactDir = path.join(tmpDir, '.wf', path.basename(tmpDir), 'jira');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'WBP-1001.md'), '# WBP-1001\n');

    // Override process.cwd so resolveArtifactDir picks up our tmpDir
    const origCwd = process.cwd.bind(process);
    (process as any).cwd = () => tmpDir;

    const exitCapture = captureExit();
    const errCapture = captureConsoleError();
    await command.run([], { ticketKey: 'WBP-1001' });
    const exitCode = exitCapture.restore();
    const errorOutput = errCapture.restore();
    (process as any).cwd = origCwd;
    restoreHome();

    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (exitCode === 1) {
      pass('Exits with code 1 when plan artifact is missing');
    } else {
      fail('Did not exit with code 1', `exitCode: ${exitCode}`);
    }
    if (errorOutput.includes('issue:plan')) {
      pass('Error output contains issue:plan hint');
    } else {
      fail('Error output missing issue:plan hint', errorOutput.slice(0, 300));
    }
  }

  await app.close();

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✓ ${passed} passed   ✗ ${failed} failed`);
  if (failed === 0) console.log('✓ All tests passed!');
  console.log('━'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
