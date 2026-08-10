import { Test } from '@nestjs/testing';
import { AiService } from '../../integrations/ai/ai.service';
import { CommitStageService } from './commit-stage.service';
import { AiProviderError } from '../../shared/utils/errors';

describe('CommitStageService', () => {
  const buildService = async () => {
    const module = await Test.createTestingModule({
      providers: [
        CommitStageService,
        {
          provide: AiService,
          useValue: {
            execute: jest.fn().mockResolvedValue({
              content: 'fix(auth): restore login redirect',
            }),
            generateCommitMessage: jest.fn().mockResolvedValue('fix: restore login redirect'),
          },
        },
      ],
    }).compile();

    return {
      service: module.get(CommitStageService),
      aiService: module.get(AiService),
    };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates a conventional commit message from the standalone command prompt path', async () => {
    const { service, aiService } = await buildService();

    const message = await service.generateCommitMessage({
      diff: 'diff --git a/file b/file',
      ticketKey: 'WBP-123',
      conventional: true,
    });

    expect(aiService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'commit',
      })
    );
    expect(message).toBe('WBP-123: fix(auth): restore login redirect');
  });

  it('normalizes agent-generated commit messages to a single ticket prefix', async () => {
    const { service, aiService } = await buildService();

    const message = await service.generateCommitMessage({
      diff: 'diff --git a/file b/file',
      ticketKey: 'WBP-123',
      commitHistory: ['WBP-100: previous change'],
      ticketContext: 'Fix login callback handling',
    });

    expect(aiService.generateCommitMessage).toHaveBeenCalledWith(
      'diff --git a/file b/file',
      ['WBP-100: previous change'],
      'auto',
      'Fix login callback handling'
    );
    expect(message).toBe('WBP-123: restore login redirect');
  });

  it('raises an AiProviderError instead of normalizing a blank standalone commit response', async () => {
    const { service, aiService } = await buildService();
    (aiService.execute as jest.Mock).mockResolvedValueOnce({
      content: '',
      provider: 'openai',
      model: 'gpt-5.4',
    });

    await expect(
      service.generateCommitMessage({
        diff: 'diff --git a/file b/file',
        ticketKey: 'WBP-123',
        conventional: true,
      })
    ).rejects.toMatchObject({
      message: 'AI provider returned an empty commit message response',
      details: expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    } satisfies Partial<AiProviderError>);
  });
});
