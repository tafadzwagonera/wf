/**
 * Manual Test: issue:implement custom plan path resolution
 *
 * Run: nr test:manual -- test-issue-implement-plan-resolution
 *
 * Verifies:
 *   1. Bare filename (e.g. plan.json) resolves to ~/.wf/<app>/<platform>/plan.json
 *   2. Relative path (e.g. subdir/plan.json) resolves from the app root
 *   3. Bare filename with --repos resolves to ~/.wf/<repo>/<platform>/plan.json
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

function captureStdout(): { restore: () => string } {
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any) => {
    out += String(chunk);
    return true;
  };
  return {
    restore: () => {
      process.stdout.write = orig;
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

const minimalPlan = JSON.stringify({
  action: 'feature',
  steps: [],
  affectedFiles: [],
  repositoriesAffected: [],
});

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const command = app.get(IssueImplementCommand);

  // ── Test 1: bare filename → ~/.wf/<app>/<platform>/<filename> ───────────
  console.log('\n🧪 Test 1: bare filename resolves to artifact dir\n' + '─'.repeat(60));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-resolution-'));
    const restoreHome = overrideHomeDir(tmpDir);
    const artifactDir = path.join(tmpDir, '.wf', path.basename(tmpDir), 'jira');
    fs.mkdirSync(artifactDir, { recursive: true });
    const expectedPath = path.join(artifactDir, 'my-plan.json');
    fs.writeFileSync(expectedPath, minimalPlan);

    const origCwd = process.cwd.bind(process);
    (process as any).cwd = () => tmpDir;

    const stdoutCapture = captureStdout();
    await command.run(['my-plan.json'], { tracker: 'jira', dryRun: true });
    const output = stdoutCapture.restore();

    (process as any).cwd = origCwd;
    restoreHome();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (output.includes(expectedPath)) {
      pass(`Dry-run output references artifact path: ${expectedPath}`);
    } else {
      fail(
        'Dry-run output does not contain expected artifact path',
        `expected: ${expectedPath}\noutput snippet: ${output.slice(0, 400)}`
      );
    }
  }

  // ── Test 2: relative path → resolved from app root ───────────────────────
  console.log('\n🧪 Test 2: relative path resolves from app root\n' + '─'.repeat(60));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-resolution-'));
    const restoreHome = overrideHomeDir(tmpDir);
    const subDir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(subDir, { recursive: true });
    const expectedPath = path.resolve(tmpDir, 'subdir', 'my-plan.json');
    fs.writeFileSync(expectedPath, minimalPlan);

    const origCwd = process.cwd.bind(process);
    (process as any).cwd = () => tmpDir;

    const stdoutCapture = captureStdout();
    await command.run(['subdir/my-plan.json'], { dryRun: true });
    const output = stdoutCapture.restore();

    (process as any).cwd = origCwd;
    restoreHome();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (output.includes(expectedPath)) {
      pass(`Dry-run output references resolved path: ${expectedPath}`);
    } else {
      fail(
        'Dry-run output does not contain expected resolved path',
        `expected: ${expectedPath}\noutput snippet: ${output.slice(0, 400)}`
      );
    }
  }

  // ── Test 3: bare filename + --repos → repo namespace under ~/.wf ────────
  console.log('\n🧪 Test 3: bare filename with --repos resolves to repo artifact dir\n' + '─'.repeat(60));
  {
    // Simulate a sibling repo directory: <tmp>/myapp/ (cwd) and <tmp>/bar/ (repo)
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-repos-'));
    const restoreHome = overrideHomeDir(tmpBase);
    const appDir = path.join(tmpBase, 'myapp');
    const repoDir = path.join(tmpBase, 'bar');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    const artifactDir = path.join(tmpBase, '.wf', 'bar', 'jira');
    fs.mkdirSync(artifactDir, { recursive: true });
    const expectedPath = path.join(artifactDir, 'bar-plan-fix.json');
    fs.writeFileSync(expectedPath, minimalPlan);

    const origCwd = process.cwd.bind(process);
    (process as any).cwd = () => appDir;

    const stdoutCapture = captureStdout();
    await command.run(['bar-plan-fix.json'], {
      tracker: 'jira',
      repos: ['bar'],
      dryRun: true,
    });
    const output = stdoutCapture.restore();

    (process as any).cwd = origCwd;
    restoreHome();
    fs.rmSync(tmpBase, { recursive: true, force: true });

    if (output.includes(expectedPath)) {
      pass(`Dry-run output references repo artifact path: ${expectedPath}`);
    } else {
      fail(
        'Dry-run output does not contain expected repo artifact path',
        `expected: ${expectedPath}\noutput snippet: ${output.slice(0, 400)}`
      );
    }
  }

  await app.close();

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) console.log('✅ All tests passed!');
  console.log('━'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
