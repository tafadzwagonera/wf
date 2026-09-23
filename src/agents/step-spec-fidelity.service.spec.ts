import { Test } from '@nestjs/testing';
import { StepSpecFidelityService, buildSpecFidelityPrompt } from './step-spec-fidelity.service';
import type { StepSpecFidelityRunParams } from './step-spec-fidelity.service';
import { AiService } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';

const MOCK_DIFF = 'diff --git a/src/foo.ts b/src/foo.ts\n+const x = 1;';

describe('StepSpecFidelityService', () => {
  let service: StepSpecFidelityService;
  let mockAiExecute: jest.Mock;
  let mockGitService: { getDiffFromRef: jest.Mock };

  beforeEach(async () => {
    mockAiExecute = jest.fn();
    mockGitService = { getDiffFromRef: jest.fn().mockResolvedValue(MOCK_DIFF) };
    const module = await Test.createTestingModule({
      providers: [
        StepSpecFidelityService,
        { provide: AiService, useValue: { execute: mockAiExecute } },
        { provide: GitService, useValue: mockGitService },
      ],
    }).compile();
    service = module.get(StepSpecFidelityService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('run()', () => {
    afterEach(() => jest.restoreAllMocks());

    it('returns [] and does not call AI when diff is empty', async () => {
      const params: StepSpecFidelityRunParams = { stepText: 'Add regex /\\.ts$/', diff: '   ' };
      const result = await service.run(params);
      expect(result).toEqual([]);
      expect(mockAiExecute).not.toHaveBeenCalled();
    });

    it('returns [] when AI response has no findings', async () => {
      mockAiExecute.mockResolvedValue({ content: '{"findings":[]}' });
      const result = await service.run({ stepText: 'Step A', diff: '+code' });
      expect(result).toEqual([]);
    });

    it('returns an error finding when AI reports a concrete mismatch', async () => {
      mockAiExecute.mockResolvedValue({
        content: '{"findings":[{"severity":"error","claim":"/\\\\.ts$/","deviation":"diff uses /\\\\.js$/"}]}',
      });
      const result = await service.run({ stepText: 'Step A', diff: '+code' });
      expect(result).toEqual([{ severity: 'error', claim: '/\\.ts$/', deviation: 'diff uses /\\.js$/' }]);
    });

    it('returns a warning finding when AI cannot confirm a claim from the diff', async () => {
      mockAiExecute.mockResolvedValue({
        content: '{"findings":[{"severity":"warning","claim":"returns null when totalSamples < 3","deviation":"diff is silent"}]}',
      });
      const result = await service.run({ stepText: 'Step A', diff: '+code' });
      expect(result[0].severity).toBe('warning');
    });

    it('returns [] without throwing when AI returns invalid JSON', async () => {
      mockAiExecute.mockResolvedValue({ content: 'not json at all' });
      await expect(service.run({ stepText: 'Step A', diff: '+code' })).resolves.toEqual([]);
    });

    it('returns [] without throwing when AI returns JSON that fails schema validation', async () => {
      mockAiExecute.mockResolvedValue({ content: '{"findings":[{"severity":"critical","claim":"x","deviation":"y"}]}' });
      await expect(service.run({ stepText: 'Step A', diff: '+code' })).resolves.toEqual([]);
    });

    it('returns [] without throwing when AI execute rejects', async () => {
      mockAiExecute.mockRejectedValue(new Error('network error'));
      await expect(service.run({ stepText: 'Step A', diff: '+code' })).resolves.toEqual([]);
    });

    it('calls AI execute with stage "review" and maxTokens 2048', async () => {
      mockAiExecute.mockResolvedValue({ content: '{"findings":[]}' });
      await service.run({ stepText: 'Step A', diff: '+code' });
      expect(mockAiExecute).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'review', maxTokens: 2048 }),
      );
    });
  });

  describe('verifyAll()', () => {
    afterEach(() => jest.restoreAllMocks());

    it('returns one findings array per step', async () => {
      mockAiExecute.mockResolvedValue({ content: '{"findings":[]}' });
      const result = await service.verifyAll(['Step A', 'Step B'], '/repo');
      expect(result).toHaveLength(2);
    });

    it('calls getDiffFromRef exactly once regardless of step count', async () => {
      mockAiExecute.mockResolvedValue({ content: '{"findings":[]}' });
      await service.verifyAll(['Step A', 'Step B', 'Step C'], '/repo');
      expect(mockGitService.getDiffFromRef).toHaveBeenCalledTimes(1);
    });

    it('passes the same diff string to every run() call', async () => {
      const capturedPrompts: string[] = [];
      mockAiExecute.mockImplementation(({ prompt }: { prompt: string }) => {
        capturedPrompts.push(prompt);
        return Promise.resolve({ content: '{"findings":[]}' });
      });
      await service.verifyAll(['Step A', 'Step B'], '/repo');
      const diffSection = (p: string) => p.split('## Changed files diff')[1]?.split('## Your task')[0] ?? '';
      expect(diffSection(capturedPrompts[0])).toBe(diffSection(capturedPrompts[1]));
    });

    it('runs step checks sequentially', async () => {
      let activeCalls = 0;
      let maxActiveCalls = 0;
      const callOrder: number[] = [];
      mockAiExecute.mockImplementation(async () => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        callOrder.push(callOrder.length);
        await new Promise(resolve => setTimeout(resolve, 5));
        activeCalls -= 1;
        return { content: '{"findings":[]}' };
      });

      await service.verifyAll(['Step A', 'Step B', 'Step C'], '/repo');

      expect(maxActiveCalls).toBe(1);
      expect(callOrder).toEqual([0, 1, 2]);
    });

    it('returns [[], []] without throwing when git diff fails', async () => {
      mockGitService.getDiffFromRef.mockRejectedValueOnce(new Error('not a git repo'));
      const result = await service.verifyAll(['Step A', 'Step B'], '/not-a-repo');
      expect(result).toEqual([[], []]);
    });
  });

  describe('buildSpecFidelityPrompt', () => {
    afterEach(() => jest.restoreAllMocks());

    it('includes the stepText verbatim', () => {
      const prompt = buildSpecFidelityPrompt('must use /\\.ts$/ regex', 'diff');
      expect(prompt).toContain('must use /\\.ts$/ regex');
    });

    it('includes the diff verbatim', () => {
      const prompt = buildSpecFidelityPrompt('step', '+const x = 1;');
      expect(prompt).toContain('+const x = 1;');
    });

    it('includes the JSON output shape instruction', () => {
      const prompt = buildSpecFidelityPrompt('step', 'diff');
      expect(prompt).toContain('{"findings":[');
    });
  });
});
