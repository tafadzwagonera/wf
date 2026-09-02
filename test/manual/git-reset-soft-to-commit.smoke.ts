/**
 * Manual smoke test: GitService.resetSoftToCommit leaves source staged, unstages excluded paths
 *
 * Run: nr test:manual -- test-git-reset-soft-to-commit
 *
 * Verifies:
 *   1. HEAD moves back to the target ref
 *   2. Source files are left staged (not uncommitted, not dropped)
 *   3. EXCLUDED_PATHS (.wf/**, dist/, wf.config.*) are NOT staged after reset
 *   4. Idempotent — calling twice on the same ref does not throw or change state
 *   5. Source-only commit (no excluded paths) leaves the source file staged
 *
 * No AI / API keys required — exercises GitService.resetSoftToCommit directly.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

function makeRepo(): { dir: string; git: (cmd: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-soft-reset-'));
  const run = (cmd: string) => execSync(cmd, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  run('git init');
  run('git config user.email "test@example.com"');
  run('git config user.name "Test"');
  run('git config commit.gpgsign false');
  return { dir, git: run };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const gitService = app.get(GitService);
  const dirs: string[] = [];

  try {
    console.log(chalk.bold.cyan('\nSmoke test: GitService.resetSoftToCommit\n'));

    // ── Scenario 1: source staged, excluded paths unstaged ─────────────────
    console.log('Scenario 1: after reset — source staged, excluded paths unstaged\n');
    const { dir, git } = makeRepo();
    dirs.push(dir);

    // baseline commit: one source file
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const v = 1;');
    git('git add .');
    git('git commit -m "baseline"');
    const baselineSha = git('git rev-parse HEAD');

    // agent self-commit: source change + three excluded-path categories
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const v = 2;');
    fs.mkdirSync(path.join(dir, '.wf', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wf', 'state', 'plan.json'), '{"key":"T-1"}');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'main.js'), '"use strict";');
    fs.writeFileSync(path.join(dir, 'wf.config.ts'), 'export default {};');
    git('git add .');
    git('git commit -m "agent self-commit"');

    const headBefore = git('git rev-parse HEAD');
    assert('HEAD moved past baseline before reset', headBefore !== baselineSha, headBefore);

    await gitService.resetSoftToCommit(baselineSha, dir);

    const headAfter = git('git rev-parse HEAD');
    assert('HEAD is back at baseline', headAfter === baselineSha, headAfter);

    const staged = git('git diff --cached --name-only');
    assert('src/app.ts IS staged', staged.includes('src/app.ts'), staged);
    assert('.wf/state/plan.json is NOT staged', !staged.includes('.wf/'), staged);
    assert('dist/main.js is NOT staged', !staged.includes('dist/'), staged);
    assert('wf.config.ts is NOT staged', !staged.includes('wf.config.ts'), staged);

    // ── Scenario 2: idempotent — second call does not throw ────────────────
    console.log('\nScenario 2: idempotent — second call on same ref is a no-op\n');
    let threw = false;
    try {
      await gitService.resetSoftToCommit(baselineSha, dir);
    } catch {
      threw = true;
    }
    assert('second call on already-reset ref does not throw', !threw);

    const stagedAfterSecond = git('git diff --cached --name-only');
    assert('staged index unchanged after second call', stagedAfterSecond === staged, stagedAfterSecond);

    // ── Scenario 3: source-only commit — no excluded paths to unstage ──────
    console.log('\nScenario 3: source-only commit leaves source file staged\n');
    const { dir: dir3, git: git3 } = makeRepo();
    dirs.push(dir3);

    fs.mkdirSync(path.join(dir3, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir3, 'src', 'index.ts'), 'v1');
    git3('git add .');
    git3('git commit -m "baseline"');
    const base3 = git3('git rev-parse HEAD');

    fs.writeFileSync(path.join(dir3, 'src', 'index.ts'), 'v2');
    git3('git add .');
    git3('git commit -m "source only"');

    await gitService.resetSoftToCommit(base3, dir3);

    const staged3 = git3('git diff --cached --name-only');
    assert('src/index.ts is staged after source-only reset', staged3.includes('src/index.ts'), staged3);
  } finally {
    await app.close();
    for (const d of dirs) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  }

  console.log(chalk.bold(`\n  ${counts.passed} passed, ${counts.failed} failed\n`));
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
