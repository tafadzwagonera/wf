import { Test } from '@nestjs/testing';
import { StepSpecFidelityService, buildSpecFidelityPrompt } from './step-spec-fidelity.service';
import type { StepSpecFidelityRunParams } from './step-spec-fidelity.service';
import { AiService } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { stepFidelityResponseJsonSchema } from '../shared/schemas/step-spec-fidelity.schema';

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
    it('returns empty findings with no failure when diff is whitespace only', async () => {
      const result = await service.run({ stepText: 'step', diff: '   ' });
      expect(result).toEqual({ findings: [] });
      expect(mockAiExecute).not.toHaveBeenCalled();
    });

    it('calls aiService.execute with stage implement and structured output schema', async () => {
      mockAiExecute.mockResolvedValue({ content: '{"findings":[]}' });
      await service.run({ stepText: 'step', diff: MOCK_DIFF });
      expect(mockAiExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'implement',
          structuredOutput: { name: 'step_spec_fidelity', schema: stepFidelityResponseJsonSchema },
        }),
      );
    });

    it('returns findings on a valid response with no failure', async () => {
      mockAiExecute.mockResolvedValue({
        content: '{"findings":[{"severity":"error","claim":"uses X","deviation":"diff shows Y"}]}',
      });
      const result = await service.run({ stepText: 'step', diff: MOCK_DIFF });
      expect(result.findings).toEqual([{ severity: 'error', claim: 'uses X', deviation: 'diff shows Y' }]);
      expect(result.failure).toBeUndefined();
    });

    it('returns a response failure when the AI response is not parseable JSON', async () => {
      mockAiExecute.mockResolvedValue({ content: 'not-json' });
      const result = await service.run({ stepText: 'step', diff: MOCK_DIFF });
      expect(result.findings).toEqual([]);
      expect(result.failure?.category).toBe('response');
      expect(typeof result.failure?.cause).toBe('string');
    });

    it('returns a response failure when a finding is missing a required property', async () => {
      mockAiExecute.mockResolvedValue({
        content: '{"findings":[{"severity":"error","claim":"x"}]}',
      });
      const result = await service.run({ stepText: 'step', diff: MOCK_DIFF });
      expect(result.findings).toEqual([]);
      expect(result.failure?.category).toBe('response');
    });

    it('returns a provider failure when aiService.execute rejects', async () => {
      mockAiExecute.mockRejectedValue(new Error('rate-limit'));
      const result = await service.run({ stepText: 'step', diff: MOCK_DIFF });
      expect(result.findings).toEqual([]);
      expect(result.failure?.category).toBe('provider');
      expect(result.failure?.cause).toContain('rate-limit');
    });
  });

  describe('verifyAll()', () => {
    it('returns findingsPerStep with one entry per step and no failures on success', async () => {
      mockAiExecute.mockResolvedValue({ content: '{"findings":[]}' });
      const result = await service.verifyAll([{ index: 2, text: 'step-a' }, { index: 7, text: 'step-b' }], '/repo');
      expect([...result.findingsPerStep.keys()]).toEqual([2, 7]);
      expect(result.failures).toEqual([]);
    });

    it('calls getDiffFromRef exactly once regardless of step count', async () => {
      mockAiExecute.mockResolvedValue({ content: '{"findings":[]}' });
      await service.verifyAll([{ index: 0, text: 'a' }, { index: 1, text: 'b' }, { index: 2, text: 'c' }], '/repo');
      expect(mockGitService.getDiffFromRef).toHaveBeenCalledTimes(1);
    });

    it('collects a provider failure with stepIndex when one step rejects', async () => {
      mockAiExecute
        .mockResolvedValueOnce({ content: '{"findings":[]}' })
        .mockRejectedValueOnce(new Error('provider-error'));
      const result = await service.verifyAll([{ index: 2, text: 'step-a' }, { index: 7, text: 'step-b' }], '/repo');
      expect(result.findingsPerStep.size).toBe(2);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].category).toBe('provider');
      expect(result.failures[0].stepIndex).toBe(7);
    });

    it('returns a diff failure and makes no AI calls when getDiffFromRef throws', async () => {
      mockGitService.getDiffFromRef.mockRejectedValue(new Error('git-error'));
      const result = await service.verifyAll([{ index: 2, text: 'step-a' }], '/repo');
      expect(mockAiExecute).not.toHaveBeenCalled();
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].category).toBe('diff');
      expect(result.findingsPerStep.size).toBe(1);
      expect(result.findingsPerStep.get(2)).toEqual([]);
    });

    it('returns empty findingsPerStep and no failures for zero input steps', async () => {
      const result = await service.verifyAll([], '/repo');
      expect(result.findingsPerStep).toEqual(new Map());
      expect(result.failures).toEqual([]);
      expect(mockAiExecute).not.toHaveBeenCalled();
    });

    it('executes steps sequentially with at most one active AI call', async () => {
      let active = 0;
      let maxActive = 0;
      mockAiExecute.mockImplementation(() => {
        active++;
        maxActive = Math.max(maxActive, active);
        return Promise.resolve({ content: '{"findings":[]}' }).finally(() => {
          active--;
        });
      });
      await service.verifyAll([{ index: 0, text: 'a' }, { index: 1, text: 'b' }, { index: 2, text: 'c' }], '/repo');
      expect(maxActive).toBe(1);
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

  describe('stepFidelityResponseJsonSchema', () => {
    it('has an object root with additionalProperties false and required findings', () => {
      expect((stepFidelityResponseJsonSchema as Record<string, unknown>).type).toBe('object');
      expect((stepFidelityResponseJsonSchema as Record<string, unknown>).additionalProperties).toBe(false);
      expect((stepFidelityResponseJsonSchema as Record<string, unknown>).required).toContain('findings');
    });

    it('has finding items with all three properties required and no propertyNames keyword', () => {
      const props = (stepFidelityResponseJsonSchema as Record<string, unknown>)
        .properties as Record<string, unknown>;
      const items = (props.findings as Record<string, unknown>).items as Record<string, unknown>;
      expect(items.type).toBe('object');
      expect(items.additionalProperties).toBe(false);
      expect(items.required as string[]).toEqual(expect.arrayContaining(['severity', 'claim', 'deviation']));
      expect(items).not.toHaveProperty('propertyNames');
    });
  });
});
