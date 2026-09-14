import * as path from 'node:path';
import { resolveUiDesignScreenshots } from './resolve-ui-design-screenshots';
import { FileSystemError } from '../errors/app.error';
import { appendToLogFile } from '../logger/log-file-writer';

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  existsSync: jest.fn(),
}));

jest.mock('../logger/log-file-writer');

import * as fs from 'node:fs';

const mockReaddirSync = fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>;
const mockStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockAppendToLogFile = appendToLogFile as jest.MockedFunction<typeof appendToLogFile>;

const ARTIFACT_DIR = '/home/user/.wf/myrepo';
const IDENTIFIER = 'ABC-123';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('resolveUiDesignScreenshots no-arg mode', () => {
  it('scans artifactDir/identifier and returns valid-extension absolute paths', () => {
    mockReaddirSync.mockReturnValue(['a.png', 'b.jpg', 'skip.txt'] as any);

    const result = resolveUiDesignScreenshots([], ARTIFACT_DIR, IDENTIFIER);

    expect(result).toEqual([
      path.join(ARTIFACT_DIR, IDENTIFIER, 'a.png'),
      path.join(ARTIFACT_DIR, IDENTIFIER, 'b.jpg'),
    ]);
  });

  it('WARNs and returns empty array when scan directory is missing', () => {
    mockReaddirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = resolveUiDesignScreenshots([], ARTIFACT_DIR, IDENTIFIER);

    expect(result).toEqual([]);
    expect(mockAppendToLogFile).toHaveBeenCalledWith('WARN', expect.stringContaining(IDENTIFIER), expect.any(String));
  });
});

describe('resolveUiDesignScreenshots single-directory mode', () => {
  it('globs images from a directory when single rawFile resolves to a directory', () => {
    mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
    mockReaddirSync.mockReturnValue(['c.webp', 'd.svg'] as any);

    const result = resolveUiDesignScreenshots(['designs/'], ARTIFACT_DIR, IDENTIFIER);

    const resolvedDir = path.resolve(ARTIFACT_DIR, 'designs/');
    expect(result).toEqual([
      path.join(resolvedDir, 'c.webp'),
      path.join(resolvedDir, 'd.svg'),
    ]);
  });
});

describe('resolveUiDesignScreenshots file-list mode', () => {
  it('resolves each file path against artifactDir and returns the valid ones', () => {
    mockStatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    mockExistsSync.mockReturnValue(true);

    const result = resolveUiDesignScreenshots(['screen1.png', 'screen2.jpg'], ARTIFACT_DIR, IDENTIFIER);

    expect(result).toEqual([
      path.resolve(ARTIFACT_DIR, 'screen1.png'),
      path.resolve(ARTIFACT_DIR, 'screen2.jpg'),
    ]);
  });

  it('throws FileSystemError when a resolved file does not exist', () => {
    mockStatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    mockExistsSync.mockReturnValue(false);

    expect(() => resolveUiDesignScreenshots(['missing.png'], ARTIFACT_DIR, IDENTIFIER)).toThrow(FileSystemError);
  });

  it('WARNs and excludes files with invalid extension', () => {
    mockStatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    mockExistsSync.mockReturnValue(true);

    const result = resolveUiDesignScreenshots(['design.pdf'], ARTIFACT_DIR, IDENTIFIER);

    expect(result).toEqual([]);
    expect(mockAppendToLogFile).toHaveBeenCalledWith('WARN', expect.stringContaining('.pdf'), expect.any(String));
  });
});
