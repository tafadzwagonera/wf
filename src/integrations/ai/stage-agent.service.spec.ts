import { ConfigService } from '@nestjs/config';
import { StageAgentService } from './stage-agent.service';

describe('StageAgentService', () => {
  const createConfigService = (): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'stages.plan.backend': 'agent',
          'stages.plan.provider': 'openai',
          'stages.plan.model': 'gpt-5.4',
          'stages.review.backend': 'agent',
          'stages.review.provider': 'openai',
          'stages.review.model': 'gpt-5.4',
          'stages.generate.backend': 'agent',
          'stages.generate.provider': 'openai',
          'stages.generate.model': 'gpt-5.4',
          'ai.provider': 'openai',
          'ai.model': 'gpt-5.4',
        };

        return key in values ? values[key] : defaultValue;
      }),
    }) as unknown as ConfigService;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('raises an AIError with provider metadata when the plan response is blank', async () => {
    const service = new StageAgentService(createConfigService());
    (
      service as unknown as {
        runStagePrompt: jest.Mock;
      }
    ).runStagePrompt = jest.fn().mockResolvedValue({ content: '  ' });

    await expect(
      service.generatePlan({
        action: 'fix',
        issueContent: 'Fix callback handling',
      })
    ).rejects.toMatchObject({
      message: 'AI provider returned an empty plan response',
      details: expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    });
  });

  it('raises an AIError with provider metadata when generated content is blank', async () => {
    const service = new StageAgentService(createConfigService());
    (
      service as unknown as {
        runStagePrompt: jest.Mock;
      }
    ).runStagePrompt = jest.fn().mockResolvedValue({ content: '' });

    await expect(service.generateFromPrompt('Summarise this diff')).rejects.toMatchObject({
      message: 'AI provider returned an empty generated content response',
      details: expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    });
  });

  it('raises an AIError with provider metadata when an OpenAI chat turn is blank', async () => {
    const service = new StageAgentService(createConfigService());
    (
      service as unknown as {
        resolveStageBackend: jest.Mock;
        resolveStageProvider: jest.Mock;
        openAiChatTurn: jest.Mock;
      }
    ).resolveStageBackend = jest.fn().mockReturnValue('agent');
    (
      service as unknown as {
        resolveStageProvider: jest.Mock;
        resolveStageBackend: jest.Mock;
        openAiChatTurn: jest.Mock;
      }
    ).resolveStageProvider = jest.fn().mockReturnValue('openai');
    (
      service as unknown as {
        resolveStageProvider: jest.Mock;
        resolveStageBackend: jest.Mock;
        openAiChatTurn: jest.Mock;
      }
    ).openAiChatTurn = jest.fn().mockResolvedValue({
      content: ' ',
      session: { provider: 'openai' },
    });

    await expect(
      service.chatTurn({
        stage: 'review',
        userMessage: 'Why is this failing?',
        systemPrompt: 'Help',
      })
    ).rejects.toMatchObject({
      message: 'AI provider returned an empty chat response',
      details: expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    });
  });

  it('forwards onProgress callback to runStagePrompt when generating a plan', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Fix it',
        steps: ['step 1'],
        estimatedComplexity: 'low',
        affectedFiles: [],
        risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    const onProgress = jest.fn();
    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix callback handling',
      onProgress,
    });

    expect(mockRunStagePrompt).toHaveBeenCalledWith(expect.objectContaining({ onProgress }));
  });

  it('forwards onProgress callback to runStagePrompt when generating from prompt', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({ content: 'Generated content' });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    const onProgress = jest.fn();
    await service.generateFromPrompt('Summarise this', onProgress);

    expect(mockRunStagePrompt).toHaveBeenCalledWith(expect.objectContaining({ onProgress }));
  });

  it('does not pass onProgress when not provided', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({ content: 'Generated content' });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generateFromPrompt('Summarise this');

    expect(mockRunStagePrompt).toHaveBeenCalledWith(expect.objectContaining({ onProgress: undefined }));
  });

  it('enables the review stage when backend is omitted from config', () => {
    const configService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'stages.review.provider': 'openai',
          'stages.review.model': 'gpt-5.4',
          'ai.provider': 'openai',
          'ai.model': 'gpt-5.4',
        };

        return key in values ? values[key] : defaultValue;
      }),
    } as unknown as ConfigService;

    const service = new StageAgentService(configService);

    expect(service.isEnabledForStage('review')).toBe(true);
  });
});
