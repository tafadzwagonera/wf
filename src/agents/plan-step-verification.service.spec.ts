import { Test, TestingModule } from '@nestjs/testing';
import {
  PlanStepVerificationService,
  buildStepAssessorPrompt,
  buildExecutionEvidenceSection,
  buildPlanStepVerificationPrompt,
  collectPushEvidence,
  stripRepoNamePrefix,
} from './plan-step-verification.service';
import { PullStepAssessorService } from './pull-step-assessor.service';
import { AiService } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import type { StepAssessment } from '../shared/types/step-verification.types';
import { stepAssessmentResponseJsonSchema } from '../shared/schemas/step-verification.schema';

type ExecCallback = (error: Error | null, result?: { stdout: string }) => void;

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

describe('buildStepAssessorPrompt', () => {
  afterEach(() => jest.restoreAllMocks());

  it('numbers steps from 0', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }, { index: 1, text: 'Step B' }], {
      nameStatus: 'M\tsrc/a.ts', fileDiffSections: [], untrackedSections: [], omittedPaths: [], truncatedUntrackedPaths: [],
    });
    expect(prompt).toContain('[Plan step 0]');
    expect(prompt).toContain('[Plan step 1]');
  });

  it('includes not-applicable rule', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], {
      nameStatus: 'M\tsrc/a.ts', fileDiffSections: [], untrackedSections: [], omittedPaths: [], truncatedUntrackedPaths: [],
    });
    expect(prompt).toContain('not-applicable');
  });

  it('renders complete names and warns about omitted hunks', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], {
      nameStatus: 'M\tsrc/a.ts\nM\tsrc/b.ts',
      fileDiffSections: ['### src/a.ts\ndiff a'],
      untrackedSections: [],
      omittedPaths: ['src/b.ts'],
      truncatedUntrackedPaths: [],
    });
    expect(prompt).toContain('Changed files (complete list)');
    expect(prompt).toContain('Changed but their hunks were omitted');
    expect(prompt).toContain('src/b.ts');
    expect(prompt).toMatch(/not-done:.*changed-files list/);
    expect(prompt).toMatch(/unverifiable: ONLY/);
  });

  it('omits execution evidence section when called with two args', () => {
    const result = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], {
      nameStatus: 'M\tsrc/a.ts', fileDiffSections: [], untrackedSections: [], omittedPaths: [], truncatedUntrackedPaths: [],
    });
    expect(result).not.toContain('## Command execution evidence');
  });

  it('inserts execution evidence section in order when called with three args', () => {
    const result = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], {
      nameStatus: 'M\tsrc/a.ts', fileDiffSections: [], untrackedSections: [], omittedPaths: [], truncatedUntrackedPaths: [],
    }, {
      outcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'passed' }],
      stagedFiles: [],
    });
    expect(result).toContain('## Command execution evidence');
    expect(result.indexOf('## Per-file diffs')).toBeLessThan(result.indexOf('## Command execution evidence'));
    expect(result.indexOf('## Command execution evidence')).toBeLessThan(result.indexOf('## Status rules'));
    expect(result).toContain('## Command evidence rules');
  });
});

describe('buildExecutionEvidenceSection', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns empty string when evidence is undefined', () => {
    expect(buildExecutionEvidenceSection(undefined)).toBe('');
  });

  it('renders a passed outcome without a fenced code block', () => {
    const result = buildExecutionEvidenceSection({
      outcomes: [{ id: 'v1', command: 'yarn test src/foo.spec.ts', policy: 'enforced', status: 'passed' }],
      stagedFiles: [],
    });
    expect(result).toContain('→ passed (exit 0; output not captured for passing commands) [policy: enforced]');
    expect(result).not.toContain('```');
  });

  it('renders a failed outcome with a fenced code block', () => {
    const result = buildExecutionEvidenceSection({
      outcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'failed', output: 'FAIL\n1 test failed' }],
      stagedFiles: [],
    });
    expect(result).toContain('→ failed [policy: enforced]');
    expect(result).toContain('```');
    expect(result).toContain('FAIL');
  });

  it('caps failed output at 4000 characters with a truncated marker', () => {
    const result = buildExecutionEvidenceSection({
      outcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'failed', output: 'x'.repeat(4001) }],
      stagedFiles: [],
    });
    expect(result).toContain('[truncated]');
  });

  it('renders a skipped outcome without a fence when output is absent', () => {
    const result = buildExecutionEvidenceSection({
      outcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'skipped' }],
      stagedFiles: [],
    });
    expect(result).toContain('→ skipped [policy: enforced]');
    expect(result).not.toContain('```');
  });

  it('renders a skipped outcome with a fence when output is present', () => {
    const result = buildExecutionEvidenceSection({
      outcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'skipped', output: 'skip reason' }],
      stagedFiles: [],
    });
    expect(result).toContain('→ skipped [policy: enforced]');
    expect(result).toContain('```');
    expect(result).toContain('skip reason');
  });

  it('renders placeholder, blocked policy, and staged none for empty outcomes with blocked policy', () => {
    const result = buildExecutionEvidenceSection({
      outcomes: [],
      commitPolicy: { allowsCommit: false, complexity: 'medium' },
      stagedFiles: [],
    });
    expect(result).toContain('(no verification commands were executed)');
    expect(result).toContain('Commit policy: blocked (complexity=medium)');
    expect(result).toContain('Staged files: none');
  });

  it('renders allowed commit policy line', () => {
    const result = buildExecutionEvidenceSection({
      outcomes: [],
      commitPolicy: { allowsCommit: true, complexity: 'low' },
      stagedFiles: [],
    });
    expect(result).toContain('Commit policy: allowed');
  });

  it('includes commits since baseline when present and omits when absent', () => {
    const withBaseline = buildExecutionEvidenceSection({ outcomes: [], stagedFiles: [], commitsSinceBaseline: 2 });
    expect(withBaseline).toContain('Commits created since baseline: 2');

    const withoutBaseline = buildExecutionEvidenceSection({ outcomes: [], stagedFiles: [] });
    expect(withoutBaseline).not.toContain('Commits created since baseline');
  });
});

describe('collectPushEvidence', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps the full changed-file list while omitting hunk sections over budget', async () => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    const paths = Array.from({ length: 9 }, (_, index) => `src/${index}.ts`);
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      const key = args.join(' ');
      if (key === 'diff --name-status HEAD') {
        callback(null, { stdout: paths.map(filePath => `M\t${filePath}`).join('\n') });
        return;
      }
      callback(null, { stdout: 'x'.repeat(20_000) });
    });

    const evidence = await collectPushEvidence({ repoDir: '/repo', baseRef: 'HEAD', stepTexts: [] });

    expect(evidence.nameStatus).toContain('src/8.ts');
    expect(evidence.omittedPaths).toContain('src/8.ts');
  });

  it('prioritizes files named in plan steps and throws git failures', async () => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      const key = args.join(' ');
      if (key === 'diff --name-status HEAD') {
        callback(null, { stdout: Array.from({ length: 9 }, (_, index) => `M\tsrc/${index}.ts`).join('\n') });
        return;
      }
      callback(null, { stdout: 'x'.repeat(20_000) });
    });

    const evidence = await collectPushEvidence({ repoDir: '/repo', baseRef: 'HEAD', stepTexts: ['Edit src/8.ts'] });

    expect(evidence.fileDiffSections[0]).toContain('src/8.ts');
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: ExecCallback) => callback(new Error('ENOBUFS')));
    await expect(collectPushEvidence({ repoDir: '/repo', baseRef: 'HEAD', stepTexts: [] })).rejects.toThrow('ENOBUFS');
  });

  it('caps rendered tracked and untracked sections and marks truncation', async () => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      callback(null, { stdout: args.includes('--name-status') ? 'M\tsrc/a.ts' : 'x'.repeat(20_000) });
    });
    const evidence = await collectPushEvidence({
      repoDir: '/repo', baseRef: 'HEAD', stepTexts: [], untrackedSections: [`### src/new.ts\n${'u'.repeat(20_000)}`],
    });
    expect(evidence.untrackedSections[0]).toHaveLength(8_000);
    expect(evidence.untrackedSections[0]).toContain('[truncated]');
    expect(evidence.fileDiffSections[0]).toHaveLength(8_000);
    expect(evidence.fileDiffSections[0]).toContain('[truncated]');
  });

  it('uses rename destinations and retains untracked evidence before hunks', async () => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      callback(null, { stdout: args.includes('--name-status') ? 'R100\tsrc/old.ts\tsrc/new.ts' : 'rename diff' });
    });
    const evidence = await collectPushEvidence({
      repoDir: '/repo', baseRef: 'HEAD', stepTexts: [],
      untrackedSections: Array.from({ length: 8 }, (_, index) => `### src/new-${index}.ts\n${'u'.repeat(8_000)}`),
    });
    expect(evidence.untrackedSections).toHaveLength(8);
    expect(evidence.omittedPaths).toContain('src/new.ts');
  });

  it('diffs the destination path for rename entries', async () => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      callback(null, { stdout: args.includes('--name-status') ? 'R100\tsrc/old.ts\tsrc/new.ts' : 'rename diff' });
    });
    const evidence = await collectPushEvidence({ repoDir: '/repo', baseRef: 'HEAD', stepTexts: [] });
    expect(evidence.fileDiffSections[0]).toContain('### src/new.ts');
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
  let mockPullAssess: jest.Mock;

  const makeModule = async (): Promise<TestingModule> =>
    Test.createTestingModule({
      providers: [
        PlanStepVerificationService,
        { provide: AiService, useValue: { execute: mockAiExecute } },
        { provide: GitService, useValue: { getStatus: mockGitGetStatus } },
        { provide: CliPresenter, useValue: { progress: jest.fn() } },
        { provide: PullStepAssessorService, useValue: { assess: mockPullAssess } },
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
    mockPullAssess = jest.fn();
    (jest.requireMock('node:child_process').execFile as jest.Mock).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (error: null, result: { stdout: string }) => void) => {
        callback(null, { stdout: '' });
      },
    );
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

  it('delegates pull mode without building push evidence', async () => {
    mockPullAssess.mockResolvedValue([{ index: 0, status: 'done' }]);

    const outcome = await service.run(makeRunParams({ mode: 'pull', repoDir: '/repos/shop', steps: ['Edit shop/src/a.ts'] }));

    expect(outcome.summary).toMatchObject({ pending: 0, rounds: 1 });
    expect(mockAiExecute).not.toHaveBeenCalled();
    expect(mockGitGetStatus).not.toHaveBeenCalled();
    expect(mockPullAssess).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ index: 0, text: 'Edit src/a.ts' }], repoDir: '/repos/shop', baseRef: 'HEAD',
    }));
  });

  it('reconciles missing, duplicate, and unexpected pull assessments without consuming a retry', async () => {
    mockPullAssess
      .mockResolvedValueOnce([
        { index: 0, status: 'done' },
        { index: 0, status: 'not-done', missing: 'duplicate result' }, { index: 9, status: 'done' },
      ])
      .mockResolvedValueOnce([{ index: 1, status: 'done' }]);
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');

    const outcome = await service.run(makeRunParams({ mode: 'pull', steps: ['Step A', 'Step B'] }));

    expect(outcome.summary?.pending).toBe(0);
    expect(mockPullAssess).toHaveBeenCalledTimes(2);
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'WARN', 'step-verify.assess.partial missing-index=1', 'step-verification',
    );
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'WARN', 'step-verify.assess.partial dropped-index=0', 'step-verification',
    );
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'WARN', 'step-verify.assess.partial dropped-index=9', 'step-verification',
    );
  });

  it('logs the selected verification mode once', async () => {
    mockPullAssess.mockResolvedValue([{ index: 0, status: 'done' }]);
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    await service.run(makeRunParams({ mode: 'pull' }));
    expect(mockAppendToLogFile).toHaveBeenCalledWith('INFO', 'step-verify.mode=pull', 'step-verification');
  });

  it('retries a failed pull assessment and forwards assessor overrides', async () => {
    mockPullAssess
      .mockRejectedValueOnce(new Error('chat crashed'))
      .mockResolvedValueOnce([{ index: 0, status: 'done' }]);

    const outcome = await service.run(makeRunParams({
      mode: 'pull', assessorProvider: 'anthropic', assessorModel: 'claude-sonnet-4-6',
    }));

    expect(outcome.summary?.pending).toBe(0);
    expect(mockPullAssess).toHaveBeenCalledTimes(2);
    expect(mockPullAssess.mock.calls[1][0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('forwards assessorBackend as backend to pull assessor when set', async () => {
    mockPullAssess.mockResolvedValue([{ index: 0, status: 'done' }]);
    await service.run(makeRunParams({ mode: 'pull', assessorBackend: 'cli' }));
    expect(mockPullAssess).toHaveBeenCalledWith(expect.objectContaining({ backend: 'cli' }));
  });

  it('omits backend from pull assessor when assessorBackend is not set', async () => {
    mockPullAssess.mockResolvedValue([{ index: 0, status: 'done' }]);
    await service.run(makeRunParams({ mode: 'pull' }));
    expect(mockPullAssess.mock.calls[0][0]).not.toHaveProperty('backend');
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

  it('forwards assessorBackend as backend to aiService.execute when set', async () => {
    mockAiExecute.mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    await service.run(makeRunParams({ assessorBackend: 'cli' }));
    expect(mockAiExecute).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'cli' }),
    );
  });

  it('omits backend from aiService.execute when assessorBackend is not set', async () => {
    mockAiExecute.mockResolvedValueOnce({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    await service.run(makeRunParams());
    const call = mockAiExecute.mock.calls[0][0];
    expect(call).not.toHaveProperty('backend');
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

  it('logs omitted tracked paths and retries a loud git collection failure', async () => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    const paths = Array.from({ length: 9 }, (_, index) => `src/${index}.ts`);
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      callback(null, { stdout: args.includes('--name-status') ? paths.map(filePath => `M\t${filePath}`).join('\n') : 'x'.repeat(20_000) });
    });
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    await service.run(makeRunParams());
    expect(mockAppendToLogFile).toHaveBeenCalledWith('WARN', expect.stringContaining('step-verify.diff.omitted'), 'step-verification');

    mockExecFile.mockClear();
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: ExecCallback) => callback(new Error('ENOBUFS')));
    await service.run(makeRunParams());
    expect(mockAppendToLogFile).toHaveBeenCalledWith('ERROR', expect.stringContaining('step-verify.assess.attempt-failed'), 'step-verification');
    expect(mockExecFile.mock.calls.length).toBeGreaterThanOrEqual(2);
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

  it('includes execution evidence section in prompt when verificationOutcomes and commitPolicy are provided', async () => {
    mockGitGetStatus.mockResolvedValue({ not_added: [], staged: ['src/a.ts'] });
    (jest.requireMock('node:child_process').execFile as jest.Mock).mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
        callback(null, { stdout: args.includes('rev-list') ? '2' : '' });
      },
    );
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });

    await service.run(makeRunParams({
      verificationOutcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'passed' }],
      commitPolicy: { allowsCommit: false, complexity: 'medium' },
      baseRef: 'abc123',
    }));

    const prompt = mockAiExecute.mock.calls[0][0].prompt;
    expect(prompt).toContain('## Command execution evidence');
    expect(prompt).toContain('Commit policy: blocked (complexity=medium)');
    expect(prompt).toContain('Staged files: src/a.ts');
    expect(prompt).toContain('Commits created since baseline: 2');
  });

  it('omits execution evidence section in prompt when no verificationOutcomes or commitPolicy', async () => {
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });

    await service.run(makeRunParams());

    const prompt = mockAiExecute.mock.calls[0][0].prompt;
    expect(prompt).not.toContain('## Command execution evidence');
  });

  it('includes hand-off rules alongside the failed-outcome rule under a blocked policy with outcomes', async () => {
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });

    await service.run(makeRunParams({
      verificationOutcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'passed' }],
      commitPolicy: { allowsCommit: false, complexity: 'medium' },
    }));

    const prompt = mockAiExecute.mock.calls[0][0].prompt;
    expect(prompt).toContain('- Hand-off step (run lint or smokes');
    expect(prompt).toContain('mark not-applicable, not partially-done');
    expect(prompt).toContain('Matched command step with failed outcome: mark not-done');
  });

  it('omits hand-off rules when there are no outcomes and no commit policy', async () => {
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });

    await service.run(makeRunParams());

    const prompt = mockAiExecute.mock.calls[0][0].prompt;
    expect(prompt).not.toContain('- Hand-off step (run lint or smokes');
    expect(prompt).not.toContain('mark not-applicable, not partially-done');
  });

  it('renders an allowed commit policy without blocked wording when outcomes exist', async () => {
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });

    await service.run(makeRunParams({
      verificationOutcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'passed' }],
      commitPolicy: { allowsCommit: true, complexity: 'low' },
    }));

    const prompt = mockAiExecute.mock.calls[0][0].prompt;
    expect(prompt).toContain('Commit policy: allowed');
    expect(prompt).not.toContain('Commit policy: blocked');
    expect(prompt).toContain('- Hand-off step (run lint or smokes');
  });

  it('omits commits line from prompt when commitPolicy is set but no baseRef', async () => {
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });

    await service.run(makeRunParams({
      commitPolicy: { allowsCommit: false, complexity: 'medium' },
    }));

    const prompt = mockAiExecute.mock.calls[0][0].prompt;
    expect(prompt).toContain('## Command execution evidence');
    expect(prompt).not.toContain('Commits created since baseline');
  });

  it('does not call mockAiExecute or mockGitGetStatus in pull mode even when verificationOutcomes are provided', async () => {
    mockPullAssess.mockResolvedValue([{ index: 0, status: 'done' }]);

    await service.run(makeRunParams({
      mode: 'pull',
      verificationOutcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'passed' }],
    }));

    expect(mockPullAssess).toHaveBeenCalled();
    expect(mockAiExecute).not.toHaveBeenCalled();
    expect(mockGitGetStatus).not.toHaveBeenCalled();
  });

  it('never throws even when an internal error occurs', async () => {
    mockGitGetStatus.mockRejectedValue(new Error('git exploded'));

    await expect(service.run(makeRunParams())).resolves.toBeDefined();
  });

  it('rethrows AI provider auth errors from the verification loop', async () => {
    const authError = Object.assign(new Error('auth failure'), { name: 'AiProviderError', category: 'auth' as const });
    jest.spyOn(service as any, 'runVerificationLoop').mockRejectedValueOnce(authError);

    await expect(service.run(makeRunParams())).rejects.toBe(authError);
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
