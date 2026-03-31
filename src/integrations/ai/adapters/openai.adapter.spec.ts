import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import { LoggerService } from '../../../shared/logger/logger.service';
import { OpenAIAdapter } from './openai.adapter';
import { loadAiContextConfig } from './load-ai-context-config';

jest.mock('./load-ai-context-config', () => ({
  loadAiContextConfig: jest.fn(),
}));

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

  beforeEach(() => {
    jest.clearAllMocks();
    (
      loadAiContextConfig as jest.MockedFunction<typeof loadAiContextConfig>
    ).mockResolvedValue('');
  });

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
      (adapter as unknown as { model: string }).model = 'gpt-5.4';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({
        prompt: 'hello',
      });

      const request = mockCreate.mock.calls[0]?.[0];

      expect(request?.model).toBe('gpt-5.4');
      expect(request?.max_completion_tokens).toBe(4096);
      expect(request?.max_tokens).toBeUndefined();
    });
  });

  describe('onModuleInit', () => {
    it('loads global and project config from .openai/OPENAI.md paths', async () => {
      const adapter = createAdapter();

      await adapter.onModuleInit();

      expect(loadAiContextConfig).toHaveBeenCalledWith(
        path.join(os.homedir(), '.openai', 'OPENAI.md'),
        '.openai/OPENAI.md',
        'openai',
      );
    });
  });
});
