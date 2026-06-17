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
  temperature?: number;
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
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'ai.openaiApiKey') return 'test-key';
        if (key === 'ai.model') return 'gpt-5.4';
        if (key === 'ai.providers') {
          return [
            {
              provider: 'openai',
              apiKey: 'test-key',
              model: 'gpt-5.4',
              default: true,
            },
          ];
        }
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

    it('ignores config-level ai.maxTokens during initialization', async () => {
      const mockConfigService = {
        get: jest.fn((key: string, defaultValue?: string | number) => {
          if (key === 'ai.openaiApiKey') return 'test-key';
          if (key === 'ai.model') return 'gpt-5.4';
          if (key === 'ai.maxTokens') return 1234;
          return defaultValue;
        }),
      } as unknown as ConfigService;
      const adapter = new OpenAIAdapter(mockConfigService, mockLogger);

      (
        adapter as unknown as { initializeClient: () => void }
      ).initializeClient();

      expect((adapter as unknown as { maxTokens: number }).maxTokens).toBe(
        4096,
      );
    });

    it('omits temperature for reasoning models', async () => {
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
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });

      (adapter as unknown as { client: OpenAI }).client = {
        chat: { completions: { create: mockCreate } },
      } as unknown as OpenAI;
      (adapter as unknown as { model: string }).model = 'o4-mini';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({ prompt: 'hello' });

      const request = mockCreate.mock.calls[0]?.[0];
      expect(request?.model).toBe('o4-mini');
      expect(request?.temperature).toBeUndefined();
    });

    it('includes temperature for non-reasoning models', async () => {
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
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });

      (adapter as unknown as { client: OpenAI }).client = {
        chat: { completions: { create: mockCreate } },
      } as unknown as OpenAI;
      (adapter as unknown as { model: string }).model = 'gpt-4.1';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({ prompt: 'hello' });

      const request = mockCreate.mock.calls[0]?.[0];
      expect(request?.model).toBe('gpt-4.1');
      expect(request?.temperature).toBe(0.7);
    });

    it('omits temperature for reasoning models in executeWithHistory', async () => {
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
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });

      (adapter as unknown as { client: OpenAI }).client = {
        chat: { completions: { create: mockCreate } },
      } as unknown as OpenAI;
      (adapter as unknown as { model: string }).model = 'o3';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.executeWithHistory({
        messages: [{ role: 'user', content: 'hello' }],
      });

      const request = mockCreate.mock.calls[0]?.[0];
      expect(request?.model).toBe('o3');
      expect(request?.temperature).toBeUndefined();
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
        true,
      );
    });
  });
});
