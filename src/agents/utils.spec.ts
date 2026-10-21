import * as path from 'path';
import chalk from 'chalk';
import { restoreEnv, withEnv } from '../common/testing/env';
import { extractSummary, isRepoResolvable, resolveRepoBasePath, scaffoldNewRepo, slugify, toRepoKeys, truncateSlug, MAX_BRANCH_NAME_LENGTH } from './utils';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

const { existsSync, mkdirSync } = jest.requireMock('fs');

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
    existsSync.mockImplementation(input => String(input) === repoPath);

    expect(resolveRepoBasePath('repo-a')).toBe(repoPath);
  });

  it('resolves a long-format repo via the repo-name sibling when the full token is not a local path', () => {
    const repoPath = path.resolve('/tmp', 'repo-a');
    existsSync.mockImplementation(
      input => String(input) === repoPath && !String(input).includes(path.join('current-app', 'workspace'))
    );

    expect(resolveRepoBasePath('workspace/repo-a')).toBe(repoPath);
  });

  it('prefers an exact local workspace/repo path when it exists', () => {
    const exactPath = path.resolve('/tmp/current-app', 'workspace/repo-a');
    existsSync.mockImplementation(input => String(input) === exactPath);

    expect(resolveRepoBasePath('workspace/repo-a')).toBe(exactPath);
  });

  it('falls back to cwd and warns when neither full nor repo-name paths exist', () => {
    existsSync.mockReturnValue(false);

    expect(resolveRepoBasePath('workspace/repo-a')).toBe('/tmp/current-app');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0][0]).toBe(
      chalk.yellow(
        '⚠ Repository \'workspace/repo-a\' not found as a path, sibling directory, '
        + 'or under any repos directory. Using current directory.'
      )
    );
  });

  describe('when the repo exists only under WF_REPOS_DIR', () => {
    const reposDirPath = path.resolve('/srv/checkouts', 'repo-a');

    beforeEach(() => {
      withEnv({ WF_REPOS_DIR: '/srv/checkouts' });
      existsSync.mockImplementation((input: string) => String(input) === reposDirPath);
    });

    afterEach(() => {
      restoreEnv();
    });

    it('resolves to the repos directory entry without warning', () => {
      expect(resolveRepoBasePath('repo-a')).toBe(reposDirPath);
      expect(existsSync.mock.calls.map((call: unknown[]) => String(call[0]))).toContain(reposDirPath);
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('reports the repo as resolvable', () => {
      expect(isRepoResolvable('repo-a')).toBe(true);
      expect(existsSync.mock.calls.map((call: unknown[]) => String(call[0]))).toContain(reposDirPath);
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });
});

describe('extractSummary', () => {
  it('returns the full ticket heading summary from the artifact content', () => {
    const content = `# WBP-3054: Trip.com Content Mapping: Align Contentful Fields to Trip.com Preview Structure

## Description

Example body`;

    expect(extractSummary(content)).toBe(
      'Trip.com Content Mapping: Align Contentful Fields to Trip.com Preview Structure'
    );
  });

  it('falls back to the bare H1 text when the heading has no key prefix', () => {
    const content = `# Map and validate tour availability fields

## Description

Example body`;

    expect(extractSummary(content)).toBe('Map and validate tour availability fields');
  });

  it('returns Implementation when there is no H1 heading at all', () => {
    const content = `## Description

Example body`;

    expect(extractSummary(content)).toBe('Implementation');
  });
});

describe('slugify', () => {
  it('keeps the full normalized slug for long ticket summaries', () => {
    const summary = 'Trip.com Content Mapping: Align Contentful Fields to Trip.com Preview Structure';

    expect(slugify(summary)).toBe('tripcom-content-mapping-align-contentful-fields-to-tripcom-preview-structure');
  });
});

describe('truncateSlug', () => {
  it('caps branch names at 100 characters', () => {
    expect(MAX_BRANCH_NAME_LENGTH).toBe(100);
  });

  it('returns slug unchanged when within limit', () => {
    const slug = 'short-slug';
    expect(truncateSlug(slug, 10)).toBe('short-slug');
  });

  it('truncates at last hyphen when slug exceeds available length', () => {
    const slug = 'word-one-word-two-word-three';
    // prefixLength=85 → maxSlugLength=15 → truncated='word-one-word-t' → lastHyphen at 13 → 'word-one-word'
    expect(truncateSlug(slug, MAX_BRANCH_NAME_LENGTH - 15)).toBe('word-one-word');
  });

  it('hard-cuts when slug has no hyphens and exceeds limit', () => {
    const slug = 'averylongsingleword';
    expect(truncateSlug(slug, MAX_BRANCH_NAME_LENGTH - 5)).toBe('avery');
  });

  it('returns empty string when prefixLength equals or exceeds MAX_BRANCH_NAME_LENGTH', () => {
    expect(truncateSlug('any-slug', MAX_BRANCH_NAME_LENGTH)).toBe('');
    expect(truncateSlug('any-slug', MAX_BRANCH_NAME_LENGTH + 5)).toBe('');
  });
});

describe('isRepoResolvable', () => {
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/tmp/current-app');
    existsSync.mockReset();
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('returns true when a sibling directory exists for the repo name', () => {
    const siblingPath = path.resolve('/tmp/current-app', '..', 'sibling-repo');
    existsSync.mockImplementation((input: string) => String(input) === siblingPath);

    expect(isRepoResolvable('sibling-repo')).toBe(true);
  });

  it('returns false when the repo cannot be found locally', () => {
    existsSync.mockReturnValue(false);

    expect(isRepoResolvable('nonexistent-repo')).toBe(false);
  });
});

describe('scaffoldNewRepo', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates the directory as a sibling of baseDir', () => {
    const result = scaffoldNewRepo('new-repo', '/tmp/current-app');

    expect(result).toBe(path.resolve('/tmp/current-app', '..', 'new-repo'));
    expect(mkdirSync).toHaveBeenCalledWith(result, { recursive: true });
  });

  it('runs git init and an initial empty commit', () => {
    const { execSync: mockExecSync } = jest.requireMock('node:child_process');

    const result = scaffoldNewRepo('new-repo', '/tmp/current-app');
    const repoPath = path.resolve('/tmp/current-app', '..', 'new-repo');

    expect(mockExecSync).toHaveBeenCalledWith('git init', { cwd: repoPath, stdio: 'pipe' });
    expect(mockExecSync).toHaveBeenCalledWith(
      'git commit --allow-empty -m "chore: initial commit"',
      { cwd: repoPath, stdio: 'pipe' }
    );
  });

  it('throws a descriptive error when git commit fails', () => {
    const { execSync: mockExecSync } = jest.requireMock('node:child_process');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git commit')) throw new Error('empty ident');
    });

    const repoPath = path.resolve('/tmp/current-app', '..', 'new-repo');
    expect(() => scaffoldNewRepo('new-repo', '/tmp/current-app')).toThrow(
      `scaffoldNewRepo: git commit failed in ${repoPath}. Ensure git user.name and user.email are configured.`
    );
  });
});

describe('toRepoKeys', () => {
  beforeEach(() => {
    jest.spyOn(process, 'cwd').mockReturnValue('/tmp/current-app');
    existsSync.mockReset();
    existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns basenames for distinct repos', () => {
    expect(toRepoKeys(['/work/a/api', '/work/a/web'])).toEqual(['api', 'web']);
  });

  it('returns the full resolved path for every repo whose basename collides', () => {
    expect(toRepoKeys(['/work/a/app', '/work/b/app', '/work/a/web'])).toEqual(['/work/a/app', '/work/b/app', 'web']);
  });

  it('returns the cwd basename for an undefined repo', () => {
    expect(toRepoKeys([undefined])).toEqual(['current-app']);
  });
});
