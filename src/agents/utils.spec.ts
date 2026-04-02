import * as path from 'path';
import { resolveRepoBasePath } from './utils';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

const { existsSync } = jest.requireMock('fs');

describe('resolveRepoBasePath', () => {
  let cwdSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/tmp/current-app');
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    existsSync.mockReset();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('returns cwd when repo is omitted', () => {
    expect(resolveRepoBasePath()).toBe('/tmp/current-app');
  });

  it('resolves an existing relative repo path from cwd', () => {
    const repoPath = path.resolve('/tmp/current-app', 'repo-a');
    existsSync.mockImplementation((input) => String(input) === repoPath);

    expect(resolveRepoBasePath('repo-a')).toBe(repoPath);
  });

  it('resolves a long-format repo via the repo-name sibling when the full token is not a local path', () => {
    const repoPath = path.resolve('/tmp', 'repo-a');
    existsSync.mockImplementation(
      (input) =>
        String(input) === repoPath &&
        !String(input).includes(path.join('current-app', 'workspace')),
    );

    expect(resolveRepoBasePath('workspace/repo-a')).toBe(repoPath);
  });

  it('prefers an exact local workspace/repo path when it exists', () => {
    const exactPath = path.resolve('/tmp/current-app', 'workspace/repo-a');
    existsSync.mockImplementation((input) => String(input) === exactPath);

    expect(resolveRepoBasePath('workspace/repo-a')).toBe(exactPath);
  });

  it('falls back to cwd and warns when neither full nor repo-name paths exist', () => {
    existsSync.mockReturnValue(false);

    expect(resolveRepoBasePath('workspace/repo-a')).toBe('/tmp/current-app');
    expect(consoleLogSpy).toHaveBeenCalled();
  });
});
