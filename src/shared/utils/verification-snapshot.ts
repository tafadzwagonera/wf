import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKTREE_PREFIX = 'wf-verify-';
const MARKER_NAME = '.wf-verification-marker.json';
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

const gitEnv = ((): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_INDEX_FILE'];
  delete env['GIT_WORK_TREE'];
  return env;
})();

export interface VerificationSnapshot {
  worktreePath: string;
  repositoryHead: string;
  cleanup: () => string[];
}

export type VerificationSnapshotResult = VerificationSnapshot | { status: 'not-run'; reason: string };

export interface VerificationSnapshotOptions {
  repoDir: string;
  diff: string;
  invocationId: string;
}

const commandError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const worktreePathFor = (repoDir: string, invocationId: string): string => {
  const repoHash = crypto.createHash('sha256').update(path.resolve(repoDir)).digest('hex').slice(0, 12);
  const suffix = crypto.randomBytes(6).toString('hex');
  return path.join(os.tmpdir(), `${WORKTREE_PREFIX}${repoHash}-${invocationId}-${suffix}`);
};

const removeWorktree = (repoDir: string, worktreePath: string, markerPath: string): string[] => {
  const errors: string[] = [];
  removeGitWorktree(repoDir, worktreePath, errors);
  removeWorktreeDirectory(worktreePath, markerPath, errors);
  pruneWorktrees(repoDir, errors);
  return errors;
};

const captureCleanupError = (errors: string[], operation: () => void): void => {
  try {
    operation();
  } catch (error) {
    errors.push(commandError(error));
  }
};

const removeGitWorktree = (repoDir: string, worktreePath: string, errors: string[]): void => {
  captureCleanupError(errors, () => execFileSync(
    'git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoDir, stdio: 'ignore', env: gitEnv },
  ));
};

const removeWorktreeDirectory = (worktreePath: string, markerPath: string, errors: string[]): void => {
  captureCleanupError(errors, () => {
    fs.rmSync(markerPath, { force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });
};

const pruneWorktrees = (repoDir: string, errors: string[]): void => {
  captureCleanupError(errors, () => execFileSync('git', ['worktree', 'prune'], { cwd: repoDir, stdio: 'ignore', env: gitEnv }));
};

const removePatchFile = (patchPath: string): void => {
  try {
    fs.rmSync(patchPath, { force: true });
  } catch {
    return;
  }
};

const listedWorktrees = (repoDir: string): string[] => execFileSync(
  'git', ['worktree', 'list', '--porcelain'], { cwd: repoDir, encoding: 'utf-8', env: gitEnv },
).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));

const isExpiredSnapshot = (repoDir: string, worktreePath: string): boolean => {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(worktreePath, MARKER_NAME), 'utf-8')) as {
      createdAt?: string;
      sourceRepositoryPath?: string;
    };
    return marker.sourceRepositoryPath === path.resolve(repoDir)
      && typeof marker.createdAt === 'string'
      && Date.now() - new Date(marker.createdAt).getTime() > STALE_AFTER_MS;
  } catch {
    return false;
  }
};

export const cleanStaleVerificationWorktrees = (repoDir: string): void => {
  let worktrees: string[];
  try {
    worktrees = listedWorktrees(repoDir);
  } catch {
    return;
  }
  for (const worktreePath of worktrees) {
    if (!path.basename(worktreePath).startsWith(WORKTREE_PREFIX) || !isExpiredSnapshot(repoDir, worktreePath)) continue;
    removeWorktree(repoDir, worktreePath, path.join(worktreePath, MARKER_NAME));
  }
};

export const createVerificationSnapshot = (options: VerificationSnapshotOptions): VerificationSnapshotResult => {
  const { repoDir, diff, invocationId } = options;
  const repositoryHead = resolveRepositoryHead(repoDir);
  if ('status' in repositoryHead) return repositoryHead;
  return materializeSnapshot(repoDir, diff, invocationId, repositoryHead.repositoryHead);
};

const resolveRepositoryHead = (repoDir: string): { repositoryHead: string } | { status: 'not-run'; reason: string } => {
  try {
    const repositoryHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv,
    }).trim();
    return { repositoryHead };
  } catch (error) {
    return { status: 'not-run', reason: `Could not resolve repository HEAD: ${commandError(error)}` };
  }
};

const materializeSnapshot = (
  repoDir: string, diff: string, invocationId: string, repositoryHead: string
): VerificationSnapshotResult => {
  const worktreePath = worktreePathFor(repoDir, invocationId);
  const patchPath = path.join(os.tmpdir(), `${WORKTREE_PREFIX}${invocationId}-${crypto.randomUUID()}.patch`);
  const markerPath = path.join(worktreePath, MARKER_NAME);
  try {
    applySnapshot(repoDir, worktreePath, repositoryHead, patchPath, diff, invocationId);
  } catch (error) {
    return snapshotFailure(repoDir, worktreePath, markerPath, patchPath, error);
  }
  removePatchFile(patchPath);
  return successfulSnapshot(repoDir, worktreePath, repositoryHead, markerPath);
};

const successfulSnapshot = (
  repoDir: string, worktreePath: string, repositoryHead: string, markerPath: string
): VerificationSnapshot => ({
  worktreePath, repositoryHead, cleanup: () => removeWorktree(repoDir, worktreePath, markerPath),
});

const applySnapshot = (
  repoDir: string, worktreePath: string, repositoryHead: string,
  patchPath: string, diff: string, invocationId: string
): void => {
  execFileSync('git', ['worktree', 'add', '--detach', worktreePath, repositoryHead], {
    cwd: repoDir, stdio: 'ignore', env: gitEnv,
  });
  fs.writeFileSync(path.join(worktreePath, MARKER_NAME), JSON.stringify({
    invocationId, createdAt: new Date().toISOString(), sourceRepositoryPath: path.resolve(repoDir),
  }));
  fs.writeFileSync(patchPath, diff);
  execFileSync('git', ['apply', '--3way', patchPath], { cwd: worktreePath, stdio: 'ignore', env: gitEnv });
};

const snapshotFailure = (
  repoDir: string, worktreePath: string, markerPath: string, patchPath: string, error: unknown
): VerificationSnapshotResult => {
  const cleanupErrors = removeWorktree(repoDir, worktreePath, markerPath);
  removePatchFile(patchPath);
  const cleanupDetail = cleanupErrors.length ? ` Cleanup failed: ${cleanupErrors.join('; ')}` : '';
  return { status: 'not-run', reason: `Could not materialize reviewed diff: ${commandError(error)}.${cleanupDetail}` };
};
