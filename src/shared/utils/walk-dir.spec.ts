import { walkDir, DEFAULT_SKIP_DIRS, parseGitignore, buildSkipDirs } from './walk-dir';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const createTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wf-walkdir-'));

describe('walkDir', () => {
  describe('returns matching files', () => {
    it('finds files that satisfy the predicate', () => {
      const dir = createTempDir();
      fs.writeFileSync(path.join(dir, 'a.ts'), '');
      fs.writeFileSync(path.join(dir, 'b.js'), '');

      const result = walkDir(dir, f => f.endsWith('.ts'));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/a\.ts$/);
    });

    it('recursively finds files in subdirectories', () => {
      const dir = createTempDir();
      const sub = path.join(dir, 'sub');
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, 'deep.ts'), '');

      const result = walkDir(dir, f => f.endsWith('.ts'));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/deep\.ts$/);
    });

    it('returns an empty array when no files match the predicate', () => {
      const dir = createTempDir();
      fs.writeFileSync(path.join(dir, 'readme.md'), '');

      const result = walkDir(dir, f => f.endsWith('.ts'));

      expect(result).toHaveLength(0);
    });
  });

  describe('skips DEFAULT_SKIP_DIRS entries', () => {
    for (const skipDir of DEFAULT_SKIP_DIRS) {
      it(`skips ${skipDir}/`, () => {
        const dir = createTempDir();
        const skipped = path.join(dir, skipDir);
        fs.mkdirSync(skipped);
        fs.writeFileSync(path.join(skipped, 'hidden.ts'), '');
        fs.writeFileSync(path.join(dir, 'visible.ts'), '');

        const result = walkDir(dir, f => f.endsWith('.ts'));

        expect(result).toHaveLength(1);
        expect(result[0]).toMatch(/visible\.ts$/);
      });
    }
  });

  describe('accepts a custom skipDirs set', () => {
    it('skips directories in the custom set', () => {
      const dir = createTempDir();
      fs.mkdirSync(path.join(dir, 'vendor'));
      fs.writeFileSync(path.join(dir, 'vendor', 'lib.ts'), '');
      fs.writeFileSync(path.join(dir, 'app.ts'), '');

      const result = walkDir(dir, f => f.endsWith('.ts'), new Set(['vendor']));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/app\.ts$/);
    });

    it('does not skip DEFAULT_SKIP_DIRS when a custom set is provided', () => {
      const dir = createTempDir();
      fs.mkdirSync(path.join(dir, 'dist'));
      fs.writeFileSync(path.join(dir, 'dist', 'index.js'), '');

      const result = walkDir(dir, f => f.endsWith('.js'), new Set(['other']));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatch(/index\.js$/);
    });
  });

  describe('handles unreadable directories', () => {
    it('returns an empty array when the root directory cannot be read', () => {
      const result = walkDir('/nonexistent/path/that/does/not/exist', () => true);

      expect(result).toEqual([]);
    });
  });
});

describe('parseGitignore', () => {
  it('extracts bare directory names with trailing slash', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'logs/\ntmp/\n');

    const result = parseGitignore(path.join(dir, '.gitignore'));

    expect(result).toEqual(new Set(['logs', 'tmp']));
  });

  it('extracts bare names without trailing slash', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n.wf\n');

    const result = parseGitignore(path.join(dir, '.gitignore'));

    expect(result).toEqual(new Set(['.env', '.wf']));
  });

  it('ignores comments and blank lines', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, '.gitignore'), '# comment\n\nlogs/\n');

    const result = parseGitignore(path.join(dir, '.gitignore'));

    expect(result).toEqual(new Set(['logs']));
  });

  it('ignores negated patterns', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, '.gitignore'), '!important/\nlogs/\n');

    const result = parseGitignore(path.join(dir, '.gitignore'));

    expect(result).toEqual(new Set(['logs']));
  });

  it('ignores wildcard patterns', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\nlogs/\n');

    const result = parseGitignore(path.join(dir, '.gitignore'));

    expect(result).toEqual(new Set(['logs']));
  });

  it('ignores patterns with embedded path separators', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'src/generated/\nlogs/\n');

    const result = parseGitignore(path.join(dir, '.gitignore'));

    expect(result).toEqual(new Set(['logs']));
  });

  it('returns an empty set when .gitignore does not exist', () => {
    const result = parseGitignore('/nonexistent/.gitignore');

    expect(result).toEqual(new Set());
  });
});

describe('buildSkipDirs', () => {
  it('merges DEFAULT_SKIP_DIRS with .gitignore entries', () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, '.gitignore'), '.wf/\nlogs/\n');

    const result = buildSkipDirs(dir);

    for (const d of DEFAULT_SKIP_DIRS) {
      expect(result.has(d)).toBe(true);
    }
    expect(result.has('.wf')).toBe(true);
    expect(result.has('logs')).toBe(true);
  });

  it('returns only DEFAULT_SKIP_DIRS when no .gitignore exists', () => {
    const dir = createTempDir();

    const result = buildSkipDirs(dir);

    expect(result).toEqual(DEFAULT_SKIP_DIRS);
  });
});
