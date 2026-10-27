import * as path from 'node:path';
import { resolveUiDesignScreenshots } from './resolve-ui-design-screenshots';
import { FileSystemError } from '../errors/app.error';
import { appendToLogFile } from '../logger/log-file-writer';

jest.mock('../../agents/utils', () => ({
  ...jest.requireActual('../../agents/utils'),
  resolveCustomArtifactDir: jest.fn(() => '/home/user/.wf/myrepo'),
}));

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  copyFileSync: jest.fn(),
}));

jest.mock('../logger/log-file-writer');

import * as fs from 'node:fs';

const mockReaddirSync = fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>;
const mockStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockMkdirSync = fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>;
const mockCopyFileSync = fs.copyFileSync as jest.MockedFunction<typeof fs.copyFileSync>;
const mockAppendToLogFile = appendToLogFile as jest.MockedFunction<typeof appendToLogFile>;

const REPO_BASE_DIR = '/workspace/myrepo';
const ARTIFACT_DIR = '/home/user/.wf/myrepo';
const IDENTIFIER = 'ABC-123';

afterEach(() => {
  jest.restoreAllMocks();
  mockMkdirSync.mockClear();
  mockCopyFileSync.mockClear();
});

describe('resolveUiDesignScreenshots no-arg mode', () => {
  it('scans the repo custom artifact directory and returns valid-extension absolute paths', () => {
    mockReaddirSync.mockReturnValue(['a.png', 'b.jpg', 'skip.txt'] as any);

    const result = resolveUiDesignScreenshots([], REPO_BASE_DIR, IDENTIFIER);

    expect(result).toEqual([
      path.join(ARTIFACT_DIR, IDENTIFIER, 'a.png'),
      path.join(ARTIFACT_DIR, IDENTIFIER, 'b.jpg'),
    ]);
  });

  it('WARNs and returns empty array when scan directory is missing', () => {
    mockReaddirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = resolveUiDesignScreenshots([], REPO_BASE_DIR, IDENTIFIER);

    expect(result).toEqual([]);
    expect(mockAppendToLogFile).toHaveBeenCalledWith('WARN', expect.stringContaining(IDENTIFIER), expect.any(String));
  });
});

describe('resolveUiDesignScreenshots single-directory mode', () => {
  it('globs images from a directory when single rawFile resolves to a directory', () => {
    mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
    mockReaddirSync.mockReturnValue(['c.webp', 'd.svg'] as any);

    const result = resolveUiDesignScreenshots(['designs/'], REPO_BASE_DIR, IDENTIFIER);

    const resolvedDir = path.resolve(REPO_BASE_DIR, 'designs/');
    expect(result).toEqual([
      path.join(resolvedDir, 'c.webp'),
      path.join(resolvedDir, 'd.svg'),
    ]);
  });
});

describe('resolveUiDesignScreenshots file-list mode', () => {
  it('resolves each file path against repoBaseDir and returns the valid ones', () => {
    mockStatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    mockExistsSync.mockReturnValue(true);

    const result = resolveUiDesignScreenshots(['screen1.png', 'screen2.jpg'], REPO_BASE_DIR, IDENTIFIER);

    expect(result).toEqual([
      path.resolve(REPO_BASE_DIR, 'screen1.png'),
      path.resolve(REPO_BASE_DIR, 'screen2.jpg'),
    ]);
  });

  it('throws FileSystemError when a resolved file does not exist', () => {
    mockStatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    mockExistsSync.mockReturnValue(false);

    expect(() => resolveUiDesignScreenshots(['missing.png'], REPO_BASE_DIR, IDENTIFIER)).toThrow(FileSystemError);
  });

  it('WARNs and excludes files with invalid extension', () => {
    mockStatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    mockExistsSync.mockReturnValue(true);

    const result = resolveUiDesignScreenshots(['design.pdf'], REPO_BASE_DIR, IDENTIFIER);

    expect(result).toEqual([]);
    expect(mockAppendToLogFile).toHaveBeenCalledWith('WARN', expect.stringContaining('.pdf'), expect.any(String));
  });
});

describe('resolveUiDesignScreenshots model-safe paths', () => {
  const macosName = 'Screenshot 2026-10-16 at 4.55.50\u202Fpm.png';

  it('copies a file whose name has non-ASCII characters to an ASCII-only path and returns that path', () => {
    mockReaddirSync.mockReturnValue([macosName, 'plain name.png'] as any);

    const result = resolveUiDesignScreenshots([], REPO_BASE_DIR, IDENTIFIER);

    const original = path.join(ARTIFACT_DIR, IDENTIFIER, macosName);
    expect(mockCopyFileSync).toHaveBeenCalledTimes(1);
    expect(mockCopyFileSync.mock.calls[0]?.[0]).toBe(original);
    const safePath = mockCopyFileSync.mock.calls[0]?.[1] as string;
    expect(safePath).toMatch(/^[\x20-\x7E]+$/);
    expect(path.dirname(safePath)).toBe(path.join(ARTIFACT_DIR, IDENTIFIER, '.wf-safe'));
    expect(path.extname(safePath)).toBe('.png');
    expect(mockMkdirSync).toHaveBeenCalledWith(path.dirname(safePath), { recursive: true });
    expect(result).toEqual([safePath, path.join(ARTIFACT_DIR, IDENTIFIER, 'plain name.png')]);
  });

  it('gives distinct safe paths to names that sanitise to the same text', () => {
    mockReaddirSync.mockReturnValue(['a\u202Fb.png', 'a\u00A0b.png'] as any);

    const [first, second] = resolveUiDesignScreenshots([], REPO_BASE_DIR, IDENTIFIER);

    expect(first).not.toBe(second);
  });

  it('does not copy ASCII-named files', () => {
    mockReaddirSync.mockReturnValue(['a.png'] as any);

    resolveUiDesignScreenshots([], REPO_BASE_DIR, IDENTIFIER);

    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });
});
