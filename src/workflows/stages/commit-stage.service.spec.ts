import { Test } from '@nestjs/testing';
import { AiService } from '../../integrations/ai/ai.service';
import { CommitStageService } from './commit-stage.service';
import { AiProviderError } from '../../common/utils/errors';

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

  it('instructs the model to use "feat" only for new behavior, not behavior-preserving fixes', async () => {
    const { service, aiService } = await buildService();
    const execute = aiService.execute as jest.Mock;

    await service.generateCommitMessage({
      diff: 'diff --git a/file b/file',
      ticketKey: 'WBP-123',
      conventional: true,
    });

    const prompt = execute.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Use "feat" only when the change introduces new behavior');
  });

  it('omits conventional-format examples and instructions when --conventional is not requested', async () => {
    const { service, aiService } = await buildService();
    const execute = aiService.execute as jest.Mock;
    execute.mockResolvedValueOnce({ content: 'JWT token validation' });

    await service.generateCommitMessage({ diff: 'diff --git a/file b/file', ticketKey: 'WBP-123' });

    const prompt = execute.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain('Use conventional commits format');
    expect(prompt).not.toContain('feat(auth):');
    expect(prompt).toContain('"JWT token validation"');
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

  it('retries the standalone prompt when the type implies docs-only but source files changed', async () => {
    const { service, aiService } = await buildService();
    const execute = aiService.execute as jest.Mock;
    execute
      .mockResolvedValueOnce({ content: 'docs(review): document the thing' })
      .mockResolvedValueOnce({ content: 'fix(review): isolate verification in a worktree' });

    const diff = 'diff --git a/src/app.ts b/src/app.ts\n+++ b/src/app.ts\n+const x = 1;\n'
      + 'diff --git a/README.md b/README.md\n+++ b/README.md\n+docs line\n';

    const message = await service.generateCommitMessage({ diff, ticketKey: 'WBP-123', conventional: true });

    expect(execute).toHaveBeenCalledTimes(2);
    const secondPrompt = execute.mock.calls[1][0].prompt as string;
    expect(secondPrompt).toContain('Correction:');
    expect(message).toBe('WBP-123: fix(review): isolate verification in a worktree');
  });

  it('does not retry the standalone prompt when the changeset really is docs-only', async () => {
    const { service, aiService } = await buildService();
    const execute = aiService.execute as jest.Mock;
    execute.mockResolvedValueOnce({ content: 'docs(review): document the thing' });

    const diff = 'diff --git a/README.md b/README.md\n+++ b/README.md\n+docs line\n';

    await service.generateCommitMessage({ diff, ticketKey: 'WBP-123', conventional: true });

    expect(execute).toHaveBeenCalledTimes(1);
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
