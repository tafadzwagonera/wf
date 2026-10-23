const mockIsSea = jest.fn();
const mockGetAsset = jest.fn();

jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: jest.fn(actual.readFileSync) };
});

jest.mock('node:sea', () => ({
  isSea: (...args: unknown[]) => mockIsSea(...args),
  getAsset: (...args: unknown[]) => mockGetAsset(...args),
}));

import * as fs from 'node:fs';
import { readRuntimeAsset } from './runtime-assets';

const resetMocks = (): void => {
  jest.restoreAllMocks();
  jest.mocked(fs.readFileSync).mockClear();
  mockIsSea.mockReset();
  mockGetAsset.mockReset();
};

describe('readRuntimeAsset', () => {
  describe('when running from disk', () => {
    afterEach(() => {
      resetMocks();
    });

    it('returns the file text read from the disk path', () => {
      mockIsSea.mockReturnValue(false);
      const mockReadFileSync = jest.spyOn(fs, 'readFileSync').mockReturnValue('{"disk":true}');

      const result = readRuntimeAsset('no-mcp.json', '/tmp/no-mcp.json');

      expect(result).toBe('{"disk":true}');
      expect(mockReadFileSync).toHaveBeenCalledTimes(1);
      expect(mockReadFileSync.mock.calls[0]).toEqual(['/tmp/no-mcp.json', 'utf8']);
      expect(mockGetAsset).not.toHaveBeenCalled();
    });
  });

  describe('when running as a SEA binary', () => {
    afterEach(() => {
      resetMocks();
    });

    it('returns the embedded asset text', () => {
      mockIsSea.mockReturnValue(true);
      mockGetAsset.mockReturnValue('{"sea":true}');
      const mockReadFileSync = jest.spyOn(fs, 'readFileSync');

      const result = readRuntimeAsset('no-mcp.json', '/tmp/no-mcp.json');

      expect(result).toBe('{"sea":true}');
      expect(mockGetAsset).toHaveBeenCalledTimes(1);
      expect(mockGetAsset.mock.calls[0]).toEqual(['no-mcp.json', 'utf8']);
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });
  });
});
