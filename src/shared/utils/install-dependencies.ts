import { execSync } from 'child_process';
import { detectPackageManager } from './detect-repo-conventions';
import type { PackageManager } from './detect-repo-conventions';

const INSTALL_COMMANDS: Record<PackageManager, string> = {
  bun: 'bun install',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
  npm: 'npm ci',
};

export type DependencyInstallResult
  = | { packageManager: PackageManager; success: true }
    | { packageManager: PackageManager; success: false; warning: string };

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
