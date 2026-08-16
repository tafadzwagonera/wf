/**
 * Manual smoke test: commit-policy enforcement integration
 *
 * Run: nr test:manual -- test-commit-policy-enforcement-integration
 *
 * Verifies the three-step detect → rewind → staged sequence that
 * ImplementerAgent.runBackend() uses to recover from a disallowed self-commit:
 *   1. listCommitsInRange detects new commits since baseline
 *   2. resetSoftToCommit rewinds HEAD and leaves content staged
 *   3. getStatus sees staged files (hasChanges: true)
 *
 * Also covers:
 *   - Excluded-path artifacts are NOT staged after rewind
 *   - Empty range (no self-commit) correctly reports no new commits
 *
 * No AI / API keys required — uses GitService directly against temp repos.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(chalk.green(`  ✓ ${msg}`));
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${msg}`));
  if (detail) console.error(chalk.gray(`    → ${detail}`));
  failed++;
};
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

function makeRepo(): { dir: string; git: (cmd: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-policy-enforce-'));
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
    console.log(chalk.bold.cyan('\nSmoke test: commit-policy enforcement integration\n'));

    // ── Scenario 1: detect → rewind → staged ──────────────────────────────
    console.log('Scenario 1: self-commit detected, rewound, content staged\n');
    const { dir, git } = makeRepo();
    dirs.push(dir);

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const v = 1;');
    git('git add .');
    git('git commit -m "baseline"');

    const [baseline] = await gitService.getRecentCommits(1, dir);
    assert('baseline captured via getRecentCommits', !!baseline?.hash, 'no commit');

    // simulate agent self-commit
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const v = 2;');
    git('git add .');
    git('git commit -m "agent: implement feature"');

    const newCommits = await gitService.listCommitsInRange({ from: baseline.hash, to: 'HEAD' }, dir);
    assert('self-commit detected via listCommitsInRange', newCommits.length === 1, `got ${newCommits.length}`);
    assert('detected commit subject matches', newCommits[0]?.subject === 'agent: implement feature', newCommits[0]?.subject);

    const mergeCommits = await gitService.listCommitsInRange({ from: baseline.hash, to: 'HEAD', mergesOnly: true }, dir);
    assert('self-commit is not a merge commit', mergeCommits.length === 0, `got ${mergeCommits.length}`);

    await gitService.resetSoftToCommit(baseline.hash, dir);

    const status = await gitService.getStatus(dir);
    assert('getStatus reports staged files after rewind (hasChanges: true)', status.files.length > 0, `files: ${status.files.length}`);
    assert('HEAD is back at baseline', git('git rev-parse HEAD') === baseline.hash, git('git rev-parse HEAD'));

    // ── Scenario 2: excluded-path artifacts are unstaged after rewind ──────
    console.log('\nScenario 2: excluded-path artifacts in self-commit are NOT staged after rewind\n');
    const { dir: dir2, git: git2 } = makeRepo();
    dirs.push(dir2);

    fs.mkdirSync(path.join(dir2, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'src', 'lib.ts'), 'v1');
    git2('git add .');
    git2('git commit -m "baseline"');
    const [base2] = await gitService.getRecentCommits(1, dir2);

    // agent commits source + wf artifact
    fs.writeFileSync(path.join(dir2, 'src', 'lib.ts'), 'v2');
    fs.mkdirSync(path.join(dir2, '.wf', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir2, '.wf', 'logs', 'run.log'), 'agent output');
    git2('git add .');
    git2('git commit -m "agent commit with artifact"');

    await gitService.resetSoftToCommit(base2.hash, dir2);

    const staged2 = git2('git diff --cached --name-only');
    assert('source file IS staged after rewind', staged2.includes('src/lib.ts'), staged2);
    assert('.wf artifact is NOT staged after rewind', !staged2.includes('.wf/'), staged2);

    const status2 = await gitService.getStatus(dir2);
    assert('hasChanges: true even after excluded paths stripped', status2.files.length > 0, `files: ${status2.files.length}`);

    // ── Scenario 3: no self-commit → empty range → no rewind ──────────────
    console.log('\nScenario 3: no self-commit — range is empty, working tree visible\n');
    const { dir: dir3, git: git3 } = makeRepo();
    dirs.push(dir3);

    fs.writeFileSync(path.join(dir3, 'a.ts'), 'v1');
    git3('git add .');
    git3('git commit -m "baseline"');
    const [base3] = await gitService.getRecentCommits(1, dir3);

    const noNew = await gitService.listCommitsInRange({ from: base3.hash, to: 'HEAD' }, dir3);
    assert('empty range when HEAD unchanged', noNew.length === 0, `got ${noNew.length}`);

    // unstaged working-tree change simulates the normal (non-commit) implement output
    fs.writeFileSync(path.join(dir3, 'a.ts'), 'v2');
    const status3 = await gitService.getStatus(dir3);
    assert('unstaged changes visible via getStatus without a rewind', status3.files.length > 0, `files: ${status3.files.length}`);
  } finally {
    await app.close();
    for (const d of dirs) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  }

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
