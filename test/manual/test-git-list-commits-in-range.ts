/**
 * Manual smoke test: GitService.listCommitsInRange reads real git history
 *
 * Run: nr test:manual -- test-git-list-commits-in-range
 *
 * Verifies:
 *   1. Returns correct hash/subject pairs for commits in a range
 *   2. Empty range (from == to) returns []
 *   3. mergesOnly: true returns only merge commits; non-merge commits are excluded
 *   4. Subjects with colons, parens, and spaces round-trip without truncation
 *
 * No AI / API keys required — exercises GitService.listCommitsInRange directly.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-rev-list-'));
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
    console.log(chalk.bold.cyan('\nSmoke test: GitService.listCommitsInRange\n'));

    // ── Scenario 1: hash/subject pairs for a linear range ─────────────────
    console.log('Scenario 1: hash/subject pairs for a linear range\n');
    const { dir: dir1, git: git1 } = makeRepo();
    dirs.push(dir1);

    fs.writeFileSync(path.join(dir1, 'a.ts'), 'v1');
    git1('git add .');
    git1('git commit -m "fix: first change"');
    const sha1 = git1('git rev-parse HEAD');

    fs.writeFileSync(path.join(dir1, 'a.ts'), 'v2');
    git1('git add .');
    git1('git commit -m "feat: second change"');

    const commits1 = await gitService.listCommitsInRange({ from: sha1, to: 'HEAD' }, dir1);

    assert('returns exactly one commit in the range', commits1.length === 1, `got ${commits1.length}`);
    assert('hash is a 40-char SHA', commits1[0]?.hash.length === 40, commits1[0]?.hash);
    assert('subject matches commit message exactly', commits1[0]?.subject === 'feat: second change', commits1[0]?.subject);

    // ── Scenario 2: empty range ────────────────────────────────────────────
    console.log('\nScenario 2: empty range (from == HEAD) returns []\n');
    const sha1b = git1('git rev-parse HEAD');
    const empty = await gitService.listCommitsInRange({ from: sha1b, to: 'HEAD' }, dir1);
    assert('empty range returns []', empty.length === 0, `got ${empty.length}`);

    // ── Scenario 3: mergesOnly filter ─────────────────────────────────────
    console.log('\nScenario 3: mergesOnly: true returns only merge commits\n');
    const { dir: dir3, git: git3 } = makeRepo();
    dirs.push(dir3);

    fs.writeFileSync(path.join(dir3, 'a.ts'), 'v1');
    git3('git add .');
    git3('git commit -m "init"');
    const baseline3 = git3('git rev-parse HEAD');
    const mainBranch = git3('git rev-parse --abbrev-ref HEAD');

    git3('git checkout -b feature');
    fs.writeFileSync(path.join(dir3, 'b.ts'), 'feat');
    git3('git add .');
    git3('git commit -m "feat: feature work"');
    git3(`git checkout ${mainBranch}`);
    git3(`git merge --no-ff feature -m "Merge branch feature into ${mainBranch}"`);

    const all3 = await gitService.listCommitsInRange({ from: baseline3, to: 'HEAD' }, dir3);
    const merges3 = await gitService.listCommitsInRange({ from: baseline3, to: 'HEAD', mergesOnly: true }, dir3);

    assert('range includes both regular and merge commits', all3.length === 2, `got ${all3.length}`);
    assert('mergesOnly returns exactly one entry', merges3.length === 1, `got ${merges3.length}`);
    assert('merge commit subject is preserved', merges3[0]?.subject.startsWith('Merge branch'), merges3[0]?.subject);

    // ── Scenario 4: subjects with colons, parens, and spaces ──────────────
    console.log('\nScenario 4: subjects with colons and parens round-trip\n');
    const { dir: dir4, git: git4 } = makeRepo();
    dirs.push(dir4);

    fs.writeFileSync(path.join(dir4, 'x.ts'), 'v0');
    git4('git add .');
    git4('git commit -m "init"');
    const base4 = git4('git rev-parse HEAD');

    const subject = 'fix(auth): handle null token in middleware';
    fs.writeFileSync(path.join(dir4, 'x.ts'), 'v1');
    git4('git add .');
    git4(`git commit -m "${subject}"`);

    const r4 = await gitService.listCommitsInRange({ from: base4 }, dir4);
    assert('subject with colons and parens round-trips without truncation', r4[0]?.subject === subject, r4[0]?.subject);
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
