import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test } from '@nestjs/testing';
import { AiService } from '../../integrations/ai/ai.service';
import { appendToLogFile } from '../../shared/logger/log-file-writer';
import { commitDescriptionResponseJsonSchema } from '../../shared/schemas/commit-description.schema';
import { hashCommitDescriptionDiff } from '../../shared/utils/commit-description-artifact';
import { CommitDescriptionStageService } from './commit-description-stage.service';

jest.mock('../../shared/logger/log-file-writer', () => ({ appendToLogFile: jest.fn() }));

const createFileDiff = (file: string, body: string): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${body}`;

const multiFileDiff = [
  createFileDiff('src/alpha.ts', 'alphaChange'),
  createFileDiff('src/beta.ts', 'betaChange'),
].join('\n');

const validResponse = { nature: 'fix', description: 'Corrects alpha and beta handling.' };

describe('CommitDescriptionStageService', () => {
  let tmpDir: string;

  const createExecuteMock = (): jest.Mock => jest.fn().mockResolvedValue({ content: JSON.stringify(validResponse) });

  const buildService = async (executeImpl: jest.Mock = createExecuteMock()) => {
    const module = await Test.createTestingModule({
      providers: [CommitDescriptionStageService, { provide: AiService, useValue: { execute: executeImpl } }],
    }).compile();
    return { service: module.get(CommitDescriptionStageService), execute: executeImpl };
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-desc-stage-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('generating a description from a diff', () => {
    it('calls the AI once with deterministic settings and the structured schema', async () => {
      const { service, execute } = await buildService();

      await service.generate({ diff: multiFileDiff });

      expect(execute).toHaveBeenCalledTimes(1);
      const request = execute.mock.calls[0][0];
      expect(request).toEqual(expect.objectContaining({
        temperature: 0,
        maxTokens: 512,
        stage: 'review',
        structuredOutput: { name: 'commit_description', schema: commitDescriptionResponseJsonSchema },
      }));
      expect(request).not.toHaveProperty('provider');
      expect(request).not.toHaveProperty('model');
      expect(request).not.toHaveProperty('backend');
    });

    it('includes every changed file name and its diff text in the prompt', async () => {
      const { service, execute } = await buildService();

      await service.generate({ diff: multiFileDiff });

      const { prompt } = execute.mock.calls[0][0];
      expect(prompt).toContain('src/alpha.ts');
      expect(prompt).toContain('src/beta.ts');
      expect(prompt).toContain('+alphaChange');
      expect(prompt).toContain('+betaChange');
    });

    it('adds the completeness section when the diff exceeds the evidence budget', async () => {
      const { service, execute } = await buildService();
      const oversized = [
        createFileDiff('src/huge-a.ts', 'a'.repeat(200_000)),
        createFileDiff('src/huge-b.ts', 'b'.repeat(200_000)),
      ].join('\n');

      await service.generate({ diff: oversized });

      expect(execute.mock.calls[0][0].prompt).toContain('## Evidence completeness');
    });

    it('returns the parsed response and reports progress before the call', async () => {
      const { service } = await buildService();
      const onProgress = jest.fn();

      const result = await service.generate({ diff: multiFileDiff, onProgress });

      expect(result).toEqual(validResponse);
      expect(onProgress).toHaveBeenCalledWith('Generating commit description...');
    });

    it('returns null and logs a warning when the AI call rejects', async () => {
      const { service } = await buildService(jest.fn().mockRejectedValue(new Error('boom')));

      const result = await service.generate({ diff: multiFileDiff });

      expect(result).toBeNull();
      expect(appendToLogFile).toHaveBeenCalledWith('WARN', expect.any(String), 'commit-description');
    });

    it('returns null and logs a warning when the content does not match the schema', async () => {
      const { service } = await buildService(
        jest.fn().mockResolvedValue({ content: JSON.stringify({ nature: 'bogus', description: '' }) }),
      );

      const result = await service.generate({ diff: multiFileDiff });

      expect(result).toBeNull();
      expect(appendToLogFile).toHaveBeenCalledWith('WARN', expect.any(String), 'commit-description');
    });

    it('makes no AI call for an empty diff', async () => {
      const { service, execute } = await buildService();

      const result = await service.generate({ diff: '   ' });

      expect(result).toBeNull();
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('persisting a description', () => {
    it('writes the response with the sha256 of the exact diff', async () => {
      const { service } = await buildService();
      const artifactPath = path.join(tmpDir, 'nested', 'WBP-1-review.commit-description.json');

      await service.generateAndPersist({ diff: multiFileDiff, artifactPath });

      const written = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
      expect(written).toEqual({ ...validResponse, diffSha256: hashCommitDescriptionDiff(multiFileDiff) });
    });

    it('writes no file when generation fails', async () => {
      const { service } = await buildService(jest.fn().mockRejectedValue(new Error('boom')));
      const artifactPath = path.join(tmpDir, 'WBP-1-review.commit-description.json');

      await service.generateAndPersist({ diff: multiFileDiff, artifactPath });

      expect(fs.existsSync(artifactPath)).toBe(false);
    });
  });
});
