import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectWfArtifactFiles } from './collect-wf-artifact-files';
import { createTempDir as createManagedTempDir } from '../testing/temp-dir';

describe('collectWfArtifactFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createManagedTempDir('collect');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns files from every nesting depth', () => {
    fs.writeFileSync(path.join(tempDir, 'root.md'), 'root');
    fs.mkdirSync(path.join(tempDir, 'nested'));
    fs.writeFileSync(path.join(tempDir, 'nested', 'child.md'), 'child');
    fs.mkdirSync(path.join(tempDir, 'nested', 'deeper'));
    fs.writeFileSync(path.join(tempDir, 'nested', 'deeper', 'grandchild.md'), 'grandchild');

    const files = collectWfArtifactFiles(tempDir, () => true).sort();

    expect(files.sort()).toEqual(
      [
        path.join(tempDir, 'root.md'),
        path.join(tempDir, 'nested', 'child.md'),
        path.join(tempDir, 'nested', 'deeper', 'grandchild.md'),
      ].sort()
    );
  });

  it('filters results using the includeFile predicate', () => {
    fs.writeFileSync(path.join(tempDir, 'keep.md'), 'keep');
    fs.writeFileSync(path.join(tempDir, 'skip.txt'), 'skip');

    const files = collectWfArtifactFiles(tempDir, (_filePath, fileName) => fileName.endsWith('.md'));

    expect(files).toEqual([path.join(tempDir, 'keep.md')]);
  });

  it('skips entries that are neither files nor directories', () => {
    fs.writeFileSync(path.join(tempDir, 'real.md'), 'real');
    const symlinkPath = path.join(tempDir, 'broken-link.md');
    fs.symlinkSync(path.join(tempDir, 'nonexistent-target'), symlinkPath);

    const files = collectWfArtifactFiles(tempDir, () => true);

    expect(files).toEqual([path.join(tempDir, 'real.md')]);
  });

  it('returns [] for an unreadable root directory without exiting the process', () => {
    const missingDir = path.join(tempDir, 'does-not-exist');
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const files = collectWfArtifactFiles(missingDir, () => true);

    expect(files).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
