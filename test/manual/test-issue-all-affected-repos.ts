/**
 * Manual Test Script for issue:all --repos feature
 *
 * Run: nr test:manual -- test-issue-all-affected-repos
 *
 * Tests repository resolution logic: explicit CLI flag, AI-inferred fallback,
 * and deduplication.
 *
 * All tests exercise the real IMPLEMENT stage in a temp directory.
 * No external APIs are called (PLAN stage is pre-seeded via plan fixtures).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueAllCommand } from '../../src/commands/issue-all.command';

async function testIssueAllAffectedRepos() {
  console.log('🧪 Testing issue:all --repos feature\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const command = app.get(IssueAllCommand);

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`✓ ${msg}\n`);
    passed++;
  };
  const fail = (msg: string) => {
    console.error(`❌ ${msg}\n`);
    failed++;
  };

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Create a temp root with a ticket file and an optional plan file.
   * Returns the temp root path and a cleanup function.
   */
  const makeFixtures = (opts: {
    ticketKey: string;
    platformName?: string;
    planRepositoriesAffected?: string[];
    action?: string;
  }): { tmpRoot: string; cleanup: () => void } => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-all-'));
    const platformName = opts.platformName ?? 'jira';
    const platformDir = path.join(tmpRoot, '.wf', platformName);
    fs.mkdirSync(platformDir, { recursive: true });

    const ticketPath = path.join(platformDir, `${opts.ticketKey}.md`);
    fs.writeFileSync(
      ticketPath,
      `# ${opts.ticketKey}: Test ticket\n\n**Type:** Task\n**Status:** Open\n\n## Description\n\nTest ticket for affected-repos tests.\n`,
      'utf-8',
    );

    // Always write a plan file (required when starting from implement stage).
    const action = opts.action ?? 'fix';
    const plan: Record<string, any> = {
      action,
      summary: 'Test plan',
      steps: ['Step 1'],
      estimatedComplexity: 'low',
    };
    if (opts.planRepositoriesAffected) {
      plan.repositoriesAffected = opts.planRepositoriesAffected;
    }
    const planPath = path.join(
      platformDir,
      `${opts.ticketKey}-plan-${action}.json`,
    );
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');

    // Initialise a bare git repo so branch operations don't throw.
    execSync('git init', { cwd: tmpRoot, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tmpRoot, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpRoot, stdio: 'ignore' });
    execSync('git commit --allow-empty -m "init"', { cwd: tmpRoot, stdio: 'ignore' });

    return {
      tmpRoot,
      cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
    };
  };

  /**
   * Run a command.run() call and capture all stdout lines.
   * Swaps process.stdout.write so chalk output is intercepted.
   * Also mocks process.exit so a failed command doesn't kill the test process.
   */
  const captureOutput = async (
    fn: () => Promise<void>,
  ): Promise<{ output: string; error?: string }> => {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalExit = process.exit.bind(process);
    (process.stdout.write as any) = (chunk: any, ...args: any[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalWrite(chunk, ...args);
    };
    (process.exit as any) = (code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    };
    try {
      await fn();
    } catch (err: any) {
      // Swallow — may be from our mocked process.exit or a handled command error.
    } finally {
      (process.stdout.write as any) = originalWrite;
      (process.exit as any) = originalExit;
    }
    return { output: chunks.join('') };
  };

  // ── Tests ────────────────────────────────────────────────────────────────

  // Test 1: --repos flag only; plan has no repositoriesAffected → IMPLEMENT shows flag repo
  console.log('Test 1: explicit --repos only → IMPLEMENT shows flag repo');
  {
    const { tmpRoot, cleanup } = makeFixtures({ ticketKey: 'TEST-1' });
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const { output } = await captureOutput(() =>
        command.run(['TEST-1'], {
          from: 'implement',
          to: 'implement',
          action: 'fix',
          repos: ['repo-a'],
        }),
      );
      if (output.includes('repo-a')) {
        pass('IMPLEMENT stage shows explicitly provided repo-a');
      } else {
        fail(`Test 1: repo-a not found in output. Output:\n${output}`);
      }
    } finally {
      process.chdir(originalCwd);
      cleanup();
    }
  }

  // Test 2: Empty --repos; plan has repositoriesAffected → IMPLEMENT shows plan repos
  console.log(
    'Test 2: empty --repos; plan has repositoriesAffected → IMPLEMENT shows plan repo',
  );
  {
    const { tmpRoot, cleanup } = makeFixtures({
      ticketKey: 'TEST-2',
      planRepositoriesAffected: ['repo-b'],
      action: 'fix',
    });
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const { output } = await captureOutput(() =>
        command.run(['TEST-2'], {
          from: 'implement',
          to: 'implement',
          action: 'fix',
          repos: [],
        }),
      );
      if (output.includes('repo-b')) {
        pass('IMPLEMENT stage shows AI-inferred repo-b from plan');
      } else {
        fail(`Test 2: repo-b not found in output. Output:\n${output}`);
      }
    } finally {
      process.chdir(originalCwd);
      cleanup();
    }
  }

  // Test 3: --repos + plan repos → deduplicated union
  console.log(
    'Test 3: explicit repos + plan repos → deduplication applied correctly',
  );
  {
    const { tmpRoot, cleanup } = makeFixtures({
      ticketKey: 'TEST-3',
      planRepositoriesAffected: ['repo-b', 'repo-c'],
      action: 'fix',
    });
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const { output } = await captureOutput(() =>
        command.run(['TEST-3'], {
          from: 'implement',
          to: 'implement',
          action: 'fix',
          repos: ['repo-a', 'repo-b'],
        }),
      );
      const hasRepoA = output.includes('repo-a');
      const hasRepoB = output.includes('repo-b');
      const hasRepoC = output.includes('repo-c');
      // repo-b should be looped over exactly once (sub-label appears once, not twice)
      const repoBLoopCount = (output.match(/── repo-b ──/g) ?? []).length;
      if (hasRepoA && hasRepoB && hasRepoC && repoBLoopCount === 1) {
        pass(
          'Deduplication: repo-a, repo-b (iterated ×1), repo-c each appear correctly',
        );
      } else {
        fail(
          `Test 3: expected repo-a=${hasRepoA}, repo-b-iterated×1=${repoBLoopCount === 1}, repo-c=${hasRepoC}. Output:\n${output}`,
        );
      }
    } finally {
      process.chdir(originalCwd);
      cleanup();
    }
  }

  // Test 4: Single --repos value; workflow displays it across IMPLEMENT, REVIEW, COMMIT stages
  console.log('Test 4: single --repos value → shown in IMPLEMENT stage');
  {
    const { tmpRoot, cleanup } = makeFixtures({ ticketKey: 'TEST-4' });
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const { output } = await captureOutput(() =>
        command.run(['TEST-4'], {
          from: 'implement',
          to: 'implement',
          action: 'fix',
          repos: ['only-repo'],
        }),
      );
      if (output.includes('only-repo')) {
        pass('IMPLEMENT stage displays the single provided repo');
      } else {
        fail(`Test 4: only-repo not found in output. Output:\n${output}`);
      }
    } finally {
      process.chdir(originalCwd);
      cleanup();
    }
  }

  // Test 5: REVIEW stage also shows resolvedRepos
  console.log('Test 5: REVIEW stage shows repositories in scope');
  {
    const { tmpRoot, cleanup } = makeFixtures({
      ticketKey: 'TEST-5',
      planRepositoriesAffected: ['review-repo'],
      action: 'fix',
    });
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const { output } = await captureOutput(() =>
        command.run(['TEST-5'], {
          from: 'review',
          to: 'review',
          action: 'fix',
          repos: ['review-repo'],
        }),
      );
      if (output.includes('review-repo')) {
        pass('REVIEW stage shows repositories in scope');
      } else {
        fail(
          `Test 5: review-repo not found in REVIEW output. Output:\n${output}`,
        );
      }
    } finally {
      process.chdir(originalCwd);
      cleanup();
    }
  }

  // Test 6: Multi-repo → stage 3 header appears exactly once
  console.log('Test 6: multi-repo → STAGE 3 header appears exactly once');
  {
    const { tmpRoot, cleanup } = makeFixtures({ ticketKey: 'TEST-6', action: 'fix' });
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const { output } = await captureOutput(() =>
        command.run(['TEST-6'], {
          from: 'implement',
          to: 'implement',
          action: 'fix',
          repos: ['repo-a', 'repo-b'],
        }),
      );
      const headerCount = (output.match(/STAGE 3: Implementation Guide/g) ?? []).length;
      if (headerCount === 1) {
        pass('Multi-repo: STAGE 3 header appears exactly once');
      } else {
        fail(`Test 6: expected 1 header, got ${headerCount}.\n${output}`);
      }
    } finally {
      process.chdir(originalCwd);
      cleanup();
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) {
    console.log('✅ All tests passed!');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await app.close();
}

testIssueAllAffectedRepos();
