import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTempDir as createManagedTempDir } from '../testing/temp-dir';
import { extractRuntimeAsset } from './runtime-assets';

const mockGetAsset = jest.fn();

jest.mock('node:sea', () => ({
  isSea: () => true,
  getAsset: (...args: unknown[]) => mockGetAsset(...args),
}));

describe('extractRuntimeAsset', () => {
  const tempRoot = createManagedTempDir('extract-asset');
  const destPath = path.join(tempRoot, 'nested', 'tool');
  const params = { assetKey: 'bootstrap/tool', destPath, mode: 0o755 };

  beforeEach(() => {
    mockGetAsset.mockReturnValue('#!/bin/sh\necho one\n');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockGetAsset.mockReset();
    fs.rmSync(path.dirname(destPath), { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('writes the asset with the requested mode and leaves no temp file behind', () => {
    const result = extractRuntimeAsset(params);

    expect(result).toBe(destPath);
    expect(fs.readFileSync(destPath, 'utf8')).toBe('#!/bin/sh\necho one\n');
    expect(fs.statSync(destPath).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(path.dirname(destPath))).toEqual(['tool']);
    expect(mockGetAsset.mock.calls[0]).toEqual(['bootstrap/tool', 'utf8']);
  });

  it('restores the mode when the content matches but the exec bit was lost', () => {
    extractRuntimeAsset(params);
    fs.chmodSync(destPath, 0o644);

    extractRuntimeAsset(params);

    expect(fs.statSync(destPath).mode & 0o777).toBe(0o755);
  });

  it('keeps the existing file untouched when content and mode already match', () => {
    extractRuntimeAsset(params);
    const before = fs.statSync(destPath).ino;

    extractRuntimeAsset(params);

    expect(fs.statSync(destPath).ino).toBe(before);
  });

  it('throws when the asset is missing so callers can surface the failure', () => {
    mockGetAsset.mockImplementation(() => {
      throw new Error('asset not found');
    });

    expect(() => extractRuntimeAsset(params)).toThrow('asset not found');
    expect(fs.existsSync(destPath)).toBe(false);
  });
});
