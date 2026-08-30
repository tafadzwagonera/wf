import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  PlanStepVerificationService,
  buildStepAssessorPrompt,
  buildPlanStepVerificationPrompt,
  validateStepAssessments,
} from './plan-step-verification.service';
import { AiService } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import type { StepAssessment } from '../shared/types/step-verification.types';

jest.mock('node:child_process', () => ({
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

jest.mock('../shared/utils/plan-artifact', () => ({
  buildPlanArtifactManifestPath: jest.fn(() => '/tmp/plan.manifest.json'),
  readPlanArtifactManifest: jest.fn(() => null),
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
    expect(prompt).toContain('Step 0');
    expect(prompt).toContain('Step 1');
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

describe('buildPlanStepVerificationPrompt', () => {
  afterEach(() => jest.restoreAllMocks());

  it('includes the round header', () => {
    const pending: StepAssessment[] = [{ index: 0, status: 'not-done', missing: 'implementation' }];
    const prompt = buildPlanStepVerificationPrompt(pending, 1, 3);
    expect(prompt).toContain('Verification round 1 of 3');
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
  let mockConfigGet: jest.Mock;
  let mockAiExecute: jest.Mock;
  let mockGitGetStatus: jest.Mock;

  const makeModule = async (): Promise<TestingModule> =>
    Test.createTestingModule({
      providers: [
        PlanStepVerificationService,
        { provide: ConfigService, useValue: { get: mockConfigGet } },
        { provide: AiService, useValue: { execute: mockAiExecute } },
        { provide: GitService, useValue: { getStatus: mockGitGetStatus } },
        { provide: CliPresenter, useValue: { progress: jest.fn() } },
      ],
    }).compile();

  const makeRunParams = (overrides: Partial<Parameters<PlanStepVerificationService['run']>[0]> = {}) => ({
    steps: ['Step A'],
    planSummary: 'summary',
    planArtifactPath: '/tmp/plan.json',
    repoDir: '/repo',
    sessionId: 'sess-1',
    maxRounds: 3,
    silent: true,
    runFixRound: jest.fn().mockResolvedValue({ sessionId: 'sess-2' }),
    ...overrides,
  });

  const withTarget = (key: string) => {
    if (key === 'stages.implement.provider') return 'anthropic';
    if (key === 'stages.implement.model') return 'claude-sonnet-4-6';
    return undefined;
  };

  beforeEach(async () => {
    mockConfigGet = jest.fn();
    mockAiExecute = jest.fn();
    mockGitGetStatus = jest.fn().mockResolvedValue({ not_added: [] });
    const module = await makeModule();
    service = module.get(PlanStepVerificationService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns summary.pending=0 when all steps are done in round 1', async () => {
    mockConfigGet.mockImplementation(withTarget);
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }),
    });

    const outcome = await service.run(makeRunParams({ runFixRound: jest.fn().mockResolvedValue({ sessionId: 'sess-2' }) }));

    expect(outcome.summary?.pending).toBe(0);
    expect(outcome.summary?.rounds).toBe(1);
  });

  it('treats not-applicable as terminal (no fix round)', async () => {
    mockConfigGet.mockImplementation(withTarget);
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'not-applicable' }] }),
    });

    const mockFixRound = jest.fn();
    await service.run(makeRunParams({ runFixRound: mockFixRound }));

    expect(mockFixRound).not.toHaveBeenCalled();
  });

  it('skips loop and returns summary:undefined when assessor target is unresolvable', async () => {
    mockConfigGet.mockReturnValue(undefined);
    const outcome = await service.run(makeRunParams());
    expect(outcome.summary).toBeUndefined();
  });

  it('exhausts budget after maxRounds and returns pending count', async () => {
    mockConfigGet.mockImplementation(withTarget);
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'impl' }] }),
    });
    const mockFixRound = jest.fn().mockResolvedValue({ sessionId: 'sess-2' });

    const outcome = await service.run(makeRunParams({ maxRounds: 2, runFixRound: mockFixRound }));

    expect(mockFixRound).toHaveBeenCalledTimes(1);
    expect(outcome.summary?.pending).toBe(1);
  });

  it('exits early when fix round returns no sessionId', async () => {
    mockConfigGet.mockImplementation(withTarget);
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'impl' }] }),
    });

    const outcome = await service.run(
      makeRunParams({ runFixRound: jest.fn().mockResolvedValue({ sessionId: undefined }) }),
    );

    expect(outcome.summary?.pending).toBe(1);
  });

  it('degrades (summary: undefined) when assessor returns invalid JSON', async () => {
    mockConfigGet.mockImplementation(withTarget);
    mockAiExecute.mockResolvedValue({ content: 'not json' });

    const outcome = await service.run(makeRunParams());

    expect(outcome.summary).toBeUndefined();
  });

  it('never throws even when an internal error occurs', async () => {
    mockConfigGet.mockImplementation(() => {
      throw new Error('config exploded');
    });

    await expect(service.run(makeRunParams())).resolves.toBeDefined();
  });

  it('accumulates extraPassCount from fix rounds', async () => {
    mockConfigGet.mockImplementation(withTarget);
    mockAiExecute
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'not-done', missing: 'x' }] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    const mockFixRound = jest.fn().mockResolvedValue({ sessionId: 'sess-2', passCount: 2 });

    const outcome = await service.run(makeRunParams({ runFixRound: mockFixRound }));

    expect(outcome.extraPassCount).toBe(2);
  });
});
