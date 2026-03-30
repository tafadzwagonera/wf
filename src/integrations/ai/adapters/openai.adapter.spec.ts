import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { LoggerService } from '../../../shared/logger/logger.service';
import { OpenAIAdapter } from './openai.adapter';

interface MockChatCompletionRequest {
  model: string;
  max_completion_tokens?: number;
  max_tokens?: number;
}

describe('OpenAIAdapter', () => {
  const mockLogger = {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as LoggerService;

  const createAdapter = (): OpenAIAdapter => {
    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: string | number) => {
        if (key === 'ai.openaiApiKey') return 'test-key';
        if (key === 'ai.model') return 'gpt-5.4';
        if (key === 'ai.maxTokens') return 4096;
        return defaultValue;
      }),
    } as unknown as ConfigService;

    return new OpenAIAdapter(mockConfigService, mockLogger);
  };

  describe('execute', () => {
    it('uses max_completion_tokens for gpt-5 models', async () => {
      const adapter = createAdapter();
      const mockCreate = jest
        .fn<
          Promise<{
            choices: Array<{ message: { content: string } }>;
            usage: { prompt_tokens: number; completion_tokens: number };
          }>,
          [MockChatCompletionRequest]
        >()
        .mockResolvedValue({
          choices: [{ message: { content: 'ok' } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
          },
        });

      (adapter as unknown as { client: OpenAI }).client = {
        chat: {
          completions: {
            create: mockCreate,
          },
        },
      } as unknown as OpenAI;

      await adapter.execute({
        prompt: 'hello',
      });

      const request = mockCreate.mock.calls[0]?.[0];

      expect(request?.model).toBe('gpt-5.4');
      expect(request?.max_completion_tokens).toBe(4096);
      expect(request?.max_tokens).toBeUndefined();
    });
  });
});
