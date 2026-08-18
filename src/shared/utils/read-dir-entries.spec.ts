import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDirEntries } from './read-dir-entries';
import { createTempDir as createManagedTempDir } from '../testing/temp-dir';

describe('readDirEntries', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createManagedTempDir('readdir');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns directory entries for a readable directory', () => {
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'content');

    const entries = readDirEntries(tempDir);

    expect(entries.map(entry => entry.name)).toEqual(['a.txt']);
  });

  it('returns [] for an unreadable directory without exiting the process', () => {
    const missingDir = path.join(tempDir, 'does-not-exist');
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const entries = readDirEntries(missingDir);

    expect(entries).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
