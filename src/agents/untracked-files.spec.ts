import * as fs from 'node:fs';
import { collectUntrackedFiles, readUntrackedFile } from './untracked-files';
import type { GitService } from '../integrations/git/git.service';

jest.mock('node:fs');

const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;

const createMockGitService = (notAdded: string[]): GitService =>
  ({ getStatus: jest.fn().mockResolvedValue({ not_added: notAdded }) }) as unknown as GitService;

afterEach(() => {
  jest.restoreAllMocks();
  mockReadFileSync.mockReset();
});

describe('readUntrackedFile', () => {
  it('returns the file content for a text file', () => {
    mockReadFileSync.mockReturnValue(Buffer.from('#!/bin/sh\necho hi\n'));

    expect(readUntrackedFile('/repo', 'scripts/new.sh')).toEqual({
      path: 'scripts/new.sh',
      content: '#!/bin/sh\necho hi\n',
      binary: false,
    });
  });

  it('marks a file containing NUL bytes as binary with a placeholder', () => {
    mockReadFileSync.mockReturnValue(Buffer.from([0x89, 0x50, 0x00, 0x47]));

    expect(readUntrackedFile('/repo', 'logo.png')).toEqual({
      path: 'logo.png',
      content: '[binary file, 4 bytes]',
      binary: true,
    });
  });
});

describe('collectUntrackedFiles', () => {
  it('reads every untracked path reported by git status', async () => {
    mockReadFileSync.mockReturnValue(Buffer.from('content'));

    const files = await collectUntrackedFiles(createMockGitService(['a.ts', 'b.ts']), '/repo');

    expect(files.map(file => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it('skips files that cannot be read and keeps the rest', async () => {
    mockReadFileSync
      .mockImplementationOnce(() => { throw new Error('EACCES'); })
      .mockReturnValueOnce(Buffer.from('ok'));

    const files = await collectUntrackedFiles(createMockGitService(['bad.ts', 'good.ts']), '/repo');

    expect(files.map(file => file.path)).toEqual(['good.ts']);
  });

  it('returns an empty list when git status fails', async () => {
    const gitService = { getStatus: jest.fn().mockRejectedValue(new Error('not a repo')) } as unknown as GitService;

    expect(await collectUntrackedFiles(gitService, '/repo')).toEqual([]);
    expect(gitService.getStatus).toHaveBeenCalledWith('/repo');
  });
});
