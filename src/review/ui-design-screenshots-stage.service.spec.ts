jest.mock('../common/utils/plan-artifact', () => ({
  ...jest.requireActual('../common/utils/plan-artifact'),
  readUiDesignScreenshotsFromPlanArtifact: jest.fn(),
}));

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

jest.mock('../common/logger/log-file-writer');

import * as fs from 'node:fs';
import { Test, TestingModule } from '@nestjs/testing';
import { UiDesignScreenshotsStageService } from './ui-design-screenshots-stage.service';
import { readUiDesignScreenshotsFromPlanArtifact } from '../common/utils/plan-artifact';
import { appendToLogFile } from '../common/logger/log-file-writer';

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;
type ReadUiDesignFn = typeof readUiDesignScreenshotsFromPlanArtifact;
const mockReadUiDesignScreenshots = readUiDesignScreenshotsFromPlanArtifact as jest.MockedFunction<ReadUiDesignFn>;
const mockAppendToLogFile = appendToLogFile as jest.MockedFunction<typeof appendToLogFile>;

const pngBuffer = Buffer.from('fakepng');
const PNG_BASE64 = pngBuffer.toString('base64');

async function buildService(): Promise<UiDesignScreenshotsStageService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [UiDesignScreenshotsStageService],
  }).compile();
  return module.get(UiDesignScreenshotsStageService);
}

describe('UiDesignScreenshotsStageService', () => {
  let service: UiDesignScreenshotsStageService;

  beforeEach(async () => {
    service = await buildService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('encodeFromPaths', () => {
    it('returns empty result for empty paths array', () => {
      expect(service.encodeFromPaths([])).toEqual({ screenshots: [], paths: [] });
    });

    it('encodes a valid PNG file and returns correct mediaType and base64', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(pngBuffer);

      const result = service.encodeFromPaths(['/tmp/a.png']);

      expect(result.screenshots).toHaveLength(1);
      expect(result.screenshots[0]).toMatchObject({
        path: '/tmp/a.png',
        mediaType: 'image/png',
        base64: PNG_BASE64,
      });
      expect(result.paths).toEqual(['/tmp/a.png']);
    });

    it('encodes a JPEG file with correct mediaType', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(pngBuffer);

      const result = service.encodeFromPaths(['/tmp/photo.jpg']);

      expect(result.screenshots[0].mediaType).toBe('image/jpeg');
    });

    it('tells the user on the console which screenshot file was skipped', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      mockExistsSync.mockImplementation(p => p !== '/tmp/gone.png');
      mockReadFileSync.mockReturnValue(pngBuffer);

      const result = service.encodeFromPaths(['/tmp/a.png', '/tmp/gone.png']);

      expect(result.paths).toEqual(['/tmp/a.png']);
      const lines = logSpy.mock.calls.map(call => String(call[0]));
      expect(lines.filter(line => line.includes('file not found, skipped: /tmp/gone.png'))).toHaveLength(1);
    });

    it('prints nothing when every file exists', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(pngBuffer);

      service.encodeFromPaths(['/tmp/a.png']);

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('WARNs and skips a file that does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = service.encodeFromPaths(['/tmp/missing.png']);

      expect(result.screenshots).toHaveLength(0);
      expect(result.paths).toHaveLength(0);
      expect(mockAppendToLogFile).toHaveBeenCalledWith('WARN', expect.stringContaining('missing.png'), expect.any(String));
    });
  });

  describe('resolveIfEnabled', () => {
    it('returns undefined when the artifact has no uiDesignScreenshots key', async () => {
      mockReadUiDesignScreenshots.mockReturnValue(undefined);

      const result = await service.resolveIfEnabled({ artifactPath: '/plan.json' });

      expect(result).toBeUndefined();
    });

    it('encodes files from paths stored in the artifact', async () => {
      mockReadUiDesignScreenshots.mockReturnValue(['/tmp/design.png']);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(pngBuffer);

      const result = await service.resolveIfEnabled({ artifactPath: '/plan.json' });

      expect(result?.screenshots).toHaveLength(1);
      expect(result?.screenshots[0].mediaType).toBe('image/png');
      expect(result?.paths).toEqual(['/tmp/design.png']);
    });
  });
});
