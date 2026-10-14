import { Test, TestingModule } from '@nestjs/testing';
import {
  EVIDENCE_CEILING_CHARS,
  PlanStepVerificationService,
  applyPullCoverageDowngrades,
  buildStepAssessorPrompt,
  buildExecutionEvidenceSection,
  buildPlanStepVerificationPrompt,
  collectPushEvidence,
  stripRepoNamePrefix,
  stripRepoPrefix,
  type PushEvidence,
} from './plan-step-verification.service';
import { PullStepAssessorService } from './pull-step-assessor.service';
import { AiService } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { ConfigurationError } from '../shared/errors/app.error';
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
  readFileSync: jest.fn(() => Buffer.from('')),
}));

jest.mock('../shared/logger/log-file-writer', () => ({
  appendToLogFile: jest.fn(),
}));

const pullDirective = { source: 'user', mode: 'pull' } as const;

const pullResult = (statuses: StepAssessment[], inspectedPaths: string[] = []) => ({ statuses, inspectedPaths });

const createMockEvidence = (overrides: Partial<PushEvidence> = {}): PushEvidence => ({
  nameStatus: 'M\tsrc/a.ts',
  fileDiffSections: [],
  untrackedSections: [],
  budgetReport: { totalMeasured: 0, budget: 60_000, truncated: [], omitted: [] },
  sections: [],
  ...overrides,
});

describe('buildStepAssessorPrompt', () => {
  afterEach(() => jest.restoreAllMocks());

  it('numbers steps from 0', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }, { index: 1, text: 'Step B' }], createMockEvidence());
    expect(prompt).toContain('[Plan step 0]');
    expect(prompt).toContain('[Plan step 1]');
  });

  it('includes not-applicable rule', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], createMockEvidence());
    expect(prompt).toContain('not-applicable');
  });

  it('renders complete names and warns about omitted hunks', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], createMockEvidence({
      nameStatus: 'M\tsrc/a.ts\nM\tsrc/b.ts',
      fileDiffSections: ['### src/a.ts\ndiff a'],
      budgetReport: { totalMeasured: 9, budget: 5, truncated: [], omitted: ['src/b.ts'] },
    }));
    expect(prompt).toContain('Changed files (complete list)');
    expect(prompt).toContain('## Evidence completeness');
    expect(prompt).toContain('src/b.ts');
    expect(prompt).toMatch(/not-done:.*changed-files list/);
    expect(prompt).toMatch(/unverifiable: ONLY/);
    expect(prompt).toContain('disclosed evidence gap');
  });

  it('keeps the plain unverifiable rule and no completeness section when evidence has no gaps', () => {
    const prompt = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], createMockEvidence());
    expect(prompt).not.toContain('## Evidence completeness');
    expect(prompt).not.toContain('disclosed evidence gap');
    expect(prompt).toContain(
      '- unverifiable: ONLY for temporal, process, or investigation claims that evidence cannot in principle prove or disprove (requires missing field)',
    );
  });

  it('omits execution evidence section when called with two args', () => {
    const result = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], createMockEvidence());
    expect(result).not.toContain('## Command execution evidence');
  });

  it('inserts execution evidence section in order when called with three args', () => {
    const result = buildStepAssessorPrompt([{ index: 0, text: 'Step A' }], createMockEvidence(), {
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

  const mockDiffOutputs = (paths: string[], diffChars: number): jest.Mock => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    mockExecFile.mockClear();
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      if (args.join(' ') === 'diff --name-status HEAD') {
        callback(null, { stdout: paths.map(filePath => `M\t${filePath}`).join('\n') });
        return;
      }
      callback(null, { stdout: 'x'.repeat(diffChars) });
    });
    return mockExecFile;
  };

  it('includes every hunk whole when 180k of diffs fits under the ceiling', async () => {
    mockDiffOutputs(Array.from({ length: 9 }, (_, index) => `src/${index}.ts`), 20_000);

    const evidence = await collectPushEvidence({ repoDir: '/repo', baseRef: 'HEAD', stepTexts: [] });

    expect(evidence.nameStatus).toContain('src/8.ts');
    expect(evidence.budgetReport.omitted).toEqual([]);
    expect(evidence.budgetReport.truncated).toEqual([]);
    expect(evidence.fileDiffSections).toHaveLength(9);
    expect(evidence.fileDiffSections[8]).toBe(`### src/8.ts\n${'x'.repeat(20_000)}`);
  });

  it('skips git calls and omits files past the fetch ceiling while keeping the full name list', async () => {
    const paths = Array.from({ length: 40 }, (_, index) => `src/${index}.ts`);
    const mockExecFile = mockDiffOutputs(paths, 20_000);

    const evidence = await collectPushEvidence({ repoDir: '/repo', baseRef: 'HEAD', stepTexts: [] });

    expect(evidence.nameStatus).toContain('src/39.ts');
    expect(evidence.budgetReport.omitted).toEqual(['src/36.ts', 'src/37.ts', 'src/38.ts', 'src/39.ts']);
    expect(mockExecFile).toHaveBeenCalledTimes(1 + 36);
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

  it('prioritizes files named in plan affectedFiles', async () => {
    mockDiffOutputs(Array.from({ length: 3 }, (_, index) => `src/${index}.ts`), 100);

    const evidence = await collectPushEvidence({
      repoDir: '/repo', baseRef: 'HEAD', stepTexts: [], affectedFiles: ['src/2.ts'],
    });

    expect(evidence.fileDiffSections[0]).toContain('src/2.ts');
  });

  it('renders 20k tracked and untracked sections whole instead of truncating them', async () => {
    mockDiffOutputs(['src/a.ts'], 20_000);

    const evidence = await collectPushEvidence({
      repoDir: '/repo', baseRef: 'HEAD', stepTexts: [],
      untrackedFiles: [{ path: 'src/new.ts', content: 'u'.repeat(20_000) }],
    });

    expect(evidence.untrackedSections[0]).toBe(`### src/new.ts\n\`\`\`\n${'u'.repeat(20_000)}\n\`\`\``);
    expect(evidence.fileDiffSections[0]).toHaveLength(`### src/a.ts\n`.length + 20_000);
    expect(evidence.budgetReport.truncated).toEqual([]);
  });

  it('orders untracked and tracked evidence by step mention rather than untracked-first', async () => {
    mockDiffOutputs(['src/tracked.ts'], 100);

    const evidence = await collectPushEvidence({
      repoDir: '/repo', baseRef: 'HEAD', stepTexts: ['Edit src/tracked.ts'],
      untrackedFiles: [{ path: 'src/new.ts', content: 'u' }],
    });

    expect(evidence.sections.map(section => section.path)).toEqual(['src/tracked.ts', 'src/new.ts']);
  });

  it('renders binary untracked files as placeholders and never reports them as gaps', async () => {
    mockDiffOutputs([], 0);

    const evidence = await collectPushEvidence({
      repoDir: '/repo', baseRef: 'HEAD', stepTexts: [],
      untrackedFiles: [{ path: 'img.png', content: '[binary file, 9 bytes]', binary: true }],
    });

    expect(evidence.untrackedSections).toEqual(['### img.png\n[binary file, 9 bytes]']);
    expect(evidence.budgetReport.omitted).toEqual([]);
  });

  it('assesses only-untracked changes with an empty changed-files list', async () => {
    mockDiffOutputs([], 0);

    const evidence = await collectPushEvidence({
      repoDir: '/repo', baseRef: 'HEAD', stepTexts: [],
      untrackedFiles: [{ path: 'src/new.ts', content: 'content' }],
    });

    expect(evidence.nameStatus).toBe('');
    expect(evidence.untrackedSections).toHaveLength(1);
    expect(evidence.budgetReport.budget).toBeGreaterThanOrEqual(7);
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

describe('stripRepoPrefix', () => {
  it('strips the repo basename prefix from free text and leaves other text alone', () => {
    expect(stripRepoPrefix('shop-v1.1/src/a.ts', '/repos/shop-v1.1')).toBe('src/a.ts');
    expect(stripRepoPrefix('src/a.ts', '/repos/shop-v1.1')).toBe('src/a.ts');
    expect(stripRepoPrefix('shop-v1.1/src/a.ts', '/')).toBe('shop-v1.1/src/a.ts');
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

  it('tells the agent to answer no-op steps with a one-line proof and a NO-CHANGE declaration', () => {
    const pending: StepAssessment[] = [{ index: 0, status: 'not-done', missing: 'x' }];
    const prompt = buildPlanStepVerificationPrompt({ pending, round: 1, stepTexts: new Map([[0, 'step text']]) });
    expect(prompt).toContain('single-line proof');
    expect(prompt).toContain('NO-CHANGE: <path>');
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

  const getMockAppendToLogFile = (): jest.Mock => jest.requireMock('../shared/logger/log-file-writer').appendToLogFile;

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

  it('builds a host-side checklist for pull mode', async () => {
    const { execFile: mockExecFile } = jest.requireMock('node:child_process');
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, callback: (error: null, result: { stdout: string }) => void) => {
        callback(null, { stdout: args.includes('--name-status') ? 'M\tsrc/a.ts\n' : 'diff body' });
      },
    );
    mockGitGetStatus.mockResolvedValue({ not_added: ['src/new.ts'] });
    const { readFileSync: mockReadFileSync } = jest.requireMock('node:fs');
    mockReadFileSync.mockReturnValue(Buffer.from('new content'));
    mockPullAssess.mockResolvedValue(pullResult([{ index: 0, status: 'done' }], ['src/a.ts', 'src/new.ts']));
    const mockAppendToLogFile = getMockAppendToLogFile();
    mockAppendToLogFile.mockClear();

    const outcome = await service.run(makeRunParams({
      modeDirective: pullDirective, repoDir: '/repos/shop', steps: ['Edit shop/src/a.ts'],
    }));

    expect(outcome.summary).toMatchObject({ pending: 0, rounds: 1 });
    expect(mockAiExecute).not.toHaveBeenCalled();
    expect(mockGitGetStatus).toHaveBeenCalled();
    expect(mockPullAssess).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ index: 0, text: 'Edit src/a.ts' }], repoDir: '/repos/shop', baseRef: 'HEAD',
      changedPaths: ['src/a.ts'], untrackedPaths: ['src/new.ts'],
    }));
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'INFO', expect.stringMatching(/^step-verify\.evidence\.budget measured=\d+ budget=\d+ files=1 untracked=1$/),
      'step-verification',
    );
  });

  it('reconciles missing, duplicate, and unexpected pull assessments without consuming a retry', async () => {
    mockPullAssess
      .mockResolvedValueOnce(pullResult([
        { index: 0, status: 'done' },
        { index: 0, status: 'not-done', missing: 'duplicate result' }, { index: 9, status: 'done' },
      ]))
      .mockResolvedValueOnce(pullResult([{ index: 1, status: 'done' }]));
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');

    const outcome = await service.run(makeRunParams({ modeDirective: pullDirective, steps: ['Step A', 'Step B'] }));

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
    mockPullAssess.mockResolvedValue(pullResult([{ index: 0, status: 'done' }]));
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    await service.run(makeRunParams({ modeDirective: pullDirective }));
    expect(mockAppendToLogFile).toHaveBeenCalledWith('INFO', 'step-verify.mode=pull (user override)', 'step-verification');
  });

  it('ends the verification run without retrying when the pull provider is unsupported', async () => {
    mockPullAssess.mockRejectedValue(
      new ConfigurationError('Pull step verification is unsupported for provider "google".'),
    );
    const mockAppendToLogFile = getMockAppendToLogFile();
    mockAppendToLogFile.mockClear();

    const outcome = await service.run(makeRunParams({ modeDirective: pullDirective, assessorProvider: 'google' }));

    expect(mockPullAssess).toHaveBeenCalledTimes(1);
    expect(outcome.summary).toBeUndefined();
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'ERROR', expect.stringContaining('step-verify.error cause=Pull step verification is unsupported'),
      'step-verification',
    );
  });

  it('retries a failed pull assessment and forwards assessor overrides', async () => {
    mockPullAssess
      .mockRejectedValueOnce(new Error('chat crashed'))
      .mockResolvedValueOnce(pullResult([{ index: 0, status: 'done' }]));

    const outcome = await service.run(makeRunParams({
      modeDirective: pullDirective, assessorProvider: 'anthropic', assessorModel: 'claude-sonnet-4-6',
    }));

    expect(outcome.summary?.pending).toBe(0);
    expect(mockPullAssess).toHaveBeenCalledTimes(2);
    expect(mockPullAssess.mock.calls[1][0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('forwards assessorBackend as backend to pull assessor when set', async () => {
    mockPullAssess.mockResolvedValue(pullResult([{ index: 0, status: 'done' }]));
    await service.run(makeRunParams({ modeDirective: pullDirective, assessorBackend: 'cli' }));
    expect(mockPullAssess).toHaveBeenCalledWith(expect.objectContaining({ backend: 'cli' }));
  });

  it('omits backend from pull assessor when assessorBackend is not set', async () => {
    mockPullAssess.mockResolvedValue(pullResult([{ index: 0, status: 'done' }]));
    await service.run(makeRunParams({ modeDirective: pullDirective }));
    expect(mockPullAssess.mock.calls[0][0]).not.toHaveProperty('backend');
  });

  it('sends the shared push JSON schema in a push round', async () => {
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });

    await service.run(makeRunParams());

    expect(mockAiExecute.mock.calls[0][0].structuredOutput.schema).toBe(stepAssessmentResponseJsonSchema);
  });

  describe('auto mode routing', () => {
    const autoDirective = (complexity: 'low' | 'medium' | 'high', pullSupported = true) =>
      ({ source: 'auto', complexity, pullSupported }) as const;

    const mockNameStatus = (nameStatus: string, diffBody = 'diff body'): jest.Mock => {
      const { execFile: mockExecFile } = jest.requireMock('node:child_process');
      mockExecFile.mockClear();
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, callback: (error: null, result: { stdout: string }) => void) => {
          callback(null, { stdout: args.includes('--name-status') ? nameStatus : diffBody });
        },
      );
      return mockExecFile;
    };

    const nameStatusCalls = (mockExecFile: jest.Mock): number =>
      mockExecFile.mock.calls.filter(call => (call[1] as string[]).includes('--name-status')).length;

    beforeEach(() => {
      mockPullAssess.mockResolvedValue(pullResult([{ index: 0, status: 'done' }]));
      mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    });

    it('routes high complexity to pull', async () => {
      const mockAppendToLogFile = getMockAppendToLogFile();
      await service.run(makeRunParams({ modeDirective: autoDirective('high') }));
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'INFO', 'step-verify.mode=pull (auto — high complexity)', 'step-verification',
      );
      expect(mockPullAssess).toHaveBeenCalled();
      expect(mockAiExecute).not.toHaveBeenCalled();
    });

    it('routes low complexity to push', async () => {
      const mockAppendToLogFile = getMockAppendToLogFile();
      await service.run(makeRunParams({ modeDirective: autoDirective('low') }));
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'INFO', 'step-verify.mode=push (auto — low complexity)', 'step-verification',
      );
      expect(mockAiExecute).toHaveBeenCalled();
    });

    it('routes medium complexity with a small diff to push and reuses the measurement', async () => {
      const mockExecFile = mockNameStatus('M\tsrc/a.ts\n');
      const mockAppendToLogFile = getMockAppendToLogFile();
      await service.run(makeRunParams({ modeDirective: autoDirective('medium') }));
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'INFO', 'step-verify.mode=push (auto — medium complexity, evidence fits push budget)', 'step-verification',
      );
      expect(mockAiExecute).toHaveBeenCalled();
      expect(nameStatusCalls(mockExecFile)).toBe(1);
    });

    it('routes medium complexity with an oversized diff to pull', async () => {
      mockNameStatus('M\tsrc/a.ts\n', 'x'.repeat(EVIDENCE_CEILING_CHARS + 1_000));
      const mockAppendToLogFile = getMockAppendToLogFile();
      await service.run(makeRunParams({ modeDirective: autoDirective('medium') }));
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'INFO', 'step-verify.mode=pull (auto — medium complexity, evidence exceeds push budget)', 'step-verification',
      );
      expect(mockPullAssess).toHaveBeenCalled();
    });

    it('falls back to push when the pull assessor provider is unsupported', async () => {
      const mockAppendToLogFile = getMockAppendToLogFile();
      await expect(service.run(makeRunParams({ modeDirective: autoDirective('high', false) }))).resolves.toBeDefined();
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'INFO', 'step-verify.mode=push (auto — pull assessor provider unsupported)', 'step-verification',
      );
      expect(mockPullAssess).not.toHaveBeenCalled();
    });

    it('logs a default reason when no directive is supplied', async () => {
      const mockAppendToLogFile = getMockAppendToLogFile();
      await service.run(makeRunParams());
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'INFO', 'step-verify.mode=push (default)', 'step-verification',
      );
    });
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
    expect(request.prompt).toContain('{"statuses":[{"index":0,"status":"done"}]}');
    expect(request.prompt).toContain('Produce exactly one entry per [Plan step N] tag above');
  });

  describe('index scoping for non-contiguous subsets', () => {
    const tenSteps = Array.from({ length: 10 }, (_, i) => `Step ${i}`);
    const roundOneStatuses = JSON.stringify({ statuses: tenSteps.map((_, index) => (
      [5, 6, 8, 9].includes(index)
        ? { index, status: 'not-done', missing: 'implementation' }
        : { index, status: 'done' }
    )) });
    const renumberedStatuses = JSON.stringify({ statuses: [0, 1, 2, 3].map(index => ({ index, status: 'done' })) });
    const subsetParams = () => makeRunParams({
      steps: tenSteps, stallWindow: 2, refreshSteps: jest.fn().mockResolvedValue(new Map()),
    });

    it('renders the response example from the real indices of a later-round subset', async () => {
      mockAiExecute
        .mockResolvedValueOnce({ content: roundOneStatuses })
        .mockResolvedValueOnce({ content: JSON.stringify({ statuses: [5, 6, 8, 9].map(index => ({ index, status: 'done' })) }) });

      await service.run(subsetParams());

      const roundTwoPrompt: string = mockAiExecute.mock.calls[1][0].prompt;
      expect(roundTwoPrompt).toContain('{"index":5,"status":"done"},{"index":6,"status":"partially-done"');
      expect(roundTwoPrompt).not.toContain('{"index":0,"status":"done"}');
    });

    it('retries then fails the round when the assessor renumbers the subset from 0', async () => {
      mockAiExecute
        .mockResolvedValueOnce({ content: roundOneStatuses })
        .mockResolvedValue({ content: renumberedStatuses });
      const mockAppendToLogFile = getMockAppendToLogFile();
      mockAppendToLogFile.mockClear();

      const outcome = await service.run(subsetParams());

      expect(outcome.summary).toBeUndefined();
      expect(mockAiExecute).toHaveBeenCalledTimes(1 + 2 + 2);
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'ERROR', expect.stringContaining('step-verify.assess.attempt-failed cause='), 'step-verification',
      );
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'WARN', expect.stringContaining('step-verify.exhausted reason=assessor-failed-2-rounds-in-a-row'), 'step-verification',
      );
      expect(mockAppendToLogFile).not.toHaveBeenCalledWith(
        'WARN', 'step-verify.assess.partial missing-index=5', 'step-verification',
      );
      expect(mockAppendToLogFile).not.toHaveBeenCalledWith(
        'WARN', expect.stringContaining('step-verify.missed'), 'step-verification',
      );
    });

    it('fails the round when the push assessor returns an empty statuses array', async () => {
      mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [] }) });

      const outcome = await service.run(makeRunParams({
        stallWindow: 1, refreshSteps: jest.fn().mockResolvedValue(new Map()),
      }));

      expect(outcome.summary).toBeUndefined();
      expect(mockAiExecute).toHaveBeenCalledTimes(2);
    });

    it('fails the round when every pull status is dropped as out of scope', async () => {
      mockPullAssess.mockResolvedValue(pullResult([{ index: 9, status: 'done' }]));
      const mockAppendToLogFile = getMockAppendToLogFile();
      mockAppendToLogFile.mockClear();

      const outcome = await service.run(makeRunParams({ modeDirective: pullDirective, stallWindow: 1 }));

      expect(outcome.summary).toBeUndefined();
      expect(mockPullAssess).toHaveBeenCalledTimes(2);
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'WARN', 'step-verify.assess.partial dropped-index=9', 'step-verification',
      );
    });

    it('falls back to not-done for one omitted index without consuming a retry', async () => {
      const doneStatuses = (indices: number[]) => ({
        content: JSON.stringify({ statuses: indices.map(index => ({ index, status: 'done' })) }),
      });
      mockAiExecute
        .mockResolvedValueOnce({ content: roundOneStatuses })
        .mockResolvedValueOnce(doneStatuses([5, 6, 8]))
        .mockResolvedValueOnce(doneStatuses([9]));
      const mockFixRound = jest.fn().mockResolvedValue({ sessionId: 'sess-2' });
      const mockAppendToLogFile = getMockAppendToLogFile();
      mockAppendToLogFile.mockClear();

      const outcome = await service.run({ ...subsetParams(), runFixRound: mockFixRound });

      expect(outcome.summary?.pending).toBe(0);
      expect(mockAiExecute).toHaveBeenCalledTimes(3);
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'WARN', 'step-verify.assess.partial missing-index=9', 'step-verification',
      );
      const roundTwoFixPrompt: string = mockFixRound.mock.calls[1][0];
      expect(roundTwoFixPrompt).toContain('Step 9 (not-done)');
      expect(roundTwoFixPrompt).toContain('Not assessed in this round; assessor response omitted this index.');
    });

    it('tolerates duplicate and unexpected pull indices alongside valid ones without a retry', async () => {
      mockPullAssess.mockResolvedValueOnce(pullResult([
        { index: 0, status: 'done' },
        { index: 0, status: 'not-done', missing: 'duplicate result' },
        { index: 9, status: 'done' },
        { index: 1, status: 'done' },
      ]));

      const outcome = await service.run(makeRunParams({ modeDirective: pullDirective, steps: ['Step A', 'Step B'] }));

      expect(outcome.summary?.pending).toBe(0);
      expect(mockPullAssess).toHaveBeenCalledTimes(1);
    });
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

  it('includes an oversized untracked file whole when it fits under the ceiling', async () => {
    mockGitGetStatus.mockResolvedValue({ not_added: ['new-file.ts'] });
    const { readFileSync: mockReadFileSync } = jest.requireMock('node:fs');
    mockReadFileSync.mockReturnValue(Buffer.from('x'.repeat(60_000)));
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    mockAppendToLogFile.mockClear();

    await service.run(makeRunParams());

    const prompt: string = mockAiExecute.mock.calls[0][0].prompt;
    expect(prompt).toContain(`### new-file.ts\n\`\`\`\n${'x'.repeat(60_000)}\n\`\`\``);
    expect(prompt).not.toContain('evidence gap');
    expect(prompt).not.toContain('disclosed evidence gap');
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'INFO', 'step-verify.evidence.budget measured=60000 budget=60000 files=0 untracked=1', 'step-verification',
    );
    expect(mockAppendToLogFile).not.toHaveBeenCalledWith('WARN', expect.stringContaining('step-verify.diff.truncated'), expect.anything());
  });

  it('degrades an over-ceiling single-file group to head and tail slices and warns on unverifiable', async () => {
    mockGitGetStatus.mockResolvedValue({ not_added: ['new-file.ts'] });
    const { readFileSync: mockReadFileSync } = jest.requireMock('node:fs');
    mockReadFileSync.mockReturnValue(Buffer.from(`HEAD${'m'.repeat(300_000)}TAIL`));
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'unverifiable', missing: 'new-file.ts gap' }] }),
    });
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    mockAppendToLogFile.mockClear();

    await service.run(makeRunParams({ steps: ['Edit new-file.ts'] }));

    const prompt: string = mockAiExecute.mock.calls[0][0].prompt;
    expect(prompt).toContain('HEAD');
    expect(prompt).toContain('[... evidence gap:');
    expect(prompt).toContain('## Evidence completeness');
    expect(prompt).toContain('TAIL\n```');
    expect(prompt).toMatch(/- unverifiable: ONLY for temporal, process, or investigation claims that evidence cannot in principle prove or disprove, and for steps whose only doubt lies beyond a disclosed evidence gap/);
    expect(prompt).not.toContain('disprove (requires missing field)\n- Paths');
    expect(mockAppendToLogFile).not.toHaveBeenCalledWith('INFO', expect.stringContaining('step-verify.assess.phased'), expect.anything());
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'WARN', expect.stringContaining('step-verify.diff.truncated paths=new-file.ts'), 'step-verification',
    );
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'WARN', 'step-verify.unverifiable.evidence-gap indices=0 paths=new-file.ts', 'step-verification',
    );
  });

  it('logs the evidence budget for an only-untracked change with an empty changed-files list', async () => {
    mockGitGetStatus.mockResolvedValue({ not_added: ['new-file.ts'] });
    const { readFileSync: mockReadFileSync } = jest.requireMock('node:fs');
    mockReadFileSync.mockReturnValue(Buffer.from('content'));
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    mockAppendToLogFile.mockClear();

    await service.run(makeRunParams());

    expect(mockAiExecute.mock.calls[0][0].prompt).toContain('### new-file.ts');
    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'INFO', 'step-verify.evidence.budget measured=7 budget=60000 files=0 untracked=1', 'step-verification',
    );
  });

  it('does not emit the evidence-gap warning when unverifiable arrives without evidence gaps', async () => {
    mockAiExecute.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'unverifiable', missing: 'ordering' }] }),
    });
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    mockAppendToLogFile.mockClear();

    await service.run(makeRunParams());

    expect(mockAppendToLogFile).not.toHaveBeenCalledWith(
      'WARN', expect.stringContaining('step-verify.unverifiable.evidence-gap'), expect.anything(),
    );
  });

  it('phases assessment by step groups when evidence exceeds the ceiling', async () => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      if (args.includes('--name-status')) {
        callback(null, { stdout: 'M\tsrc/a.ts\nM\tsrc/b.ts' });
        return;
      }
      callback(null, { stdout: (args.includes('src/a.ts') ? 'a' : 'b').repeat(150_000) });
    });
    mockAiExecute.mockImplementation(({ prompt }: { prompt: string }) => Promise.resolve({
      content: JSON.stringify({ statuses: [{ index: prompt.includes('[Plan step 0]') ? 0 : 1, status: 'done' }] }),
    }));
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    mockAppendToLogFile.mockClear();

    const outcome = await service.run(makeRunParams({ steps: ['Edit src/a.ts', 'Edit src/b.ts'] }));

    expect(mockAiExecute).toHaveBeenCalledTimes(2);
    const [first, second]: string[] = mockAiExecute.mock.calls.map(call => call[0].prompt);
    expect(first).toContain('[Plan step 0]');
    expect(first).not.toContain('[Plan step 1]');
    expect(second).toContain('[Plan step 1]');
    expect(second).not.toContain('[Plan step 0]');
    for (const prompt of [first, second]) expect(prompt).toContain('M\tsrc/a.ts\nM\tsrc/b.ts');
    expect(first).toContain('a'.repeat(150_000));
    expect(second).toContain('b'.repeat(150_000));
    expect(first).not.toContain('evidence gap');
    expect(outcome.summary).toMatchObject({ pending: 0, done: 2 });
    expect(mockAppendToLogFile).toHaveBeenCalledWith('INFO', 'step-verify.assess.phased groups=2', 'step-verification');
    expect(mockAppendToLogFile).not.toHaveBeenCalledWith('WARN', expect.stringContaining('step-verify.diff.truncated'), expect.anything());
  });

  it('renders a binary untracked file as a placeholder without reporting a gap', async () => {
    mockGitGetStatus.mockResolvedValue({ not_added: ['img.png'] });
    const { readFileSync: mockReadFileSync } = jest.requireMock('node:fs');
    mockReadFileSync.mockReturnValue(Buffer.from([1, 0, 2, 3]));
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });

    await service.run(makeRunParams());

    const prompt: string = mockAiExecute.mock.calls[0][0].prompt;
    expect(prompt).toContain('### img.png\n[binary file, 4 bytes]');
    expect(prompt).not.toContain('## Evidence completeness');
  });

  it('prioritizes plan affectedFiles with the repo prefix stripped when run() collects evidence', async () => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    const diffedPaths: string[] = [];
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      if (args.includes('--name-status')) {
        callback(null, { stdout: 'M\tsrc/a.ts\nM\tsrc/b.ts' });
        return;
      }
      diffedPaths.push(args.at(-1) ?? '');
      callback(null, { stdout: 'd' });
    });
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });

    await service.run(makeRunParams({ repoDir: '/repos/shop', affectedFiles: ['shop/src/b.ts'] }));

    expect(diffedPaths).toEqual(['src/b.ts', 'src/a.ts']);
  });

  it('warns when the assembled prompt exceeds the oversize threshold', async () => {
    mockGitGetStatus.mockResolvedValue({ not_added: [] });
    const longStep = 's'.repeat(310_000);
    mockAiExecute.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }) });
    const { appendToLogFile: mockAppendToLogFile } = jest.requireMock('../shared/logger/log-file-writer');
    mockAppendToLogFile.mockClear();

    await service.run(makeRunParams({ steps: [longStep] }));

    expect(mockAppendToLogFile).toHaveBeenCalledWith(
      'WARN', expect.stringContaining('step-verify.prompt.oversize chars='), 'step-verification',
    );
  });

  it('discloses sections that fit no phased group as an evidence gap in each group prompt', async () => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
      if (args.includes('--name-status')) {
        callback(null, { stdout: 'M\tsrc/a.ts\nM\tsrc/b.ts\nM\tsrc/orphan.ts' });
        return;
      }
      callback(null, { stdout: 'z'.repeat(args.includes('src/orphan.ts') ? 100_000 : 150_000) });
    });
    mockAiExecute.mockImplementation(({ prompt }: { prompt: string }) => Promise.resolve({
      content: JSON.stringify({ statuses: [{ index: prompt.includes('[Plan step 0]') ? 0 : 1, status: 'done' }] }),
    }));

    await service.run(makeRunParams({ steps: ['Edit src/a.ts', 'Edit src/b.ts'] }));

    for (const call of mockAiExecute.mock.calls) {
      expect(call[0].prompt).toContain('## Evidence completeness');
      expect(call[0].prompt).toContain('src/orphan.ts');
      expect(call[0].prompt).toContain('disclosed evidence gap');
    }
  });

  it('logs omitted tracked paths and retries a loud git collection failure', async () => {
    const mockExecFile = jest.requireMock('node:child_process').execFile as jest.Mock;
    const paths = Array.from({ length: 40 }, (_, index) => `src/${index}.ts`);
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

  it('passes execution evidence to the pull assessor and calls getStatus', async () => {
    mockPullAssess.mockResolvedValue(pullResult([{ index: 0, status: 'done' }]));

    await service.run(makeRunParams({
      modeDirective: pullDirective,
      verificationOutcomes: [{ id: 'v1', command: 'yarn test', policy: 'enforced', status: 'passed' }],
      commitPolicy: { allowsCommit: false, complexity: 'high' } as never,
    }));

    expect(mockPullAssess).toHaveBeenCalled();
    expect(mockAiExecute).not.toHaveBeenCalled();
    expect(mockGitGetStatus).toHaveBeenCalled();
    expect(mockPullAssess.mock.calls[0][0].executionEvidenceSection).toContain('## Command execution evidence');
  });

  describe('pull coverage cross-check', () => {
    const mockChecklist = (nameStatus: string): void => {
      const { execFile: mockExecFile } = jest.requireMock('node:child_process');
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, callback: (error: null, result: { stdout: string }) => void) => {
          callback(null, { stdout: args.includes('--name-status') ? nameStatus : 'diff body' });
        },
      );
    };

    it('downgrades a done step that mentions an uninspected checklist path', async () => {
      mockChecklist('M\tsrc/a.ts\nM\tsrc/b.ts\n');
      mockPullAssess.mockResolvedValue(pullResult([{ index: 0, status: 'done' }], ['src/b.ts']));
      const mockAppendToLogFile = getMockAppendToLogFile();
      mockAppendToLogFile.mockClear();

      const outcome = await service.run(makeRunParams({
        modeDirective: pullDirective, steps: ['Edit src/a.ts'], runFixRound: jest.fn(),
      }));

      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'WARN', 'step-verify.pull.coverage-gap indices=0 paths=src/a.ts', 'step-verification',
      );
      expect(mockAppendToLogFile).toHaveBeenCalledWith(
        'INFO', expect.stringContaining('step-verify.status index=0 status=unverifiable missing='), 'step-verification',
      );
      expect(outcome.summary).toMatchObject({ unverifiable: 1, pending: 0 });
    });

    it('does not downgrade under full coverage and ignores extra reported paths', async () => {
      mockChecklist('M\tsrc/a.ts\n');
      mockPullAssess.mockResolvedValue(pullResult([{ index: 0, status: 'done' }], ['./src/a.ts', 'src/extra.ts']));
      const mockAppendToLogFile = getMockAppendToLogFile();
      mockAppendToLogFile.mockClear();

      const outcome = await service.run(makeRunParams({ modeDirective: pullDirective, steps: ['Edit src/a.ts'] }));

      expect(outcome.summary).toMatchObject({ unverifiable: 0, done: 1 });
      expect(mockAppendToLogFile).not.toHaveBeenCalledWith(
        'WARN', expect.stringContaining('step-verify.pull.coverage-gap'), expect.anything(),
      );
    });

    it('retries the attempt when the assessor reports no inspectedPaths for a non-empty checklist', async () => {
      mockChecklist('M\tsrc/a.ts\n');
      mockPullAssess
        .mockResolvedValueOnce(pullResult([{ index: 0, status: 'done' }], []))
        .mockResolvedValueOnce(pullResult([{ index: 0, status: 'done' }], ['src/a.ts']));

      const outcome = await service.run(makeRunParams({ modeDirective: pullDirective, steps: ['Edit src/a.ts'] }));

      expect(mockPullAssess).toHaveBeenCalledTimes(2);
      expect(outcome.summary).toMatchObject({ unverifiable: 0, done: 1 });
    });

    it('skips the cross-check when the checklist is empty', async () => {
      mockPullAssess.mockResolvedValue(pullResult([{ index: 0, status: 'done' }], []));

      const outcome = await service.run(makeRunParams({ modeDirective: pullDirective, steps: ['Edit src/a.ts'] }));

      expect(outcome.summary).toMatchObject({ unverifiable: 0, done: 1 });
    });
  });

  describe('applyPullCoverageDowngrades', () => {
    const steps = [{ index: 0, text: 'Edit src/a.ts' }, { index: 1, text: 'Edit src/c.ts' }];

    it('downgrades done and not-applicable steps naming an uncovered path and leaves others', () => {
      const statuses: StepAssessment[] = [
        { index: 0, status: 'not-applicable' },
        { index: 1, status: 'done' },
      ];
      const result = applyPullCoverageDowngrades({
        statuses, steps, uncoveredPaths: ['src/a.ts'], repoDir: '/repos/shop',
      });
      expect(result[0]).toEqual({ index: 0, status: 'unverifiable', missing: expect.stringContaining('src/a.ts') });
      expect(result[1]).toBe(statuses[1]);
    });

    it('normalizes ./ and repoDir prefixes on uncovered paths', () => {
      const statuses: StepAssessment[] = [{ index: 0, status: 'done' }, { index: 1, status: 'done' }];
      const result = applyPullCoverageDowngrades({
        statuses, steps, uncoveredPaths: ['./src/a.ts', '/repos/shop/src/c.ts'], repoDir: '/repos/shop',
      });
      expect(result.map(r => r.status)).toEqual(['unverifiable', 'unverifiable']);
    });

    it('matches paths on boundaries so src/a.tsx does not mention src/a.ts', () => {
      const statuses: StepAssessment[] = [{ index: 0, status: 'done' }];
      const result = applyPullCoverageDowngrades({
        statuses, steps: [{ index: 0, text: 'Edit src/a.tsx' }], uncoveredPaths: ['src/a.ts'], repoDir: '/repo',
      });
      expect(result).toEqual(statuses);
    });

    it('never downgrades partially-done or not-done steps', () => {
      const statuses: StepAssessment[] = [{ index: 0, status: 'not-done', missing: 'x' }];
      const result = applyPullCoverageDowngrades({
        statuses, steps, uncoveredPaths: ['src/a.ts'], repoDir: '/repo',
      });
      expect(result).toEqual(statuses);
    });
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

describe('buildPlanStepVerificationPrompt needle search reminder', () => {
  it('tells the fixer to search case-insensitively across the whole repository', () => {
    const pending = [{ index: 0, status: 'missing', missing: 'x' }] as never;
    const prompt = buildPlanStepVerificationPrompt({ pending, round: 1, stepTexts: new Map([[0, 'step']]) });
    expect(prompt).toContain('case-insensitively across the whole repository');
  });
});
