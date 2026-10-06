import * as fs from 'fs';
import * as path from 'path';

type SyncStatus = 'linked' | 'relinked' | 'ok';

interface SyncLinkOptions {
  source: string;
  destination: string;
}

const lstatOrNull = async (target: string): Promise<fs.Stats | null> => {
  try {
    return await fs.promises.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const assertIsSymlink = (stats: fs.Stats, { source, destination }: SyncLinkOptions): void => {
  if (stats.isSymbolicLink()) return;
  throw new Error(
    `${destination} is a real file or directory, not a symlink. `
    + `Verify it matches ${source}, then remove it manually and re-run.`,
  );
};

export const assertLinkable = async (options: SyncLinkOptions): Promise<void> => {
  const stats = await lstatOrNull(options.destination);
  if (!stats) return;
  assertIsSymlink(stats, options);
};

export const syncLink = async (options: SyncLinkOptions): Promise<SyncStatus> => {
  const { source, destination } = options;
  const stats = await lstatOrNull(destination);
  if (!stats) {
    await fs.promises.symlink(source, destination, 'dir');
    return 'linked';
  }
  assertIsSymlink(stats, options);
  const currentTarget = path.resolve(path.dirname(destination), await fs.promises.readlink(destination));
  if (currentTarget === path.resolve(source)) return 'ok';
  await fs.promises.unlink(destination);
  await fs.promises.symlink(source, destination, 'dir');
  return 'relinked';
};

export type { SyncStatus, SyncLinkOptions };
