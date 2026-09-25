import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import chalk from 'chalk';
import { appendToLogFile } from '../logger/log-file-writer';
import { runDependencyInstallForVerification } from './install-dependencies';
import { cleanStaleVerificationWorktrees, createVerificationSnapshot } from './verification-snapshot';
import type { ReviewVerification, VerificationCommandResult } from './review-verification.types';

const VERIFY_SCRIPT_NAMES = ['lint', 'typecheck', 'test'];
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024;

export interface PreReviewVerificationOptions {
  diff: string;
  silent?: boolean;
  skipVerification?: boolean;
}

const notRun = (reason: string, source: ReviewVerification['source'] = 'reviewed-diff'): ReviewVerification => ({
  status: 'not-run', source, checks: [], reason,
});

const logEvent = (event: string, fields: Record<string, unknown>): void => {
  appendToLogFile('INFO', JSON.stringify({ event, ...fields }), 'review-verification');
};

const availableScripts = (repoDir: string): string[] => {
  try {
    const pkg = JSON.parse(fs.readFileSync(`${repoDir}/package.json`, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    return VERIFY_SCRIPT_NAMES.filter(name => Boolean(pkg.scripts?.[name]));
  } catch {
    return [];
  }
};

const boundedOutput = (value: string | Buffer | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const text = value.toString();
  return text.length > MAX_OUTPUT_BYTES ? text.slice(0, MAX_OUTPUT_BYTES) : text;
};

const checkFailureReason = (result: ReturnType<typeof spawnSync>, timedOut: boolean): string => {
  if (timedOut) return 'Verification check timed out';
  return result.error?.message ?? 'Verification check failed';
};

const checkResult = (
  command: string, startedAt: number, result: ReturnType<typeof spawnSync>
): VerificationCommandResult => {
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  const succeeded = result.status === 0 && !result.error;
  return { command, status: succeeded ? 'passed' : 'failed', durationMs: Date.now() - startedAt,
    exitCode: result.status ?? undefined, signal: result.signal ?? undefined,
    output: boundedOutput([result.stdout, result.stderr].filter(Boolean).join('')),
    reason: succeeded ? undefined : checkFailureReason(result, timedOut) };
};

const runCheck = (packageManager: string, script: string, cwd: string): VerificationCommandResult => {
  const command = `${packageManager} run ${script}`;
  const startedAt = Date.now();
  const result = spawnSync(packageManager, ['run', script], {
    cwd, encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  });
  return checkResult(command, startedAt, result);
};

export const runPreReviewVerification = async (
  repoDir: string, options: PreReviewVerificationOptions
): Promise<ReviewVerification> => {
  if (options.skipVerification) return notRun('Verification was skipped with --skip-verification.');
  return verifyReviewedDiff(repoDir, options);
};

const verifyReviewedDiff = (repoDir: string, options: PreReviewVerificationOptions): ReviewVerification => {
  cleanStaleVerificationWorktrees(repoDir);
  const invocationId = crypto.randomUUID();
  logEvent('review-verification.started', { invocationId, repositoryPath: repoDir });
  const snapshot = createVerificationSnapshot({ repoDir, diff: options.diff, invocationId });
  if ('status' in snapshot) {
    return snapshotFailure(snapshot.reason, invocationId, repoDir);
  }
  const base = verificationLogContext(invocationId, repoDir, snapshot);
  try {
    return verifySnapshot(snapshot, options, base);
  } finally {
    logCleanupFailures(snapshot.cleanup(), base);
  }
};

const snapshotFailure = (reason: string, invocationId: string, repositoryPath: string): ReviewVerification => {
  logEvent('review-verification.snapshot-failed', { invocationId, repositoryPath, reason });
  return notRun(reason);
};

const verificationLogContext = (invocationId: string, repositoryPath: string, snapshot: Exclude<ReturnType<typeof createVerificationSnapshot>, { status: 'not-run' }>): Record<string, unknown> => ({ invocationId, repositoryPath, repositoryHead: snapshot.repositoryHead, worktreePath: snapshot.worktreePath });

const logCleanupFailures = (errors: string[], base: Record<string, unknown>): void => {
  for (const reason of errors) logEvent('review-verification.cleanup-failed', { ...base, reason });
};

const verifySnapshot = (
  snapshot: Exclude<ReturnType<typeof createVerificationSnapshot>, { status: 'not-run' }>,
  options: PreReviewVerificationOptions, base: Record<string, unknown>
): ReviewVerification => {
  const install = runDependencyInstallForVerification(snapshot.worktreePath, {
    timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  logEvent('review-verification.install-completed', { ...base, packageManager: install.packageManager, ...install.result });
  if (install.result.status !== 'passed') return completeBlockedVerification(snapshot, install, base);
  const checks = runChecks(snapshot.worktreePath, install.packageManager as string, options, base);
  const failedCheck = checks.find(check => check.status === 'failed');
  const verification = completedVerification(snapshot, install, checks, failedCheck);
  logEvent('review-verification.completed', { ...base, ...verification });
  return verification;
};

const completedVerification = (snapshot: Exclude<ReturnType<typeof createVerificationSnapshot>, { status: 'not-run' }>, install: ReturnType<typeof runDependencyInstallForVerification>, checks: VerificationCommandResult[], failedCheck: VerificationCommandResult | undefined): ReviewVerification => ({ status: failedCheck ? 'failed' : 'passed', source: 'reviewed-diff', repositoryHead: snapshot.repositoryHead, packageManager: install.packageManager, dependencyInstall: install.result, checks, reason: failedCheck?.reason });

const completeBlockedVerification = (
  snapshot: Exclude<ReturnType<typeof createVerificationSnapshot>, { status: 'not-run' }>,
  install: ReturnType<typeof runDependencyInstallForVerification>, base: Record<string, unknown>
): ReviewVerification => {
  const verification = {
    ...notRun(install.result.reason ?? 'Dependency install did not complete.'),
    repositoryHead: snapshot.repositoryHead,
    packageManager: install.packageManager,
    dependencyInstall: install.result,
  };
  logEvent('review-verification.completed', { ...base, ...verification });
  return verification;
};

const runChecks = (
  worktreePath: string, packageManager: string, options: PreReviewVerificationOptions,
  base: Record<string, unknown>
): VerificationCommandResult[] => {
  const scripts = availableScripts(worktreePath);
  printVerificationStart(options, scripts, packageManager);
  const checks: VerificationCommandResult[] = [];
  for (const script of scripts) {
    const check = runCheck(packageManager, script, worktreePath);
    checks.push(check);
    logEvent('review-verification.check-completed', { ...base, ...check });
    if (check.status !== 'passed') break;
  }
  return checks;
};

const printVerificationStart = (
  options: PreReviewVerificationOptions, scripts: string[], packageManager: string
): void => {
  if (!options.silent && scripts.length > 0) {
    console.log(chalk.gray(`  Running pre-review verification (${packageManager})...`));
  }
};

export { cleanStaleVerificationWorktrees };
