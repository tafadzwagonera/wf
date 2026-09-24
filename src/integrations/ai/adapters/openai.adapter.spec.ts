import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import { LoggerService } from '../../../shared/logger/logger.service';
import { AiProviderError } from '../../../shared/utils/errors';
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
    (loadAiContextConfig as jest.MockedFunction<typeof loadAiContextConfig>).mockResolvedValue('');
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

      (adapter as unknown as { initializeClient: () => void }).initializeClient();

      expect((adapter as unknown as { maxTokens: number }).maxTokens).toBe(4096);
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

    it('omits temperature for gpt-5 frontier models', async () => {
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
      (adapter as unknown as { model: string }).model = 'gpt-5.5';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({ prompt: 'hello', temperature: 0.5 });

      const request = mockCreate.mock.calls[0]?.[0];
      expect(request?.model).toBe('gpt-5.5');
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

    it('uses caller-provided temperature for non-restricted models', async () => {
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

      await adapter.execute({ prompt: 'hello', temperature: 0 });

      const request = mockCreate.mock.calls[0]?.[0];
      expect(request?.temperature).toBe(0);
    });

    it('preserves empty-content diagnostics from the provider response', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: 'content_filter',
            message: {
              content: null,
              refusal: 'Blocked by policy',
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 0 },
      });

      (adapter as unknown as { client: OpenAI }).client = {
        chat: { completions: { create: mockCreate } },
      } as unknown as OpenAI;
      (adapter as unknown as { model: string }).model = 'gpt-5.4';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await expect(adapter.execute({ prompt: 'hello' })).resolves.toMatchObject({
        content: '',
        provider: 'openai',
        model: 'gpt-5.4',
        finishReason: 'content_filter',
        refusal: 'Blocked by policy',
      });
    });

    it('sends image_url content parts when screenshots present in context', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      (adapter as unknown as { client: OpenAI }).client = {
        chat: { completions: { create: mockCreate } },
      } as unknown as OpenAI;
      (adapter as unknown as { model: string }).model = 'gpt-5.4';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({
        prompt: 'Review code',
        context: {
          screenshots: [{ path: '/p/a.png', mediaType: 'image/png', base64: 'xyz' }],
        },
      });

      const call = mockCreate.mock.calls[0][0];
      const userMsg = call.messages.find((m: { role: string }) => m.role === 'user');
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content[0]).toMatchObject({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,xyz' },
      });
      expect(userMsg.content[1]).toMatchObject({ type: 'text', text: 'Review code' });
    });

    it('sends plain string content when no screenshots in context', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      (adapter as unknown as { client: OpenAI }).client = {
        chat: { completions: { create: mockCreate } },
      } as unknown as OpenAI;
      (adapter as unknown as { model: string }).model = 'gpt-5.4';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({ prompt: 'Review code' });

      const call = mockCreate.mock.calls[0][0];
      const userMsg = call.messages.find((m: { role: string }) => m.role === 'user');
      expect(typeof userMsg.content).toBe('string');
    });

    it('omits temperature for temperature-restricted models in executeWithHistory', async () => {
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

    it('omits temperature for gpt-5 frontier models in executeWithHistory', async () => {
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
      (adapter as unknown as { model: string }).model = 'gpt-5.5';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.executeWithHistory({
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
      });

      const request = mockCreate.mock.calls[0]?.[0];
      expect(request?.model).toBe('gpt-5.5');
      expect(request?.temperature).toBeUndefined();
    });
  });

  it('uses strict named JSON schema response format', async () => {
    const adapter = createAdapter();
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: '{"value":"ok"}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    (adapter as unknown as { client: OpenAI }).client = {
      chat: { completions: { create: mockCreate } },
    } as unknown as OpenAI;
    await adapter.execute({
      prompt: 'hello', structuredOutput: { name: 'example', schema: { type: 'object' } },
    });
    expect(mockCreate.mock.calls[0][0].response_format).toEqual({
      type: 'json_schema', json_schema: { name: 'example', schema: { type: 'object' }, strict: true },
    });
  });

  it('normalizes the schema sent in response_format', async () => {
    const adapter = createAdapter();
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: '{"value":"ok"}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    (adapter as unknown as { client: OpenAI }).client = {
      chat: { completions: { create: mockCreate } },
    } as unknown as OpenAI;

    await adapter.execute({
      prompt: 'hello',
      structuredOutput: {
        name: 'example',
        schema: { $schema: 'schema', type: 'object', properties: { value: { type: 'string' } } },
      },
    });

    expect(mockCreate.mock.calls[0][0].response_format.json_schema.schema).toEqual({
      type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['value'],
    });
  });

  it('preserves invalid-schema provider details on OpenAI API errors', async () => {
    const adapter = createAdapter();
    const providerError = {
      message: 'Invalid schema for response_format',
      code: 'invalid_json_schema',
      param: 'text.format.schema',
      type: 'invalid_request_error',
    };
    const mockCreate = jest.fn().mockRejectedValue(new OpenAI.APIError(
      400,
      providerError,
      'bad request',
      new Headers({ 'x-request-id': 'request-123' }),
    ));
    (adapter as unknown as { client: OpenAI }).client = {
      chat: { completions: { create: mockCreate } },
    } as unknown as OpenAI;

    await expect(adapter.execute({
      prompt: 'hello',
      structuredOutput: { name: 'example', schema: { type: 'object' } },
    })).rejects.toMatchObject<Partial<AiProviderError>>({
      category: 'config',
      details: {
        status: 400,
        code: 'invalid_json_schema',
        param: 'text.format.schema',
        type: 'invalid_request_error',
        error: providerError,
        request_id: 'request-123',
      },
    });
  });

  it('omits response_format when structured output is absent', async () => {
    const adapter = createAdapter();
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    (adapter as unknown as { client: OpenAI }).client = {
      chat: { completions: { create: mockCreate } },
    } as unknown as OpenAI;
    await adapter.execute({ prompt: 'hello' });
    expect(mockCreate.mock.calls[0][0].response_format).toBeUndefined();
  });

  describe('structured-output', () => {
    it('throws config error for array-root schema', async () => {
      const adapter = createAdapter();

      await expect(adapter.execute({
        prompt: 'hello',
        structuredOutput: { name: 'example', schema: [] as unknown as Record<string, unknown> },
      })).rejects.toMatchObject<Partial<AiProviderError>>({
        category: 'config',
      });
    });
  });

  describe('onModuleInit', () => {
    it('loads global and project config from AGENTS.md paths', async () => {
      const adapter = createAdapter();

      await adapter.onModuleInit();

      expect(loadAiContextConfig).toHaveBeenCalledWith(
        path.join(os.homedir(), '.openai', 'AGENTS.md'),
        'AGENTS.md',
        'openai',
        true
      );
    });
  });
});
