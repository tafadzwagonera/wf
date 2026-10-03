import { Test, TestingModule } from '@nestjs/testing';
import { PullStepAssessorService, buildPullStepAssessorPrompt } from './pull-step-assessor.service';
import { StageAgentService } from '../integrations/ai/stage-agent.service';
import { stepAssessmentResponseJsonSchema } from '../shared/schemas/step-verification.schema';

describe('buildPullStepAssessorPrompt', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requires repository inspection before assessment', () => {
    const prompt = buildPullStepAssessorPrompt([{ index: 2, text: 'Step C' }], 'abc123');
    expect(prompt).toContain('git diff abc123 --stat');
    expect(prompt).toContain('git diff abc123 -- <path>');
    expect(prompt).toContain('[Plan step 2]');
    expect(prompt).toMatch(/not-done:.*could not find/);
    expect(prompt).toMatch(/unverifiable: ONLY/);
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
    mockChatTurn.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }),
      session: { provider: 'anthropic' },
    });

    const statuses = await service.assess({ steps: [{ index: 0, text: 'Step A' }], repoDir: '/repo', baseRef: 'HEAD' });

    expect(statuses).toEqual([{ index: 0, status: 'done' }]);
    expect(mockChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'implement',
      repoDir: '/repo',
      structuredOutput: { name: 'plan_step_assessment', schema: stepAssessmentResponseJsonSchema },
    }));
    expect(mockChatTurn.mock.calls[0][0].session).toBeUndefined();
    expect(mockChatTurn.mock.calls[0][0].responseValidator.label).toBe('plan_step_assessment');
  });

  it('forwards supported overrides and rejects unsupported pull providers', async () => {
    mockChatTurn.mockResolvedValue({
      content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }),
      session: { provider: 'anthropic' },
    });

    await service.assess({
      steps: [{ index: 0, text: 'Step A' }], repoDir: '/repo', baseRef: 'HEAD',
      provider: 'openai', model: 'gpt-5.6-terra',
    });

    expect(mockChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      providerOverride: 'openai', modelOverride: 'gpt-5.6-terra',
    }));
    await expect(service.assess({
      steps: [{ index: 0, text: 'Step A' }], repoDir: '/repo', baseRef: 'HEAD', provider: 'google',
    })).rejects.toThrow('unsupported for provider');
  });

  it('forwards backend as backendOverride when set, omits it when absent', async () => {
    mockChatTurn.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }), session: {} });

    await service.assess({ steps: [{ index: 0, text: 'A' }], repoDir: '/repo', baseRef: 'HEAD', backend: 'cli' });
    expect(mockChatTurn).toHaveBeenCalledWith(expect.objectContaining({ backendOverride: 'cli' }));

    mockChatTurn.mockClear();
    await service.assess({ steps: [{ index: 0, text: 'A' }], repoDir: '/repo', baseRef: 'HEAD' });
    expect(mockChatTurn.mock.calls[0][0]).not.toHaveProperty('backendOverride');
  });

  it('rejects invalid payloads and propagates chat failures', async () => {
    mockChatTurn.mockResolvedValue({ content: 'not json', session: { provider: 'anthropic' } });
    await expect(service.assess({ steps: [{ index: 0, text: 'A' }], repoDir: '/repo', baseRef: 'HEAD' })).rejects.toThrow();
    mockChatTurn.mockRejectedValue(new Error('cli exited 1'));
    await expect(service.assess({ steps: [{ index: 0, text: 'A' }], repoDir: '/repo', baseRef: 'HEAD' })).rejects.toThrow('cli exited 1');
  });

  it('supplies a schema validator for chat backend retries', async () => {
    mockChatTurn.mockResolvedValue({ content: JSON.stringify({ statuses: [{ index: 0, status: 'done' }] }), session: { provider: 'anthropic' } });
    await service.assess({ steps: [{ index: 0, text: 'A' }], repoDir: '/repo', baseRef: 'HEAD' });
    expect(() => mockChatTurn.mock.calls[0][0].responseValidator.parse({ statuses: [{ index: 0, status: 'skipped' }] })).toThrow();
  });
});
