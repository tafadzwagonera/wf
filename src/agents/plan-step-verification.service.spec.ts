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
      2,
    );
    expect(result instanceof Map).toBe(true);
  });

  it('returns an error string for duplicate index', () => {
    const result = validateStepAssessments(
      [{ index: 0, status: 'done' }, { index: 0, status: 'not-done', missing: 'x' }],
      2,
    );
    expect(typeof result).toBe('string');
  });

  it('returns an error string for out-of-range index', () => {
    const result = validateStepAssessments([{ index: 5, status: 'done' }], 2);
    expect(typeof result).toBe('string');
  });

  it('returns an error string when coverage is incomplete', () => {
    const result = validateStepAssessments([{ index: 0, status: 'done' }], 2);
    expect(typeof result).toBe('string');
  });

  it('maps index to assessment for valid input', () => {
    const result = validateStepAssessments([{ index: 0, status: 'done' }], 1) as Map<number, StepAssessment>;
    expect(result.get(0)?.status).toBe('done');
  });
});

describe('buildStepAssessorPrompt', () => {
  afterEach(() => jest.restoreAllMocks());

  it('numbers steps from 0', () => {
    const prompt = buildStepAssessorPrompt(['Step A', 'Step B'], 'diff text', [], false);
    expect(prompt).toContain('[Plan step 0]');
    expect(prompt).toContain('[Plan step 1]');
  });

  it('includes not-applicable rule', () => {
    const prompt = buildStepAssessorPrompt(['Step A'], 'diff', [], false);
    expect(prompt).toContain('not-applicable');
  });

  it('includes truncation note when capped', () => {
    const prompt = buildStepAssessorPrompt(['Step A'], 'diff', [], true);
    expect(prompt).toContain('truncated');
  });

  it('omits truncation note when not capped', () => {
    const prompt = buildStepAssessorPrompt(['Step A'], 'diff', [], false);
    expect(prompt).not.toContain('truncated');
  });
});

describe('stripRepoNamePrefix', () => {
  it('strips the repoDir basename prefix from a path mentioned in a step', () => {
    const steps = ['Regenerate shop-v1.1/specs/amplitude-tracking-plan.json via yarn tracking:plan'];
    const result = stripRepoNamePrefix(steps, '/Users/tafadzwagonera/Projects/shop-v1.1');
    expect(result).toEqual(['Regenerate specs/amplitude-tracking-plan.json via yarn tracking:plan']);
  });

  it('strips every occurrence of the prefix within a single step', () => {
    const steps = ['Move shop-v1.1/a.ts to shop-v1.1/b.ts'];
    const result = stripRepoNamePrefix(steps, '/repos/shop-v1.1');
    expect(result).toEqual(['Move a.ts to b.ts']);
  });

  it('leaves steps with no repo-prefixed path unchanged', () => {
    const steps = ['Run yarn test and confirm it passes'];
    const result = stripRepoNamePrefix(steps, '/repos/shop-v1.1');
    expect(result).toEqual(['Run yarn test and confirm it passes']);
  });

  it('returns steps unchanged when repoDir has no basename', () => {
    const steps = ['Touches shop-v1.1/specs/plan.json'];
    const result = stripRepoNamePrefix(steps, '/');
    expect(result).toEqual(['Touches shop-v1.1/specs/plan.json']);
  });
});

describe('buildPlanStepVerificationPrompt', () => {
  afterEach(() => jest.restoreAllMocks());

  it('includes the round header', () => {
    const pending: StepAssessment[] = [{ index: 0, status: 'not-done', missing: 'implementation' }];
    const prompt = buildPlanStepVerificationPrompt(pending, 1, 3);
    expect(prompt).toContain('Verification round 1 (stall window: 3)');
  });

  it('includes only the pending step text', () => {
    const pending: StepAssessment[] = [{ index: 1, status: 'partially-done', missing: 'edge case' }];
    const prompt = buildPlanStepVerificationPrompt(pending, 2, 3);
    expect(prompt).toContain('Step 1');
    expect(prompt).toContain('edge case');
  });

  it('ends with the no-preamble instruction', () => {
    const pending: StepAssessment[] = [{ index: 0, status: 'not-done', missing: 'x' }];
    const prompt = buildPlanStepVerificationPrompt(pending, 1, 3);
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

  it('never throws even when an internal error occurs', async () => {
    mockGitGetStatus.mockRejectedValue(new Error('git exploded'));

    await expect(service.run(makeRunParams())).resolves.toBeDefined();
  });

  it('terminates when refreshSteps is set and assessor consistently returns invalid JSON', async () => {
    mockAiExecute.mockResolvedValue({ content: 'not json' });
    const mockRefreshSteps = jest.fn().mockResolvedValue(['Step A enriched']);

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
    const refreshSteps = jest.fn().mockResolvedValue(['Step A']);
    const runFixRound = jest.fn().mockResolvedValue({ sessionId: 'fix-sess' });

    const outcome = await service.run(makeRunParams({ stallWindow: 3, refreshSteps, runFixRound }));

    expect(outcome.summary?.pending).toBe(1);
    expect(refreshSteps).toHaveBeenCalledTimes(3);
  });

  it('does not stall when pending count strictly decreases each round (completes successfully)', async () => {
    mockAiExecute
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'x' }, { index: 1, status: 'not-done', missing: 'y' }, { index: 2, status: 'not-done', missing: 'z' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }, { index: 1, status: 'not-done', missing: 'y' }, { index: 2, status: 'not-done', missing: 'z' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }, { index: 1, status: 'done' }, { index: 2, status: 'not-done', missing: 'z' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }, { index: 1, status: 'done' }, { index: 2, status: 'done' }] }) });
    const refreshSteps = jest.fn().mockResolvedValue(['Step A', 'Step B', 'Step C']);
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

  it('terminates as stalled when pending count increases within stallWindow', async () => {
    mockAiExecute
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'x' }, { index: 1, status: 'done' }, { index: 2, status: 'done' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'x' }, { index: 1, status: 'not-done', missing: 'y' }, { index: 2, status: 'done' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'x' }, { index: 1, status: 'not-done', missing: 'y' }, { index: 2, status: 'not-done', missing: 'z' }] }) });
    const refreshSteps = jest.fn().mockResolvedValue(['Step A', 'Step B', 'Step C']);
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
    const refreshSteps = jest.fn().mockResolvedValue(['Edit shop-v1.1/src/main.ts']);

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
    const refreshSteps = jest.fn().mockResolvedValue(['Step A']);
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
