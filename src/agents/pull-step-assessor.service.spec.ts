import { Test, TestingModule } from '@nestjs/testing';
import { PullStepAssessorService, buildPullStepAssessorPrompt } from './pull-step-assessor.service';
import { StageAgentService } from '../integrations/ai/stage-agent.service';
import { pullStepAssessmentResponseJsonSchema } from '../common/schemas/step-verification.schema';

const baseParams = {
  repoDir: '/repo',
  baseRef: 'HEAD',
  changedPaths: ['src/a.ts'],
  untrackedPaths: [] as string[],
};

const donePayload = (inspectedPaths: string[] = ['src/a.ts']): string =>
  JSON.stringify({ statuses: [{ index: 0, status: 'done' }], inspectedPaths });

describe('buildPullStepAssessorPrompt', () => {
  afterEach(() => jest.restoreAllMocks());

  const buildPrompt = (overrides: Partial<Parameters<typeof buildPullStepAssessorPrompt>[0]> = {}): string =>
    buildPullStepAssessorPrompt({
      steps: [{ index: 2, text: 'Step C' }],
      baseRef: 'abc123',
      changedPaths: [],
      untrackedPaths: [],
      ...overrides,
    });

  it('requires repository inspection before assessment', () => {
    const prompt = buildPrompt();
    expect(prompt).toContain('git diff abc123 --stat');
    expect(prompt).toContain('git diff abc123 -- <path>');
    expect(prompt).toContain('[Plan step 2]');
    expect(prompt).toMatch(/not-done:.*could not find/);
    expect(prompt).toMatch(/unverifiable: ONLY/);
  });

  it('renders the response example from the real indices and forbids renumbering', () => {
    const steps = [5, 6, 8, 9].map(index => ({ index, text: `Step ${index}` }));
    const prompt = buildPrompt({ steps });
    expect(prompt).toContain(
      '{"statuses":[{"index":5,"status":"done"},{"index":6,"status":"partially-done","missing":"…"}],'
      + '"inspectedPaths":["src/example.ts"]}',
    );
    expect(prompt).toContain('Use the exact N from each [Plan step N] tag — never renumber from 0.');
    expect(prompt).not.toContain('{"index":0,"status":"done"}');
  });

  it('contains the unverifiable rule line verbatim', () => {
    expect(buildPrompt()).toContain(
      '- unverifiable: ONLY for temporal, process, or investigation claims that repository state cannot in principle prove or disprove (requires missing field)',
    );
  });

  it('lists every changed and untracked path in a mandatory inspection checklist', () => {
    const prompt = buildPrompt({ changedPaths: ['src/a.ts', 'src/b.ts'], untrackedPaths: ['src/new.ts'] });
    expect(prompt).toContain('## Mandatory inspection checklist');
    expect(prompt).toContain('git diff abc123 -- src/a.ts');
    expect(prompt).toContain('git diff abc123 -- src/b.ts');
    expect(prompt).toContain('src/new.ts');
    expect(prompt).toMatch(/untracked.*read/i);
    expect(prompt).toMatch(/every hunk/i);
    expect(prompt).toMatch(/before (?:judging|assessing)/i);
  });

  it('includes the execution-evidence section verbatim when supplied', () => {
    const section = '## Command execution evidence\n- yarn test: passed';
    expect(buildPrompt({ executionEvidenceSection: section })).toContain(section);
    expect(buildPrompt()).not.toContain('## Command execution evidence');
  });
});

describe('PullStepAssessorService', () => {
  let service: PullStepAssessorService;
  let mockChatTurn: jest.Mock;

  beforeEach(async () => {
    mockChatTurn = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PullStepAssessorService,
        { provide: StageAgentService, useValue: { chatTurn: mockChatTurn } },
      ],
    }).compile();
    service = module.get(PullStepAssessorService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('runs a fresh repository-scoped structured chat turn', async () => {
    mockChatTurn.mockResolvedValue({ content: donePayload(), session: { provider: 'anthropic' } });

    const result = await service.assess({ ...baseParams, steps: [{ index: 0, text: 'Step A' }] });

    expect(result).toEqual({ statuses: [{ index: 0, status: 'done' }], inspectedPaths: ['src/a.ts'] });
    expect(mockChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'implement',
      repoDir: '/repo',
      structuredOutput: { name: 'plan_step_assessment', schema: pullStepAssessmentResponseJsonSchema },
    }));
    expect(mockChatTurn.mock.calls[0][0].session).toBeUndefined();
    expect(mockChatTurn.mock.calls[0][0].responseValidator.label).toBe('plan_step_assessment');
  });

  it('forwards supported overrides and rejects unsupported pull providers', async () => {
    mockChatTurn.mockResolvedValue({ content: donePayload(), session: { provider: 'anthropic' } });

    await service.assess({
      ...baseParams, steps: [{ index: 0, text: 'Step A' }],
      provider: 'openai', model: 'gpt-5.6-terra',
    });

    expect(mockChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      providerOverride: 'openai', modelOverride: 'gpt-5.6-terra',
    }));
    await expect(service.assess({
      ...baseParams, steps: [{ index: 0, text: 'Step A' }], provider: 'google',
    })).rejects.toThrow('unsupported for provider');
  });

  it('forwards backend as backendOverride when set, omits it when absent', async () => {
    mockChatTurn.mockResolvedValue({ content: donePayload(), session: {} });

    await service.assess({ ...baseParams, steps: [{ index: 0, text: 'A' }], backend: 'cli' });
    expect(mockChatTurn).toHaveBeenCalledWith(expect.objectContaining({ backendOverride: 'cli' }));

    mockChatTurn.mockClear();
    await service.assess({ ...baseParams, steps: [{ index: 0, text: 'A' }] });
    expect(mockChatTurn.mock.calls[0][0]).not.toHaveProperty('backendOverride');
  });

  it('rejects invalid payloads and propagates chat failures', async () => {
    mockChatTurn.mockResolvedValue({ content: 'not json', session: { provider: 'anthropic' } });
    await expect(service.assess({ ...baseParams, steps: [{ index: 0, text: 'A' }] })).rejects.toThrow();
    mockChatTurn.mockRejectedValue(new Error('cli exited 1'));
    await expect(service.assess({ ...baseParams, steps: [{ index: 0, text: 'A' }] })).rejects.toThrow('cli exited 1');
  });

  it('supplies a schema validator that rejects bad statuses and missing inspectedPaths', async () => {
    mockChatTurn.mockResolvedValue({ content: donePayload(), session: { provider: 'anthropic' } });
    await service.assess({ ...baseParams, steps: [{ index: 0, text: 'A' }] });
    const { parse } = mockChatTurn.mock.calls[0][0].responseValidator;
    expect(() => parse({ statuses: [{ index: 0, status: 'skipped' }], inspectedPaths: [] })).toThrow();
    expect(() => parse({ statuses: [{ index: 0, status: 'done' }] })).toThrow();
  });
});
