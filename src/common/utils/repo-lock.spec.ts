import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { withRepoLock, releaseHeldRepoLocksSync } from './repo-lock';
import { RepoLockError } from './errors';
import { setWfPathOverrides, resetWfPathOverrides } from './wf-paths';

describe('withRepoLock', () => {
  let stateDir: string;
  let repoDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-state-'));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-repo-'));
    setWfPathOverrides({ stateDir });
  });

  afterEach(() => {
    resetWfPathOverrides();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('runs fn and returns its result when no lock is held', async () => {
    const result = await withRepoLock(repoDir, async () => 'done');
    expect(result).toBe('done');
  });

  it('releases the lock after fn resolves, so a second call succeeds', async () => {
    await withRepoLock(repoDir, async () => undefined);
    await expect(withRepoLock(repoDir, async () => 'second')).resolves.toBe('second');
  });

  it('releases the lock after fn throws, so a later call still succeeds', async () => {
    await expect(withRepoLock(repoDir, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    await expect(withRepoLock(repoDir, async () => 'after-failure')).resolves.toBe('after-failure');
  });

  it('throws RepoLockError when a live lock for the same repo is already held', async () => {
    const lockPath = findLockFile(stateDir);
    expect(lockPath).toBeUndefined();

    const holdLock = withRepoLock(repoDir, () => new Promise(resolve => setTimeout(resolve, 50)));

    await expect(withRepoLock(repoDir, async () => 'blocked')).rejects.toThrow(RepoLockError);
    await holdLock;
  });

  it('does not throw for a different repo directory while one repo is locked', async () => {
    const otherRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repo-lock-other-'));
    try {
      const holdLock = withRepoLock(repoDir, () => new Promise(resolve => setTimeout(resolve, 50)));

      await expect(withRepoLock(otherRepoDir, async () => 'unblocked')).resolves.toBe('unblocked');
      await holdLock;
    } finally {
      fs.rmSync(otherRepoDir, { recursive: true, force: true });
    }
  });

  it('treats a lock owned by a dead pid as stale and proceeds', async () => {
    const lockFilePath = writeRawLockFile(stateDir, repoDir, {
      pid: findUnusedPid(),
      repoDir: path.resolve(repoDir),
      startedAt: new Date().toISOString(),
    });

    await expect(withRepoLock(repoDir, async () => 'recovered')).resolves.toBe('recovered');
    expect(fs.existsSync(lockFilePath)).toBe(false);
  });

  it('treats a lock older than the staleness window as stale even if the pid is alive', async () => {
    const ancientTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeRawLockFile(stateDir, repoDir, {
      pid: process.pid,
      repoDir: path.resolve(repoDir),
      startedAt: ancientTimestamp,
    });

    await expect(withRepoLock(repoDir, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('releases any held locks synchronously when the process is about to exit (forced-exit safety net)', async () => {
    const holdLock = withRepoLock(repoDir, () => new Promise(resolve => setTimeout(resolve, 50)));
    const lockFileName = findLockFile(stateDir);
    if (!lockFileName) throw new Error('expected a lock file to exist while the lock is held');
    const lockPath = path.join(stateDir, 'locks', lockFileName);
    expect(fs.existsSync(lockPath)).toBe(true);

    process.emit('exit', 0);

    expect(fs.existsSync(lockPath)).toBe(false);
    await holdLock;
  });

  it('exposes releaseHeldRepoLocksSync as a no-op when no lock is held', () => {
    expect(() => releaseHeldRepoLocksSync()).not.toThrow();
  });

  it('treats a corrupted lock file as stale and proceeds', async () => {
    const lockDir = path.join(stateDir, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockFiles = fs.readdirSync(lockDir);
    expect(lockFiles).toHaveLength(0);

    // Pre-create a corrupted lock file at the exact path withRepoLock would use.
    const key = crypto.createHash('sha256').update(path.resolve(repoDir)).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(lockDir, `${key}.lock`), 'not json');

    await expect(withRepoLock(repoDir, async () => 'recovered')).resolves.toBe('recovered');
  });
});

function findLockFile(stateDir: string): string | undefined {
  const lockDir = path.join(stateDir, 'locks');
  if (!fs.existsSync(lockDir)) return undefined;
  return fs.readdirSync(lockDir)[0];
}

function writeRawLockFile(
  stateDir: string,
  repoDir: string,
  payload: { pid: number; repoDir: string; startedAt: string }
): string {
  const lockDir = path.join(stateDir, 'locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const key = crypto.createHash('sha256').update(path.resolve(repoDir)).digest('hex').slice(0, 16);
  const lockFilePath = path.join(lockDir, `${key}.lock`);
  fs.writeFileSync(lockFilePath, JSON.stringify(payload));
  return lockFilePath;
}

function findUnusedPid(): number {
  let candidate = 999_999;
  while (isPidRunning(candidate) && candidate > 2) {
    candidate -= 1;
  }
  return candidate;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
