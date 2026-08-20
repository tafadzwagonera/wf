import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import chalk from 'chalk';
import { runPostPullDependencyInstall } from './post-pull-install';
import { detectPackageManager } from './detect-repo-conventions';
import { isProcessAlive } from './repo-lock';

const VERIFY_SCRIPT_NAMES = ['lint', 'typecheck', 'test'];
const WORKTREE_PREFIX = 'wf-verify-';
const WORKTREE_STALE_AFTER_MS = 4 * 60 * 60 * 1000;

export interface PreReviewVerificationOptions {
  silent?: boolean;
  skipVerification?: boolean;
}

const worktreeName = (repoDir: string): string => {
  const hash = crypto.createHash('sha256').update(path.resolve(repoDir)).digest('hex').slice(0, 12);
  return `${WORKTREE_PREFIX}${hash}-${process.pid}`;
};

export const getVerificationWorktreePath = (repoDir: string): string =>
  path.join(os.tmpdir(), worktreeName(repoDir));

const createVerificationWorktree = (repoDir: string): string => {
  const wtPath = getVerificationWorktreePath(repoDir);
  execSync(`git worktree add --detach ${JSON.stringify(wtPath)}`, {
    cwd: repoDir, stdio: 'ignore',
  });
  return wtPath;
};

const removeVerificationWorktree = (repoDir: string, wtPath: string): void => {
  try {
    execSync(`git worktree remove --force ${JSON.stringify(wtPath)}`, {
      cwd: repoDir, stdio: 'ignore',
    });
  } catch { /* fall through to cleanup */ }
  try {
    fs.rmSync(wtPath, { recursive: true, force: true });
  } finally {
    try {
      execSync('git worktree prune', { cwd: repoDir, stdio: 'ignore' });
    } catch { /* best-effort */ }
  }
};

const listVerificationWorktrees = (repoDir: string): string[] => {
  const output = execSync('git worktree list --porcelain', {
    cwd: repoDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  return output
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
    .filter(wt => path.basename(wt).startsWith(WORKTREE_PREFIX));
};

const extractWorktreePid = (wtPath: string): number | null => {
  const match = /-(\d+)$/.exec(path.basename(wtPath));
  return match ? Number(match[1]) : null;
};

const isWorktreeStale = (wtPath: string): boolean => {
  const pid = extractWorktreePid(wtPath);
  if (pid === null || !isProcessAlive(pid)) return true;
  try {
    return Date.now() - fs.statSync(wtPath).ctimeMs > WORKTREE_STALE_AFTER_MS;
  } catch {
    return true;
  }
};

export const cleanStaleVerificationWorktrees = (repoDir: string): void => {
  let candidates: string[];
  try {
    candidates = listVerificationWorktrees(repoDir);
  } catch {
    return;
  }
  for (const wtPath of candidates) {
    if (isWorktreeStale(wtPath)) removeVerificationWorktree(repoDir, wtPath);
  }
};

const linkVerificationNodeModules = (repoDir: string, wtPath: string): void => {
  const source = path.join(repoDir, 'node_modules');
  if (!fs.existsSync(source)) return;
  try {
    fs.symlinkSync(source, path.join(wtPath, 'node_modules'), 'dir');
  } catch { /* best-effort — verification falls back to running without deps */ }
};

const availableVerifyCommands = (repoDir: string, pm: string): string[] => {
  const pkgPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    return VERIFY_SCRIPT_NAMES
      .filter(name => name in (pkg.scripts ?? {}))
      .map(name => `${pm} run ${name}`);
  } catch {
    return [];
  }
};

const runVerifyCommand = (command: string, cwd: string): { command: string; failed: boolean } => {
  try {
    execSync(command, { cwd, stdio: 'ignore' });
    return { command, failed: false };
  } catch {
    return { command, failed: true };
  }
};

const runVerificationInWorktree = async (
  wtPath: string, options: PreReviewVerificationOptions
): Promise<string> => {
  await runPostPullDependencyInstall(wtPath);
  const pm = detectPackageManager(wtPath);
  const commands = availableVerifyCommands(wtPath, pm);
  if (commands.length === 0) return '';
  if (!options.silent) console.log(chalk.gray(`  Running pre-review verification (${pm})...`));
  const results = commands.map(cmd => runVerifyCommand(cmd, wtPath));
  const lines = results.map(r => `  ${r.failed ? '✗' : '✓'} ${r.command}`);
  return `Pre-review verification:\n${lines.join('\n')}`;
};

const tryCreateWorktree = (repoDir: string, silent?: boolean): string | null => {
  try {
    return createVerificationWorktree(repoDir);
  } catch {
    if (!silent) {
      console.log(chalk.yellow(
        '  ⚠ Could not create verification worktree; skipping pre-review verification',
      ));
    }
    return null;
  }
};

export const runPreReviewVerification = async (
  repoDir: string, options: PreReviewVerificationOptions = {}
): Promise<string> => {
  if (options.skipVerification) return '';
  cleanStaleVerificationWorktrees(repoDir);
  const wtPath = tryCreateWorktree(repoDir, options.silent);
  if (!wtPath) return '';
  linkVerificationNodeModules(repoDir, wtPath);
  try {
    return await runVerificationInWorktree(wtPath, options);
  } finally {
    removeVerificationWorktree(repoDir, wtPath);
  }
};
