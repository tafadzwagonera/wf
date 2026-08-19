import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { RepoLockError } from './errors';
import { getWfStateDir } from './wf-paths';

interface RepoLockPayload {
  pid: number;
  repoDir: string;
  startedAt: string;
}

const REPO_LOCK_STALE_AFTER_MS = 4 * 60 * 60 * 1000;

const getLockDir = (): string => path.join(getWfStateDir(), 'locks');

const getLockPath = (repoDir: string): string => {
  const resolved = path.resolve(repoDir);
  const key = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return path.join(getLockDir(), `${key}.lock`);
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readLockPayload = (lockPath: string): RepoLockPayload | undefined => {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  } catch {
    return undefined;
  }
};

const isLockStale = (payload: RepoLockPayload | undefined): boolean => {
  if (!payload || typeof payload.pid !== 'number') return true;
  if (!isProcessAlive(payload.pid)) return true;
  return Date.now() - Date.parse(payload.startedAt) > REPO_LOCK_STALE_AFTER_MS;
};

const describeLockHolder = (payload: RepoLockPayload | undefined, lockPath: string): string => {
  if (!payload) return `Lock file: ${lockPath}`;
  return `Held by pid ${payload.pid} since ${payload.startedAt} for ${payload.repoDir}.\nLock file: ${lockPath}`;
};

const buildLockPayload = (repoDir: string): string =>
  JSON.stringify({ pid: process.pid, repoDir: path.resolve(repoDir), startedAt: new Date().toISOString() });

const writeLockExclusive = (lockPath: string, payload: string): boolean => {
  try {
    fs.writeFileSync(lockPath, payload, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  }
};

/**
 * Write the lock file at `lockPath` exclusively. If one already exists and is
 * still live (see {@link isLockStale}), throw; otherwise clear it and retry once.
 *
 * @param lockPath - Absolute path to the lock file
 * @param repoDir - Repository directory the lock protects (recorded in the payload)
 * @throws RepoLockError when a live, non-stale lock is already held
 */
const writeLockOrThrow = (lockPath: string, repoDir: string): void => {
  const payload = buildLockPayload(repoDir);
  if (writeLockExclusive(lockPath, payload)) return;

  const existing = readLockPayload(lockPath);
  if (!isLockStale(existing)) {
    throw new RepoLockError(
      'Another wf workflow is already running against this repository.',
      describeLockHolder(existing, lockPath)
    );
  }

  fs.rmSync(lockPath, { force: true });
  fs.writeFileSync(lockPath, payload, { flag: 'wx' });
};

/**
 * Run `fn` while holding an exclusive lock scoped to `repoDir`, so a second
 * wf workflow started against the same repository fails fast instead of
 * racing this one's git operations. The lock is a file under the wf state
 * directory (outside the target repo, so it is never a candidate for
 * staging/committing), keyed by the repo's resolved absolute path.
 *
 * A lock left behind by a crashed process is treated as stale — and cleared
 * automatically — once its pid is no longer running or it is older than
 * {@link REPO_LOCK_STALE_AFTER_MS}.
 *
 * @param repoDir - Repository directory the workflow will mutate
 * @param fn - Work to run while the lock is held
 * @returns Whatever `fn` resolves to
 * @throws RepoLockError when a live lock for `repoDir` is already held
 */
export async function withRepoLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = getLockPath(repoDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  writeLockOrThrow(lockPath, repoDir);

  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}
