/**
 * Manual Test: stageAll survives a concurrent process deleting-and-committing a file mid-run
 *
 * Run: nr test:manual stage-all-concurrent-delete-commit-race.smoke.ts
 *
 * This is the original reported bug: two real, independent processes mutating
 * the same git working tree can race — one process's `git status()` observes
 * a file as pending just before another process deletes and commits it, so
 * the first process's subsequent `git add` used to throw a hard, uncaught
 * GitError ("pathspec ... did not match any files"). The fix retries once
 * against a fresh status snapshot and logs a warning when it does.
 *
 * Because this is a genuine timing race, this test runs real concurrent OS
 * processes across several iterations rather than asserting a single
 * deterministic outcome. The hard requirement is "stageAll itself never
 * throws anything other than a well-formed GitError"; whether the retry path
 * is actually exercised in any given run depends on OS scheduling and is
 * reported as informational, not a failure condition.
 *
 * Note: the racing "other process" (a real `git rm` + `git commit`) can
 * itself occasionally fail with a `.git/index.lock` contention error if it
 * collides with stageAll's own concurrent `git add` — that is expected when
 * racing two real git CLIs without external coordination and is unrelated to
 * stageAll's own error handling, so it is logged and ignored rather than
 * treated as a failure of the code under test.
 *
 * Verifies that:
 *   1. Across all iterations, `gitService.stageAll()` itself never rejects
 *      with anything other than a `GitError` — no unhandled exception, no
 *      raw "did not match any files" escaping unwrapped
 *   2. (informational) whether the retry-and-warn path was actually observed
 *      in at least one iteration
 *
 * No AI / API keys required — exercises GitService.stageAll() directly against
 * real scratch git repos; no CLI process or AI provider involved.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import { GitError } from '../../src/common/errors/app.error';
import { createReporter, summarise } from './support/reporter';

const ITERATIONS = 25;
const execFileAsync = promisify(execFile);

const { counts, pass, fail } = createReporter();

function makeRacingRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stage-race-'));
  const git = (cmd: string[]) => execFileSync('git', cmd, { cwd: dir, stdio: 'pipe' });
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'gc.auto', '0']);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
  fs.writeFileSync(path.join(dir, 'vanish.txt'), 'vanish\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep-modified\n');
  return dir;
}

async function runOtherProcess(repoDir: string): Promise<void> {
  try {
    await execFileAsync('git', ['rm', 'vanish.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'concurrent delete'], { cwd: repoDir });
  } catch (error) {
    // Two real git CLIs racing without external coordination can collide on
    // .git/index.lock. That's harness-level contention between our own two
    // racing processes, not a failure of stageAll's error handling.
    console.log(`  ℹ Racing "other process" hit lock contention (expected occasionally): ${(error as Error).message.split('\n')[0]}`);
  }
}

function cleanupRepo(repoDir: string): void {
  try {
    fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (cleanupError) {
    // On macOS, Spotlight/mdworker or a lingering git subprocess can
    // transiently hold a handle inside a just-mutated .git directory.
    // Unrelated to the behavior under test, so this is logged, not fatal.
    console.log(`  ℹ Cleanup of ${repoDir} failed (non-fatal): ${(cleanupError as Error).message}`);
  }
}

async function stageAllOrDetectCrash(gitService: GitService, repoDir: string): Promise<boolean> {
  try {
    await gitService.stageAll(repoDir);
    return false;
  } catch (error) {
    return !(error instanceof GitError);
  }
}

function buildRetryTracker(): { isRetried: () => boolean; intercept: (...args: unknown[]) => void } {
  let retried = false;
  return {
    isRetried: () => retried,
    intercept: (...args: unknown[]) => {
      if (String(args[0] ?? '').includes('vanished after git status')) retried = true;
    },
  };
}

async function raceOnce(gitService: GitService): Promise<{ crashed: boolean; retried: boolean }> {
  const repoDir = makeRacingRepo();
  const originalWarn = console.warn;
  const tracker = buildRetryTracker();
  (console.warn as any) = tracker.intercept;
  try {
    const otherProcess = runOtherProcess(repoDir);
    const crashed = await stageAllOrDetectCrash(gitService, repoDir);
    await otherProcess;
    return { crashed, retried: tracker.isRetried() };
  } finally {
    console.warn = originalWarn;
    cleanupRepo(repoDir);
  }
}

async function runRaceIterations(gitService: GitService): Promise<{ crashCount: number; retryObserved: boolean }> {
  let crashCount = 0;
  let retryObserved = false;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const result = await raceOnce(gitService);
    if (result.crashed) crashCount += 1;
    if (result.retried) retryObserved = true;
  }
  return { crashCount, retryObserved };
}

function checkNoUnhandledCrashes(crashCount: number): void {
  if (crashCount === 0) {
    pass(`stageAll never rejected with anything other than GitError across ${ITERATIONS} racing iterations`);
  } else {
    fail(`stageAll rejected with a non-GitError in ${crashCount}/${ITERATIONS} iterations`);
  }
}

function reportRetryObservation(retryObserved: boolean): void {
  if (retryObserved) {
    pass('The retry-and-warn path was observed at least once (race landed as intended)');
  } else {
    console.log('  ℹ Retry path was not observed this run — the race window was never hit (informational, not a failure)');
  }
}

async function main(): Promise<void> {
  console.log('\n stageAll concurrent delete-commit race\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const gitService = app.get(GitService);
  const { crashCount, retryObserved } = await runRaceIterations(gitService);
  checkNoUnhandledCrashes(crashCount);
  reportRetryObservation(retryObserved);
  await app.close();
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
