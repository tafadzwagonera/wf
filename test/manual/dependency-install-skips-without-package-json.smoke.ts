/**
 * Manual smoke test: dependency install skips silently in a repo with no package.json
 *
 * Run: nr test:manual dependency-install-skips-without-package-json.smoke.ts
 *
 * Scenario: Terraform-only (or any non-Node) repos have no package.json. Before this
 * change, `installDependencies` and `runDependencyInstallForVerification` ran
 * `npm ci` unconditionally regardless of language, producing a raw npm ENOENT
 * error to stdout/stderr plus a misleading "⚠ Dependency install ... failed"
 * warning on every implement-stage pull and review-stage verification. The fix
 * adds a `hasPackageJson` guard so both functions short-circuit before spawning
 * any process when package.json is absent.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { installDependencies, runDependencyInstallForVerification } from '../../src/common/utils/install-dependencies';
import { runPostPullDependencyInstall } from '../../src/common/utils/post-pull-install';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const captureOutput = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  const restore = (): void => {
    console.log = origLog;
  };
  return { lines, restore };
};

async function checkInstallDependenciesSkips(dir: string): Promise<void> {
  const result = await installDependencies(dir);
  assert(
    'installDependencies skips and reports skipped:true when no package.json exists',
    result.success && result.skipped === true && result.packageManager === 'npm',
    JSON.stringify(result),
  );

  const { lines, restore } = captureOutput();
  await runPostPullDependencyInstall(dir, false);
  restore();
  assert('runPostPullDependencyInstall produces no output when skipped', lines.length === 0, `got: ${lines.join(' | ')}`);
}

function checkVerificationInstallSkips(dir: string): void {
  const verification = runDependencyInstallForVerification(dir, { timeoutMs: 5000, maxOutputBytes: 1024 });
  assert(
    'runDependencyInstallForVerification returns not-run with the skip reason, no npm output captured',
    verification.result.status === 'not-run'
    && verification.result.reason === 'No package.json found; skipping dependency install'
    && verification.result.output === undefined,
    JSON.stringify(verification),
  );
}

async function checkRealInstallStillRunsWithPackageJson(dir: string): Promise<void> {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));

  const result = await installDependencies(dir);
  assert(
    'installDependencies attempts a real install when package.json exists (fails on missing lockfile, not skipped)',
    result.success === false,
    JSON.stringify(result),
  );
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nDependency install skip-without-package-json smoke test\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-install-skip-'));
  execSync('git init -q', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "null_resource" "x" {}\n');
  try {
    await checkInstallDependenciesSkips(dir);
    checkVerificationInstallSkips(dir);
    await checkRealInstallStillRunsWithPackageJson(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  summarise(counts);
}

main();
