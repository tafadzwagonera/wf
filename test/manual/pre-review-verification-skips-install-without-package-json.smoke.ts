/**
 * Manual smoke test: review-stage verification reports a clean not-run, not a raw npm error, for non-Node repos
 *
 * Run: nr test:manual pre-review-verification-skips-install-without-package-json.smoke.ts
 *
 * Scenario: `runPreReviewVerification` renders `ReviewVerification` text into the
 * review output shown to the user/PR comment. In a Terraform repo, the raw
 * `npm ci` ENOENT stderr used to leak into that rendered text via
 * `dependencyInstall.output`. After the fix, the install step is skipped before
 * any process spawns, so the returned verification carries a clean "not-run:
 * No package.json found; skipping dependency install" reason with no npm stack
 * trace in the output field.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { runPreReviewVerification } from '../../src/common/utils/run-pre-review-verification';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

function buildNoopDiff(dir: string): string {
  fs.appendFileSync(path.join(dir, 'main.tf'), '# noop\n');
  const diff = execSync('git diff', { cwd: dir, encoding: 'utf-8' });
  execSync('git checkout -- main.tf', { cwd: dir });
  return diff;
}

function assertVerificationSkippedInstall(verification: Awaited<ReturnType<typeof runPreReviewVerification>>): void {
  assert('ReviewVerification.status is not-run', verification.status === 'not-run', verification.status);
  assert(
    'dependencyInstall.status is not-run with the exact skip reason',
    verification.dependencyInstall?.status === 'not-run'
    && verification.dependencyInstall?.reason === 'No package.json found; skipping dependency install',
    JSON.stringify(verification.dependencyInstall),
  );
  assert(
    'dependencyInstall.output is undefined (no process ever spawned)',
    verification.dependencyInstall?.output === undefined,
    JSON.stringify(verification.dependencyInstall?.output),
  );
}

async function checkVerificationSkipsInstall(dir: string): Promise<void> {
  const diff = buildNoopDiff(dir);
  const verification = await runPreReviewVerification(dir, { diff, silent: true });
  assertVerificationSkippedInstall(verification);
}

function checkNoInstallArtifacts(dir: string): void {
  const nodeModulesExists = fs.existsSync(path.join(dir, 'node_modules'));
  assert('no node_modules directory was created in the repo', nodeModulesExists === false);
}

function initGitRepoWithTerraformFile(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "null_resource" "x" {}\n');
  execSync('git add main.tf', { cwd: dir });
  execSync('git commit -q -m "initial"', { cwd: dir });
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nPre-review verification skip-install-without-package-json smoke test\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-verify-skip-'));
  initGitRepoWithTerraformFile(dir);
  try {
    await checkVerificationSkipsInstall(dir);
    checkNoInstallArtifacts(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  summarise(counts);
}

main();
