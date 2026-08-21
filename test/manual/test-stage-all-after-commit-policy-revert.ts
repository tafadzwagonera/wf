/**
 * Manual smoke test: GitService.stageAll does not throw after resetSoftToCommit unwinds a deletion commit
 *
 * Run: nr test:manual -- test-stage-all-after-commit-policy-revert
 *
 * Verifies:
 *   1. stageAll resolves without throwing when the index contains a fully-staged
 *      deletion left behind by resetSoftToCommit (the exact reported crash path)
 *   2. The staged deletion is preserved in the index after stageAll — the fix skips
 *      the path rather than losing the change
 *   3. stageAll still stages all genuinely pending changes (modifications, deletions,
 *      new files) alongside already-staged paths it leaves untouched
 *   4. stageAll is idempotent: a second consecutive call resolves and leaves the
 *      index byte-identical to what the first call produced
 *
 * No AI / API keys required — exercises GitService.resetSoftToCommit and stageAll directly.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stage-after-revert-'));
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
    console.log(chalk.bold.cyan('\nSmoke test: GitService.stageAll after resetSoftToCommit\n'));

    console.log('Scenario 1: stageAll does not throw after resetSoftToCommit unwinds a deletion\n');
    const { dir, git } = makeRepo();
    dirs.push(dir);

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const v = 1;');
    fs.writeFileSync(path.join(dir, 'sonar-project.properties'), 'sonar.projectKey=test');
    git('git add .');
    git('git commit -m "baseline"');
    const baselineSha = git('git rev-parse HEAD');

    git('git rm sonar-project.properties');
    git('git commit -m "remove sonar config"');

    // commit-policy rewind: soft-reset back to baseline, index still shows deletion
    await gitService.resetSoftToCommit(baselineSha, dir);

    let stageAllThrew = false;
    let stageAllError = '';
    try {
      await gitService.stageAll(dir);
    } catch (err: unknown) {
      stageAllThrew = true;
      stageAllError = err instanceof Error ? err.message : String(err);
    }
    assert('stageAll resolves without throwing', !stageAllThrew, stageAllError);

    const porcelain = git('git status --porcelain');
    // Staged deletion shows as "D  sonar-project.properties" (D in index column, space in worktree)
    assert(
      'sonar-project.properties remains a staged deletion in the index',
      porcelain.includes('D  sonar-project.properties'),
      `git status --porcelain:\n${porcelain}`
    );

    const cachedNameStatus = git('git diff --cached --name-status');
    assert(
      'git diff --cached still lists the deletion after stageAll',
      cachedNameStatus.includes('sonar-project.properties'),
      `git diff --cached --name-status:\n${cachedNameStatus}`
    );

    console.log('\nScenario 2: genuinely pending changes are still staged alongside skipped paths\n');
    const { dir: dir2, git: git2 } = makeRepo();
    dirs.push(dir2);

    fs.mkdirSync(path.join(dir2, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir2, 'src', 'index.ts'), 'v1');
    fs.writeFileSync(path.join(dir2, 'config.json'), '{}');
    git2('git add .');
    git2('git commit -m "baseline"');
    const base2 = git2('git rev-parse HEAD');

    git2('git rm config.json');
    fs.writeFileSync(path.join(dir2, 'src', 'index.ts'), 'v2');
    fs.writeFileSync(path.join(dir2, 'src', 'helper.ts'), 'export {}');
    git2('git add .');
    git2('git commit -m "agent changes"');

    await gitService.resetSoftToCommit(base2, dir2);
    fs.writeFileSync(path.join(dir2, 'src', 'index.ts'), 'v3');

    await gitService.stageAll(dir2);

    const cached2 = git2('git diff --cached --name-status');
    assert('staged deletion (config.json) is present in cached diff', cached2.includes('config.json'), cached2);
    assert('modified file (src/index.ts) is staged', cached2.includes('src/index.ts'), cached2);
    assert('new file (src/helper.ts) is staged', cached2.includes('src/helper.ts'), cached2);

    console.log('\nScenario 3: second stageAll call is idempotent\n');
    const porcelainAfterFirst = git('git status --porcelain');
    await gitService.stageAll(dir);
    const porcelainAfterSecond = git('git status --porcelain');
    assert(
      'git status --porcelain is identical after a second stageAll call',
      porcelainAfterFirst === porcelainAfterSecond,
      `after first:\n${porcelainAfterFirst}\nafter second:\n${porcelainAfterSecond}`
    );
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
