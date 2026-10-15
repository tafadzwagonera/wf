jest.mock('node:fs', () => ({
  existsSync: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repoDirCandidates, resolveExistingRepoDir } from './repo-resolution';
import { resetWfReposDirWarning } from './wf-paths';
import { restoreEnv, withEnv } from '../testing/env';

const cwd = '/work/app';
const reposDir = '/repos';

const probedPaths = (mockExistsSync: jest.MockedFunction<typeof fs.existsSync>): string[] =>
  mockExistsSync.mock.calls.map(call => String(call[0]));

describe('repo directory resolution', () => {
  let mockExistsSync: jest.MockedFunction<typeof fs.existsSync>;

  const existOnly = (...existing: string[]): void => {
    mockExistsSync.mockImplementation((candidate: fs.PathLike) => existing.includes(String(candidate)));
  };

  beforeEach(() => {
    mockExistsSync = jest.mocked(fs.existsSync);
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    withEnv({ WF_REPOS_DIR: reposDir });
  });

  afterEach(() => {
    resetWfReposDirWarning();
    restoreEnv();
    jest.restoreAllMocks();
  });

  describe('when listing candidates for a token', () => {
    it('orders cwd, sibling, then the repos base', () => {
      expect(repoDirCandidates('repo', cwd)).toEqual(['/work/app/repo', '/work/repo', '/repos/repo']);
    });

    it('probes every default base in order when WF_REPOS_DIR is unset', () => {
      withEnv({ WF_REPOS_DIR: undefined });

      const expectedBases = ['Apps', 'Projects', 'apps', 'projects'].map(name => path.join(os.homedir(), name, 'repo'));

      expect(repoDirCandidates('repo', cwd)).toEqual(['/work/app/repo', '/work/repo', ...expectedBases]);
    });

    it('places every full-token candidate before any segment candidate', () => {
      expect(repoDirCandidates('workspace/repo', cwd)).toEqual([
        '/work/app/workspace/repo',
        '/work/workspace/repo',
        '/repos/workspace/repo',
        '/work/app/repo',
        '/work/repo',
        '/repos/repo',
      ]);
    });

    it('uses the second segment of a three-segment token', () => {
      expect(repoDirCandidates('a/b/c', cwd)).toEqual([
        '/work/app/a/b/c',
        '/work/a/b/c',
        '/repos/a/b/c',
        '/work/app/b',
        '/work/b',
        '/repos/b',
      ]);
    });

    it('collapses an absolute token into the first candidate and normalises it', () => {
      expect(repoDirCandidates('/x/repo/', cwd)[0]).toBe('/x/repo');
    });

    it('does not retry a segment of an absolute token', () => {
      expect(repoDirCandidates('/home/u/gone', cwd)).toEqual(['/home/u/gone']);
    });

    it('removes duplicate candidates', () => {
      const candidates = repoDirCandidates('repo', '/repos');

      expect(candidates).toEqual([...new Set(candidates)]);
      expect(candidates).toEqual(['/repos/repo', '/repo']);
    });
  });

  describe('when resolving an existing directory', () => {
    it('resolves from the repos base when cwd and sibling miss', () => {
      existOnly('/repos/repo');

      const resolved = resolveExistingRepoDir('repo', cwd);

      expect(resolved).toBe('/repos/repo');
      expect(probedPaths(mockExistsSync)).toEqual(['/work/app/repo', '/work/repo', '/repos/repo']);
      expect(mockExistsSync).toHaveBeenCalledTimes(3);
    });

    it('lets the sibling win a name collision with the repos base', () => {
      existOnly('/work/repo', '/repos/repo');

      const resolved = resolveExistingRepoDir('repo', cwd);

      expect(resolved).toBe('/work/repo');
      expect(probedPaths(mockExistsSync)).toEqual(['/work/app/repo', '/work/repo']);
      expect(mockExistsSync).toHaveBeenCalledTimes(2);
    });

    it('prefers Apps over Projects when both default bases contain the token', () => {
      withEnv({ WF_REPOS_DIR: undefined });
      const apps = path.join(os.homedir(), 'Apps', 'repo');
      const projects = path.join(os.homedir(), 'Projects', 'repo');
      existOnly(apps, projects);

      const resolved = resolveExistingRepoDir('repo', cwd);

      expect(resolved).toBe(apps);
      expect(probedPaths(mockExistsSync)).toEqual(['/work/app/repo', '/work/repo', apps]);
      expect(mockExistsSync).toHaveBeenCalledTimes(3);
    });

    it('resolves a later default base when earlier ones do not contain the token', () => {
      withEnv({ WF_REPOS_DIR: undefined });
      const projects = path.join(os.homedir(), 'Projects', 'repo');
      existOnly(projects);

      const resolved = resolveExistingRepoDir('repo', cwd);

      expect(resolved).toBe(projects);
      expect(probedPaths(mockExistsSync)).toEqual([
        '/work/app/repo',
        '/work/repo',
        path.join(os.homedir(), 'Apps', 'repo'),
        projects,
      ]);
      expect(mockExistsSync).toHaveBeenCalledTimes(4);
    });

    it('resolves a workspace/repo token through the segment under a repos base', () => {
      existOnly('/repos/repo');

      const resolved = resolveExistingRepoDir('workspace/repo', cwd);

      expect(resolved).toBe('/repos/repo');
      expect(probedPaths(mockExistsSync)).toEqual([
        '/work/app/workspace/repo',
        '/work/workspace/repo',
        '/repos/workspace/repo',
        '/work/app/repo',
        '/work/repo',
        '/repos/repo',
      ]);
      expect(mockExistsSync).toHaveBeenCalledTimes(6);
    });

    it('prefers the full workspace/repo path over the segment fallback', () => {
      existOnly('/repos/workspace/repo', '/work/repo');

      const resolved = resolveExistingRepoDir('workspace/repo', cwd);

      expect(resolved).toBe('/repos/workspace/repo');
      expect(probedPaths(mockExistsSync)).toEqual([
        '/work/app/workspace/repo',
        '/work/workspace/repo',
        '/repos/workspace/repo',
      ]);
      expect(mockExistsSync).toHaveBeenCalledTimes(3);
    });

    it('resolves the second segment of a three-segment token', () => {
      existOnly('/repos/b', '/repos/c');

      const resolved = resolveExistingRepoDir('a/b/c', cwd);

      expect(resolved).toBe('/repos/b');
      expect(probedPaths(mockExistsSync)).toEqual([
        '/work/app/a/b/c',
        '/work/a/b/c',
        '/repos/a/b/c',
        '/work/app/b',
        '/work/b',
        '/repos/b',
      ]);
      expect(mockExistsSync).toHaveBeenCalledTimes(6);
    });

    it('returns an absolute token normalised without a trailing slash', () => {
      existOnly('/x/repo');

      const resolved = resolveExistingRepoDir('/x/repo/', cwd);

      expect(resolved).toBe('/x/repo');
      expect(probedPaths(mockExistsSync)).toEqual(['/x/repo']);
      expect(mockExistsSync).toHaveBeenCalledTimes(1);
    });

    it('returns null after probing every candidate when nothing exists', () => {
      const resolved = resolveExistingRepoDir('workspace/repo', cwd);

      expect(resolved).toBeNull();
      expect(probedPaths(mockExistsSync)).toEqual([
        '/work/app/workspace/repo',
        '/work/workspace/repo',
        '/repos/workspace/repo',
        '/work/app/repo',
        '/work/repo',
        '/repos/repo',
      ]);
      expect(mockExistsSync).toHaveBeenCalledTimes(6);
    });
  });
});
