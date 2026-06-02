import * as path from 'path';
import chalk from 'chalk';
import { extractSummary, resolveRepoBasePath, slugify } from './utils';

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
    expect(consoleLogSpy).toHaveBeenCalledWith(
      chalk.yellow(
        "⚠️ Repository 'workspace/repo-a' not found as a path or sibling directory. Using current directory.",
      ),
    );
  });
});

describe('extractSummary', () => {
  it('returns the full ticket heading summary from the artifact content', () => {
    const content = `# WBP-3054: Trip.com Content Mapping: Align Contentful Fields to Trip.com Preview Structure

## Description

Example body`;

    expect(extractSummary(content)).toBe(
      'Trip.com Content Mapping: Align Contentful Fields to Trip.com Preview Structure',
    );
  });

  it('falls back to the bare H1 text when the heading has no key prefix', () => {
    const content = `# Map and validate tour availability fields

## Description

Example body`;

    expect(extractSummary(content)).toBe(
      'Map and validate tour availability fields',
    );
  });

  it('returns Implementation when there is no H1 heading at all', () => {
    const content = `## Description

Example body`;

    expect(extractSummary(content)).toBe('Implementation');
  });
});

describe('slugify', () => {
  it('keeps the full normalized slug for long ticket summaries', () => {
    const summary =
      'Trip.com Content Mapping: Align Contentful Fields to Trip.com Preview Structure';

    expect(slugify(summary)).toBe(
      'tripcom-content-mapping-align-contentful-fields-to-tripcom-preview-structure',
    );
  });
});
