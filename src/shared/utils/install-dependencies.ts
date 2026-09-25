import { execSync, spawnSync } from 'child_process';
import { detectPackageManager } from './detect-repo-conventions';
import type { PackageManager } from './detect-repo-conventions';
import type { VerificationCommandResult } from './review-verification.types';

const INSTALL_COMMANDS: Record<PackageManager, string> = {
  bun: 'bun install',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
  npm: 'npm ci',
};

const INSTALL_ARGUMENTS: Record<PackageManager, string[]> = {
  bun: ['install'],
  pnpm: ['install', '--frozen-lockfile'],
  yarn: ['install', '--frozen-lockfile'],
  npm: ['ci'],
};

export type DependencyInstallResult
  = | { packageManager: PackageManager; success: true }
    | { packageManager: PackageManager; success: false; warning: string };

export interface VerificationDependencyInstallResult {
  packageManager?: PackageManager;
  result: VerificationCommandResult;
}

export interface VerificationCommandOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

const isPackageManagerAvailable = (packageManager: PackageManager): boolean => {
  try {
    execSync(`command -v ${packageManager} >/dev/null 2>&1`, { shell: '/bin/sh', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const runInstall = (
  packageManager: PackageManager, installCmd: string, repoDir: string
): DependencyInstallResult => {
  try {
    // No timeout — a cut-off install leaves node_modules in an inconsistent state.
    execSync(installCmd, { cwd: repoDir, stdio: 'inherit' });
    return { packageManager, success: true };
  } catch (err) {
    return {
      packageManager,
      success: false,
      warning: `Dependency install (${installCmd}) failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

// Declared async so callers can `await` it uniformly; the install itself runs via execSync.
export const installDependencies = async (repoDir: string): Promise<DependencyInstallResult> => {
  const packageManager = detectPackageManager(repoDir);

  if (!isPackageManagerAvailable(packageManager)) {
    return {
      packageManager,
      success: false,
      warning: `${packageManager} is not available on PATH; skipping dependency install`,
    };
  }

  return runInstall(packageManager, INSTALL_COMMANDS[packageManager], repoDir);
};

const boundedOutput = (value: string | Buffer | undefined, maxOutputBytes: number): string | undefined => {
  if (value === undefined) return undefined;
  const text = value.toString();
  return text.length > maxOutputBytes ? text.slice(0, maxOutputBytes) : text;
};

const durationSince = (startedAt: number): number => Date.now() - startedAt;

const commandOptions = (repoDir: string, options: VerificationCommandOptions) => ({
  cwd: repoDir, encoding: 'utf-8' as const, timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes,
});

const unavailableInstallResult = (
  packageManager: PackageManager, command: string, startedAt: number,
  result: ReturnType<typeof spawnSync>, maxOutputBytes: number
): VerificationDependencyInstallResult => ({
  packageManager,
  result: {
    command,
    status: 'not-run',
    durationMs: durationSince(startedAt),
    exitCode: result.status ?? undefined,
    signal: result.signal ?? undefined,
    output: boundedOutput(result.stderr, maxOutputBytes),
    reason: result.error?.message ?? `${packageManager} is not available on PATH`,
  },
});

const installResult = (
  packageManager: PackageManager, command: string, startedAt: number,
  result: ReturnType<typeof spawnSync>, maxOutputBytes: number
): VerificationDependencyInstallResult => {
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    || result.signal === 'SIGTERM';
  const succeeded = result.status === 0 && !result.error;
  return verificationInstallResult(packageManager, command, startedAt, result, maxOutputBytes, succeeded, timedOut);
};

const installFailureReason = (result: ReturnType<typeof spawnSync>, timedOut: boolean): string => {
  if (timedOut) return 'Dependency install timed out';
  return result.error?.message ?? 'Dependency install failed';
};

const verificationInstallResult = (packageManager: PackageManager, command: string, startedAt: number, result: ReturnType<typeof spawnSync>, maxOutputBytes: number, succeeded: boolean, timedOut: boolean): VerificationDependencyInstallResult => ({ packageManager, result: { command, status: succeeded ? 'passed' : 'not-run', durationMs: durationSince(startedAt), exitCode: result.status ?? undefined, signal: result.signal ?? undefined, output: boundedOutput([result.stdout, result.stderr].filter(Boolean).join(''), maxOutputBytes), reason: succeeded ? undefined : installFailureReason(result, timedOut) } });

export const runDependencyInstallForVerification = (
  repoDir: string, options: VerificationCommandOptions
): VerificationDependencyInstallResult => {
  const packageManager = detectPackageManager(repoDir);
  const command = `${packageManager} ${INSTALL_ARGUMENTS[packageManager].join(' ')}`;
  const startedAt = Date.now();
  const availability = spawnSync(packageManager, ['--version'], commandOptions(repoDir, options));
  if (availability.error || availability.status !== 0) {
    return unavailableInstallResult(packageManager, command, startedAt, availability, options.maxOutputBytes);
  }
  const installStartedAt = Date.now();
  const install = spawnSync(packageManager, INSTALL_ARGUMENTS[packageManager], commandOptions(repoDir, options));
  return installResult(packageManager, command, installStartedAt, install, options.maxOutputBytes);
};
