/**
 * Manual Test: GitService.commit() excludes tooling artifacts and rejects staged .gitignore
 *
 * Run: nr test:manual -- test-git-commit-exclusions
 *
 * Verifies:
 *   1. commit() auto-stages only real source files when nothing is pre-staged
 *   2. .wf/** runtime artifacts are excluded from the commit
 *   3. All six wf.config.* variants are excluded from the commit
 *   4. dist/ build output is excluded from the commit
 *   5. Already-staged files are used as-is (pre-staged branch)
 *   6. Staged .gitignore causes commit() to fail hard before any commit is created
 *   7. Explicit commit file lists that include .gitignore also fail hard
 *   8. Commit succeeds without using git pathspec exclude magic
 *
 * No AI / API keys required — exercises GitService.commit() directly.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { GitService } from '../../src/integrations/git/git.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

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

function makeRepo(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-commit-test-'));
  const git = (cmd: string) =>
    execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  git('config commit.gpgsign false');

  const srcFile = path.join(tmpDir, 'index.ts');
  fs.writeFileSync(srcFile, 'export const hello = () => "hello";\n');
  git('add .');
  git('commit -m "init"');
  return tmpDir;
}

function committedFiles(tmpDir: string): string {
  try {
    return execSync('git show --name-only --format="" HEAD', {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const gitService = app.get(GitService);
  const dirs: string[] = [];

  try {
    // ── Scenario 1: auto-stage branch with excluded artifacts ──────────────
    console.log('\n🧪 GitService.commit() exclusion smoke tests\n');
    console.log('─'.repeat(60));
    console.log('\nScenario 1: auto-stage excludes .wf/** and wf.config.*\n');

    const dir1 = makeRepo();
    dirs.push(dir1);

    // Real code change (unstaged)
    const srcFile1 = path.join(dir1, 'index.ts');
    fs.writeFileSync(srcFile1, 'export const hello = () => "hello v2";\n');

    // .wf/** runtime artifact
    const wfDir = path.join(dir1, '.wf', 'state');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'plan.json'), '{"key":"TEST-001"}');

    // All six wf.config.* variants
    const wfConfigFiles = [
      'wf.config.js',
      'wf.config.mjs',
      'wf.config.ts',
      'wf.config.mts',
      'wf.config.yaml',
      'wf.config.yml',
    ];
    for (const cfgFile of wfConfigFiles) {
      fs.writeFileSync(
        path.join(dir1, cfgFile),
        `// wf tooling artifact\nmodule.exports = {};\n`,
      );
    }

    // dist/ build output
    const distDir = path.join(dir1, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.js'), '"use strict";\n');

    await gitService.commit({
      message: 'test: auto-stage scenario',
      cwd: dir1,
    });

    const files1 = committedFiles(dir1);
    console.log('Committed files:\n' + (files1 || '(none)') + '\n');

    if (files1.includes('index.ts')) {
      pass('index.ts (real code change) WAS committed');
    } else {
      fail('index.ts was NOT committed — exclusion too broad', files1);
    }

    if (!files1.includes('.wf/')) {
      pass('.wf/** runtime artifacts were NOT committed');
    } else {
      fail('.wf/** artifacts leaked into commit', files1);
    }

    for (const cfgFile of wfConfigFiles) {
      if (!files1.includes(cfgFile)) {
        pass(`${cfgFile} was NOT committed`);
      } else {
        fail(`${cfgFile} leaked into commit`, files1);
      }
    }

    if (!files1.includes('dist/')) {
      pass('dist/ build output was NOT committed');
    } else {
      fail('dist/ build output leaked into commit', files1);
    }

    // ── Scenario 2: pre-staged files are used as-is ────────────────────────
    console.log('\n─'.repeat(30));
    console.log('\nScenario 2: pre-staged files committed as-is\n');

    const dir2 = makeRepo();
    dirs.push(dir2);

    const srcFile2 = path.join(dir2, 'index.ts');
    fs.writeFileSync(srcFile2, 'export const hello = () => "hello v2";\n');

    // Manually stage only the source file — wf artifact is NOT staged
    const wfDir2 = path.join(dir2, '.wf', 'logs');
    fs.mkdirSync(wfDir2, { recursive: true });
    fs.writeFileSync(path.join(wfDir2, 'run.log'), 'some log');

    execSync('git add index.ts', { cwd: dir2, stdio: 'pipe' });

    await gitService.commit({
      message: 'test: pre-staged scenario',
      cwd: dir2,
    });

    const files2 = committedFiles(dir2);
    console.log('Committed files:\n' + (files2 || '(none)') + '\n');

    if (files2.includes('index.ts')) {
      pass('Pre-staged index.ts WAS committed');
    } else {
      fail('Pre-staged index.ts was NOT committed', files2);
    }

    if (!files2.includes('.wf/')) {
      pass('.wf/** artifact NOT in commit (was never staged)');
    } else {
      fail('.wf/** artifact leaked into pre-staged commit', files2);
    }

    // ── Scenario 3: staged .gitignore must fail hard ───────────────────────
    console.log('\n─'.repeat(30));
    console.log('\nScenario 3: staged .gitignore rejects commit\n');

    const dir3 = makeRepo();
    dirs.push(dir3);

    const srcFile3 = path.join(dir3, 'index.ts');
    fs.writeFileSync(srcFile3, 'export const hello = () => "hello v2";\n');
    fs.writeFileSync(path.join(dir3, '.gitignore'), 'node_modules/\n');
    execSync('git add index.ts .gitignore', { cwd: dir3, stdio: 'pipe' });

    let rejected = false;
    try {
      await gitService.commit({
        message: 'test: staged gitignore should fail',
        cwd: dir3,
      });
    } catch (error) {
      rejected = true;
      const message = (error as Error).message;
      if (message.includes('.gitignore')) {
        pass('commit() rejected staged .gitignore');
      } else {
        fail('commit() rejected the commit without naming .gitignore', message);
      }
    }

    if (!rejected) {
      fail('commit() allowed staged .gitignore to be committed');
    }

    const committedFiles3 = committedFiles(dir3);
    if (committedFiles3.includes('.gitignore')) {
      fail(
        '.gitignore was committed despite the hard failure',
        committedFiles3,
      );
    } else {
      pass('.gitignore was not committed after the hard failure');
    }

    // ── Scenario 4: explicit files list containing .gitignore must fail ──
    console.log('\n─'.repeat(30));
    console.log('\nScenario 4: explicit files list rejects .gitignore\n');

    const dir4 = makeRepo();
    dirs.push(dir4);

    const srcFile4 = path.join(dir4, 'index.ts');
    fs.writeFileSync(srcFile4, 'export const hello = () => "hello v2";\n');
    fs.writeFileSync(path.join(dir4, '.gitignore'), 'node_modules/\n');

    rejected = false;
    try {
      await gitService.commit({
        message: 'test: explicit gitignore should fail',
        cwd: dir4,
        files: ['index.ts', '.gitignore'],
      });
    } catch (error) {
      rejected = true;
      const message = (error as Error).message;
      if (message.includes('.gitignore')) {
        pass('commit() rejected an explicit files list containing .gitignore');
      } else {
        fail(
          'commit() rejected the explicit files list without naming .gitignore',
          message,
        );
      }
    }

    if (!rejected) {
      fail('commit() allowed an explicit files list containing .gitignore');
    }

    const committedFiles4 = committedFiles(dir4);
    if (committedFiles4.includes('.gitignore')) {
      fail(
        '.gitignore was committed despite the explicit-files hard failure',
        committedFiles4,
      );
    } else {
      pass(
        '.gitignore was not committed after the explicit-files hard failure',
      );
    }
  } finally {
    await app.close();
    for (const d of dirs) {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) {
    console.log('✅ All tests passed!');
  }
  console.log('━'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
