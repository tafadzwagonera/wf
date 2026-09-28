import { Test, TestingModule } from '@nestjs/testing';
import {
  PlanStepVerificationService,
  buildStepAssessorPrompt,
  buildPlanStepVerificationPrompt,
  validateStepAssessments,
  stripRepoNamePrefix,
} from './plan-step-verification.service';
import { AiService } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import type { StepAssessment } from '../shared/types/step-verification.types';
import { stepAssessmentResponseJsonSchema } from '../shared/schemas/step-verification.schema';

jest.mock('node:child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string }) => void) => {
      cb(null, { stdout: '' });
    },
  ),
}));

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  readFileSync: jest.fn(() => ''),
}));

jest.mock('../shared/logger/log-file-writer', () => ({
  appendToLogFile: jest.fn(),
}));

describe('validateStepAssessments', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns a Map for valid full coverage', () => {
    const result = validateStepAssessments(
      [{ index: 0, status: 'done' }, { index: 1, status: 'not-done', missing: 'x' }],
      [0, 1],
    );
    expect(result instanceof Map).toBe(true);
  });

  it('returns an error string for duplicate index', () => {
    const result = validateStepAssessments(
      [{ index: 0, status: 'done' }, { index: 0, status: 'not-done', missing: 'x' }],
      [0, 1],
    );
    expect(typeof result).toBe('string');
  });

  it('returns an error string for out-of-range index', () => {
    const result = validateStepAssessments([{ index: 5, status: 'done' }], [0, 1]);
    expect(typeof result).toBe('string');
  });

  it('returns an error string when coverage is incomplete', () => {
    const result = validateStepAssessments([{ index: 0, status: 'done' }], [0, 1]);
    expect(typeof result).toBe('string');
  });

  it('maps index to assessment for valid input', () => {
    const result = validateStepAssessments([{ index: 0, status: 'done' }], [0]) as Map<number, StepAssessment>;
    expect(result.get(0)?.status).toBe('done');
  });

  it('accepts exact non-contiguous requested indices', () => {
    const result = validateStepAssessments(
      [{ index: 2, status: 'done' }, { index: 7, status: 'not-done', missing: 'implementation' }],
      [2, 7],
    ) as Map<number, StepAssessment>;
    expect([...result.keys()]).toEqual([2, 7]);
  });
});

describe('buildStepAssessorPrompt', () => {
  afterEach(() => jest.restoreAllMocks());

  it('numbers steps from 0', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }, { index: 1, text: 'Step B' }], 'diff text', [], false);
    expect(prompt).toContain('[Plan step 0]');
    expect(prompt).toContain('[Plan step 1]');
  });

  it('includes not-applicable rule', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], 'diff', [], false);
    expect(prompt).toContain('not-applicable');
  });

  it('includes truncation note when capped', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], 'diff', [], true);
    expect(prompt).toContain('truncated');
  });

  it('omits truncation note when not capped', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], 'diff', [], false);
    expect(prompt).not.toContain('truncated');
  });
});

describe('stripRepoNamePrefix', () => {
  it('strips the repoDir basename prefix from a path mentioned in a step', () => {
    const steps = [{ index: 0, text: 'Regenerate shop-v1.1/specs/amplitude-tracking-plan.json via yarn tracking:plan' }];
    const result = stripRepoNamePrefix(steps, '/Users/tafadzwagonera/Projects/shop-v1.1');
    expect(result).toEqual([{ index: 0, text: 'Regenerate specs/amplitude-tracking-plan.json via yarn tracking:plan' }]);
  });

  it('strips every occurrence of the prefix within a single step', () => {
    const steps = [{ index: 0, text: 'Move shop-v1.1/a.ts to shop-v1.1/b.ts' }];
    const result = stripRepoNamePrefix(steps, '/repos/shop-v1.1');
    expect(result).toEqual([{ index: 0, text: 'Move a.ts to b.ts' }]);
  });

  it('leaves steps with no repo-prefixed path unchanged', () => {
    const steps = [{ index: 0, text: 'Run yarn test and confirm it passes' }];
    const result = stripRepoNamePrefix(steps, '/repos/shop-v1.1');
    expect(result).toEqual(steps);
  });

  it('returns steps unchanged when repoDir has no basename', () => {
    const steps = [{ index: 0, text: 'Touches shop-v1.1/specs/plan.json' }];
    const result = stripRepoNamePrefix(steps, '/');
    expect(result).toEqual(steps);
  });
});

describe('buildPlanStepVerificationPrompt', () => {
  afterEach(() => jest.restoreAllMocks());

  it('includes the round header', () => {
    const pending: StepAssessment[] = [{ index: 0, status: 'not-done', missing: 'implementation' }];
    const prompt = buildPlanStepVerificationPrompt({ pending, round: 1, stallWindow: 3, stepTexts: new Map([[0, 'step text']]) });
    expect(prompt).toContain('Verification round 1 (stall window: 3)');
  });

  it('includes only the pending step text', () => {
    const pending: StepAssessment[] = [{ index: 1, status: 'partially-done', missing: 'edge case' }];
    const prompt = buildPlanStepVerificationPrompt({ pending, round: 2, stallWindow: 3, stepTexts: new Map([[1, 'step text']]) });
    expect(prompt).toContain('Step 1');
    expect(prompt).toContain('edge case');
  });

  it('always emits an enriched-text fallback and one missing line for a pending step', () => {
    const pending: StepAssessment[] = [{ index: 1, status: 'not-done', missing: undefined }];
    const prompt = buildPlanStepVerificationPrompt({ pending, round: 2, stepTexts: new Map() });

    expect(prompt).toContain('[Enriched step text unavailable]');
    expect((prompt.match(/Missing:/g) ?? [])).toHaveLength(1);
  });

  it('ends with the no-preamble instruction', () => {
    const pending: StepAssessment[] = [{ index: 0, status: 'not-done', missing: 'x' }];
    const prompt = buildPlanStepVerificationPrompt({ pending, round: 1, stallWindow: 3, stepTexts: new Map([[0, 'step text']]) });
    expect(prompt).toContain('Do not output any text or plan before making your first tool call');
  });
});

describe('PlanStepVerificationService', () => {
  let service: PlanStepVerificationService;
  let module: TestingModule;
  let mockAiExecute: jest.Mock;
  let mockGitGetStatus: jest.Mock;

  const makeModule = async (): Promise<TestingModule> =>
    Test.createTestingModule({
      providers: [
        PlanStepVerificationService,
        { provide: AiService, useValue: { execute: mockAiExecute } },
        { provide: GitService, useValue: { getStatus: mockGitGetStatus } },
        { provide: CliPresenter, useValue: { progress: jest.fn() } },
      ],
    }).compile();

  const makeRunParams = (overrides: Partial<Parameters<PlanStepVerificationService['run']>[0]> = {}) => ({
    steps: ['Step A'],
    planSummary: 'summary',
    repoDir: '/repo',
    sessionId: 'sess-1',
    stallWindow: 3,
    silent: true,
    runFixRound: jest.fn().mockResolvedValue({ sessionId: 'sess-2' }),
    ...overrides,
  });

  beforeEach(async () => {
    mockAiExecute = jest.fn();
    mockGitGetStatus = jest.fn().mockResolvedValue({ not_added: [] });
    module = await makeModule();
    service = module.get(PlanStepVerificationService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns summary.pending=0 when all steps are done in round 1', async () => {
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }),
    });

    const outcome = await service.run(makeRunParams({ runFixRound: jest.fn().mockResolvedValue({ sessionId: 'sess-2' }) }));

    expect(outcome.summary?.pending).toBe(0);
    expect(outcome.summary?.rounds).toBe(1);
  });

  it('treats not-applicable as terminal (no fix round)', async () => {
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'not-applicable' }] }),
    });

    const mockFixRound = jest.fn();
    await service.run(makeRunParams({ runFixRound: mockFixRound }));

    expect(mockFixRound).not.toHaveBeenCalled();
  });

  it('treats unverifiable as terminal and counts it separately', async () => {
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'unverifiable', missing: 'diff cannot prove ordering' }] }),
    });
    const mockFixRound = jest.fn();

    const outcome = await service.run(makeRunParams({ runFixRound: mockFixRound }));

    expect(mockFixRound).not.toHaveBeenCalled();
    expect(outcome.summary).toMatchObject({ pending: 0, unverifiable: 1 });
  });

  it('calls execute with stage implement and no explicit provider or model', async () => {
    mockAiExecute.mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    await service.run(makeRunParams());
    expect(mockAiExecute).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'implement' }),
    );
    expect(mockAiExecute).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: expect.anything() }),
    );
  });

  it('requests the named plan-step assessment schema', async () => {
    mockAiExecute.mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    await service.run(makeRunParams());
    const request = mockAiExecute.mock.calls[0][0];
    expect(request).toEqual(expect.objectContaining({ stage: 'implement', temperature: 0 }));
    expect(request.structuredOutput).toEqual({ name: 'plan_step_assessment', schema: stepAssessmentResponseJsonSchema });
    expect(request.prompt).toContain('{"statuses":[{"index":0,"status":"done"},{"index":1,"status":"partially-done","missing":"…"}]}');
    expect(request.prompt).toContain('Produce exactly one entry per [Plan step N] tag above');
  });

  it('reports pending count when provider session is unavailable', async () => {
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'implementation' }] }),
    });
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    mockAppendToLogFile.mockClear();
    await service.run(makeRunParams({ sessionId: undefined }));
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'WARN', 'step-verify.skipped reason=provider-session-unavailable pending=1', 'step-verification',
    );
    expect(mockAppendToLogFile).not.toHaveBeenCalledWith('INFO', expect.stringContaining('step-verify.complete'), expect.anything());
  });

  it('reports every status category in assessed and complete events', async () => {
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [
      { index: 0, status: 'done' },
      { index: 1, status: 'not-applicable' },
      { index: 2, status: 'partially-done', missing: 'edge case' },
      { index: 3, status: 'not-done', missing: 'implementation' },
    ] }) });
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    const outcome = await service.run(makeRunParams({ steps: ['A', 'B', 'C', 'D'], stallWindow: 1 }));
    expect(outcome.summary?.pending).toBe(2);
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'INFO', 'step-verify.assessed steps=4 done=1 not-applicable=1 unverifiable=0 partially-done=1 not-done=1', 'step-verification',
    );
  });

  it('preserves an oversized untracked file and logs its truncated path', async () => {
    mockGitGetStatus.mockResolvedValue({ not_added: ['new-file.ts'] });
    const { readFileSync: mockReadFileSync } = jest.requireMock('node:fs');
    mockReadFileSync.mockReturnValue('x'.repeat(60_000));
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');

    await service.run(makeRunParams());

    expect(mockAiExecute.mock.calls[0][0].prompt).toContain('### new-file.ts');
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'WARN', expect.stringContaining('untracked-truncated=new-file.ts'), 'step-verification',
    );
  });

  it('performs one bounded structured assessment retry after invalid JSON', async () => {
    mockAiExecute
      .mockResolvedValueOnce({ content: 'not-json' })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    await service.run(makeRunParams());
    expect(mockAiExecute).toHaveBeenCalledTimes(2);
    expect(mockAiExecute.mock.calls[0][0].structuredOutput).toEqual(mockAiExecute.mock.calls[1][0].structuredOutput);
  });

  it('exhausts budget after stallWindow and returns pending count', async () => {
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'impl' }] }),
    });
    const mockFixRound = jest.fn().mockResolvedValue({ sessionId: 'sess-2' });

    const outcome = await service.run(makeRunParams({ stallWindow: 2, runFixRound: mockFixRound }));

    expect(mockFixRound).toHaveBeenCalledTimes(1);
    expect(outcome.summary?.pending).toBe(1);
  });

  it('exits early when fix round returns no sessionId', async () => {
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'impl' }] }),
    });

    const outcome = await service.run(
      makeRunParams({ runFixRound: jest.fn().mockResolvedValue({ sessionId: undefined }) }),
    );

    expect(outcome.summary?.pending).toBe(1);
  });

  it('degrades (summary: undefined) when assessor returns invalid JSON', async () => {
    mockAiExecute.mockResolvedValue({ content: 'not json' });

    const outcome = await service.run(makeRunParams());

    expect(outcome.summary).toBeUndefined();
  });

  it('keeps invalid assessment diagnostics out of terminal progress', async () => {
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    const presenter = module.get(CliPresenter);
    const mockProgress = jest.spyOn(presenter, 'progress');
    mockAiExecute.mockResolvedValue({ content: 'not json' });

    await service.run(makeRunParams({ silent: false, stallWindow: 1 }));

    expect(mockProgress).not.toHaveBeenCalledWith(
      expect.stringContaining('step-verify.assess.invalid'),
    );
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'ERROR',
      'step-verify.assess.invalid',
      'step-verification',
    );
  });

  it('never throws even when an internal error occurs', async () => {
    mockGitGetStatus.mockRejectedValue(new Error('git exploded'));

    await expect(service.run(makeRunParams())).resolves.toBeDefined();
  });

  it('terminates when refreshSteps is set and assessor consistently returns invalid JSON', async () => {
    mockAiExecute.mockResolvedValue({ content: 'not json' });
    const mockRefreshSteps = jest.fn().mockResolvedValue(new Map([[0, 'Step A enriched']]));

    const outcome = await service.run(makeRunParams({
      stallWindow: 2,
      refreshSteps: mockRefreshSteps,
      runFixRound: jest.fn(),
    }));

    expect(outcome.summary).toBeUndefined();
    expect(mockRefreshSteps).toHaveBeenCalledTimes(2);
  });

  it('accumulates extraPassCount from fix rounds', async () => {
    mockAiExecute
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'x' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    const mockFixRound = jest.fn().mockResolvedValue({ sessionId: 'sess-2', passCount: 2 });

    const outcome = await service.run(makeRunParams({ runFixRound: mockFixRound }));

    expect(outcome.extraPassCount).toBe(2);
  });

  it('terminates as stalled when refreshSteps is set and pending count plateaus over stallWindow rounds', async () => {
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'impl' }] }),
    });
    const refreshSteps = jest.fn().mockImplementation((indices: number[]) => Promise.resolve(new Map(indices.map(index => [index, 'Step A']))));
    const runFixRound = jest.fn().mockResolvedValue({ sessionId: 'fix-sess' });

    const outcome = await service.run(makeRunParams({ stallWindow: 3, refreshSteps, runFixRound }));

    expect(outcome.summary?.pending).toBe(1);
    expect(refreshSteps).toHaveBeenCalledTimes(3);
  });

  it('does not stall when pending count strictly decreases each round (completes successfully)', async () => {
    mockAiExecute
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'x' }, { index: 1, status: 'not-done', missing: 'y' }, { index: 2, status: 'not-done', missing: 'z' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }, { index: 1, status: 'not-done', missing: 'y' }, { index: 2, status: 'not-done', missing: 'z' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 1, status: 'done' }, { index: 2, status: 'not-done', missing: 'z' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 2, status: 'done' }] }) });
    const refreshSteps = jest.fn().mockImplementation((indices: number[]) => Promise.resolve(new Map(indices.map(index => [index, ['Step A', 'Step B', 'Step C'][index]]))));
    const runFixRound = jest.fn().mockResolvedValue({ sessionId: 'fix-sess' });

    const outcome = await service.run(makeRunParams({
      steps: ['Step A', 'Step B', 'Step C'],
      stallWindow: 3,
      refreshSteps,
      runFixRound,
    }));

    expect(outcome.summary?.pending).toBe(0);
    expect(outcome.summary?.done).toBe(3);
  });

  it('assesses only pending indices when a refresher returns extra step text', async () => {
    mockAiExecute
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [
        { index: 0, status: 'done' }, { index: 1, status: 'not-done', missing: 'implementation' },
      ] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 1, status: 'not-done', missing: 'implementation' }] }) });
    const refreshSteps = jest.fn()
      .mockResolvedValueOnce(new Map([[0, 'Step A'], [1, 'Step B']]))
      .mockResolvedValueOnce(new Map([[0, 'stale Step A'], [1, 'Step B']]));
    const outcome = await service.run(makeRunParams({
      steps: ['Step A', 'Step B'], stallWindow: 2, refreshSteps,
      runFixRound: jest.fn().mockResolvedValue({ sessionId: 'fix-sess' }),
    }));

    expect(outcome.summary?.pending).toBe(1);
    expect(mockAiExecute.mock.calls[1][0].prompt).not.toContain('[Plan step 0]');
  });

  it('terminates as stalled when pending count increases within stallWindow', async () => {
    mockAiExecute
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'x' }, { index: 1, status: 'done' }, { index: 2, status: 'done' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'x' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'x' }] }) });
    const refreshSteps = jest.fn().mockImplementation((indices: number[]) => Promise.resolve(new Map(indices.map(index => [index, ['Step A', 'Step B', 'Step C'][index]]))));
    const runFixRound = jest.fn().mockResolvedValue({ sessionId: 'fix-sess' });

    const outcome = await service.run(makeRunParams({
      steps: ['Step A', 'Step B', 'Step C'],
      stallWindow: 3,
      refreshSteps,
      runFixRound,
    }));

    expect(outcome.summary?.pending).toBeGreaterThan(0);
    expect(refreshSteps).toHaveBeenCalledTimes(3);
  });

  it('strips repo name prefix from refreshSteps results before building assessor prompt', async () => {
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }),
    });
    const refreshSteps = jest.fn().mockImplementation((indices: number[]) => Promise.resolve(new Map(indices.map(index => [index, 'Edit shop-v1.1/src/main.ts']))));

    await service.run(makeRunParams({
      repoDir: '/repos/shop-v1.1',
      stallWindow: 1,
      refreshSteps,
      runFixRound: jest.fn().mockResolvedValue({ sessionId: 'fix-sess' }),
    }));

    const capturedPrompt: string = mockAiExecute.mock.calls[0][0].prompt as string;
    expect(capturedPrompt).toContain('src/main.ts');
    expect(capturedPrompt).not.toContain('shop-v1.1/src/main.ts');
  });

  it('terminates after one round when stallWindow is 1 and steps remain pending', async () => {
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'impl' }] }),
    });
    const refreshSteps = jest.fn().mockImplementation((indices: number[]) => Promise.resolve(new Map(indices.map(index => [index, 'Step A']))));
    const runFixRound = jest.fn().mockResolvedValue({ sessionId: 'fix-sess' });

    const outcome = await service.run(makeRunParams({ stallWindow: 1, refreshSteps, runFixRound }));

    expect(outcome.summary?.pending).toBe(1);
    expect(refreshSteps).toHaveBeenCalledTimes(1);
    expect(runFixRound).not.toHaveBeenCalled();
  });

  describe('logSkip', () => {
    it('emits step-verify.skipped with the given reason to the log file', () => {
      const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');

      service.logSkip('no-assessed-steps');

      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'INFO',
        'step-verify.skipped reason=no-assessed-steps',
        'step-verification',
      );
    });

    it('emits to console when silent is not true', () => {
      const presenter = module.get(CliPresenter);
      const mockProgress = jest.spyOn(presenter, 'progress');

      service.logSkip('disabled', false);

      expect(mockProgress).toHaveBeenCalledWith(
        expect.stringContaining('step-verify.skipped reason=disabled'),
      );
    });

    it('suppresses console output when silent is true but still writes to the log file', () => {
      const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
      const presenter = module.get(CliPresenter);
      const mockProgress = jest.spyOn(presenter, 'progress');

      service.logSkip('no-changes', true);

      expect(mockProgress).not.toHaveBeenCalled();
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'INFO',
        'step-verify.skipped reason=no-changes',
        'step-verification',
      );
    });
  });
});
