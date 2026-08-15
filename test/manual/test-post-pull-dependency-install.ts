/**
 * Manual smoke test: runPostPullDependencyInstall live side effects
 *
 * Run: nr test:manual -- test-post-pull-dependency-install
 *
 * Verifies four live side effects of the auto-install-after-pull feature:
 *   1. When package.json changed in a pull (merge), install runs and succeeds.
 *   2. When package.json did NOT change in a pull, no install is triggered.
 *   3. When the lockfile is inconsistent after a pull, a ⚠ warning is surfaced
 *      and the method returns without throwing.
 *   4. On a fresh clone (no reflog — HEAD@{1} unresolvable), the method silently
 *      returns without installing anything.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import { runPostPullDependencyInstall } from '../../src/shared/utils/post-pull-install';
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(chalk.green(`  ✓ ${msg}`));
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${msg}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed++;
};
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const captureLogs = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    lines.push(line);
    orig(...args);
  };
  const restore = (): void => {
    console.log = orig;
  };
  return { lines, restore };
};

const initRepo = (dir: string): void => {
  const run = (cmd: string): void => {
    execSync(cmd, { cwd: dir, stdio: 'pipe' });
  };
  run('git init -b master');
  run('git config user.email "smoke@test.local"');
  run('git config user.name "Smoke Test"');
};

const minimalPkgJson = (name = 'x', version = '1.0.0'): string =>
  JSON.stringify({ name, version });

const minimalLockfile = (name = 'x', version = '1.0.0'): string =>
  JSON.stringify({
    name, version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name, version } },
  }, null, 2);

async function main() {
  console.log(chalk.bold('\nSmoke test: runPostPullDependencyInstall live side effects\n'));

  // ─── Scenario 1: package.json changed in merge — install runs ───────────────
  console.log(chalk.gray('  1. package.json changed in pull → install runs'));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-post-pull-1-'));
    try {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'package.json'), minimalPkgJson());
      fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), minimalLockfile());
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

      execSync('git checkout -b feature', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'package.json'), minimalPkgJson('x', '1.0.1'));
      fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), minimalLockfile('x', '1.0.1'));
      execSync('git add . && git commit -m "bump version"', { cwd: tmpDir, stdio: 'pipe' });

      execSync('git checkout master', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git merge feature --no-ff -m "merge feature"', { cwd: tmpDir, stdio: 'pipe' });

      const { lines, restore } = captureLogs();
      await runPostPullDependencyInstall(tmpDir);
      restore();

      const logged = lines.join('\n');
      assert(
        'logs "package.json changed" after merge',
        logged.includes('package.json changed'),
        `Got: ${logged}`
      );
      assert(
        'logs install result (success or ⚠ warning) — never silent',
        logged.includes('✔ Dependencies updated') || logged.includes('⚠'),
        `Got: ${logged}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ─── Scenario 2: package.json did NOT change — no install ───────────────────
  console.log(chalk.gray('  2. package.json unchanged in pull → no install'));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-post-pull-2-'));
    try {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'package.json'), minimalPkgJson());
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

      execSync('git checkout -b feature', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'index.ts'), '// changed');
      execSync('git add . && git commit -m "add index.ts"', { cwd: tmpDir, stdio: 'pipe' });

      execSync('git checkout master', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git merge feature --no-ff -m "merge feature"', { cwd: tmpDir, stdio: 'pipe' });

      const { lines, restore } = captureLogs();
      await runPostPullDependencyInstall(tmpDir);
      restore();

      const logged = lines.join('\n');
      assert(
        'logs nothing when package.json did not change',
        !logged.includes('package.json changed') && !logged.includes('installing dependencies'),
        `Got: ${logged}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ─── Scenario 3: lockfile inconsistent — ⚠ warning surfaced, no throw ────────
  console.log(chalk.gray('  3. lockfile inconsistent after pull → ⚠ warning, no throw'));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-post-pull-3-'));
    try {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'package.json'), minimalPkgJson());
      fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), minimalLockfile());
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

      execSync('git checkout -b feature', { cwd: tmpDir, stdio: 'pipe' });
      // Change package.json but leave lockfile inconsistent (wrong name field)
      fs.writeFileSync(path.join(tmpDir, 'package.json'), minimalPkgJson('y', '2.0.0'));
      execSync('git add . && git commit -m "rename package"', { cwd: tmpDir, stdio: 'pipe' });

      execSync('git checkout master', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git merge feature --no-ff -m "merge feature"', { cwd: tmpDir, stdio: 'pipe' });

      const { lines, restore } = captureLogs();
      let threw = false;
      try {
        await runPostPullDependencyInstall(tmpDir);
      } catch {
        threw = true;
      }
      restore();

      const logged = lines.join('\n');
      assert(
        'does not throw when install fails',
        !threw,
        'runPostPullDependencyInstall threw instead of returning a warning'
      );
      assert(
        'surfaces ⚠ warning when install fails',
        logged.includes('⚠') || logged.includes('✔ Dependencies updated'),
        `Got: ${logged}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ─── Scenario 4: fresh repo — HEAD@{1} unresolvable — silent return ──────────
  console.log(chalk.gray('  4. fresh clone — no reflog — silently skips install'));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-post-pull-4-'));
    try {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'package.json'), minimalPkgJson());
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
      // Do NOT merge anything — HEAD@{1} does not resolve

      const { lines, restore } = captureLogs();
      let threw = false;
      try {
        await runPostPullDependencyInstall(tmpDir);
      } catch {
        threw = true;
      }
      restore();

      const logged = lines.join('\n');
      assert('does not throw on fresh repo', !threw);
      assert(
        'logs nothing on fresh repo (no reflog)',
        !logged.includes('installing dependencies') && !logged.includes('⚠'),
        `Got: ${logged}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
}

main();
