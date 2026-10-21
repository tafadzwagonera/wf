import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import * as os from 'os';
import * as path from 'path';
import { LoggerService } from '../../../common/logger/logger.service';
import { AnthropicAdapter } from './anthropic.adapter';
import { loadAiContextConfig } from './load-ai-context-config';

jest.mock('./load-ai-context-config', () => ({
  loadAiContextConfig: jest.fn(),
}));

describe('AnthropicAdapter', () => {
  const mockLogger = {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as LoggerService;

  const createAdapter = (
    providers: Array<Record<string, unknown>> = [
      {
        provider: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-20250514',
        default: true,
      },
    ]
  ): AnthropicAdapter => {
    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'ai.anthropicApiKey') return 'test-key';
        if (key === 'ai.model') return 'claude-sonnet-4-20250514';
        if (key === 'ai.providers') return providers;
        return defaultValue;
      }),
    } as unknown as ConfigService;

    return new AnthropicAdapter(mockConfigService, mockLogger);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (loadAiContextConfig as jest.MockedFunction<typeof loadAiContextConfig>).mockResolvedValue('');
  });

  describe('execute', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('prepends loaded context config to the system prompt', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-sonnet-4-20250514';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;
      (adapter as unknown as { contextConfig: string }).contextConfig = '## Project Config\nrules\n\n';

      await adapter.execute({
        prompt: 'hello',
        systemPrompt: 'original prompt',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: '## Project Config\nrules\n\noriginal prompt',
        })
      );
    });

    it('streams instead of throwing when maxTokens exceeds the non-streaming ceiling', async () => {
      const adapter = createAdapter();
      const finalMessage = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'streamed plan' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const mockStream = jest.fn().mockReturnValue({ finalMessage });
      const mockCreate = jest.fn();

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate, stream: mockStream },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-opus-5';
      (adapter as unknown as { maxTokens: number }).maxTokens = 128000;

      const result = await adapter.execute({ prompt: 'hello', systemPrompt: 'sys' });

      expect(mockStream).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 128000 }));
      expect(mockCreate).not.toHaveBeenCalled();
      expect(result.content).toBe('streamed plan');
    });

    it('uses the non-streaming path at or below the ceiling', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const mockStream = jest.fn();

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate, stream: mockStream },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-opus-5';
      (adapter as unknown as { maxTokens: number }).maxTokens = 21333;

      await adapter.execute({ prompt: 'hello', systemPrompt: 'sys' });

      expect(mockCreate).toHaveBeenCalled();
      expect(mockStream).not.toHaveBeenCalled();
    });

    it('reports the cause, model and maxTokens when a non-API error is thrown', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockRejectedValue(new Error('client-side rejection'));

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-opus-5';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await expect(adapter.execute({ prompt: 'hello', systemPrompt: 'sys' })).rejects.toMatchObject({
        details: {
          errorName: 'Error',
          message: 'client-side rejection',
          model: 'claude-opus-5',
          maxTokens: 4096,
        },
      });
    });

    it('surfaces non-text content blocks as empty-response diagnostics', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'tool_use', id: 'tool_1', name: 'search', input: {} }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-sonnet-4-20250514';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await expect(adapter.execute({ prompt: 'hello' })).resolves.toMatchObject({
        content: '',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        stopReason: 'end_turn',
        contentTypes: ['tool_use'],
      });
    });

    it('omits temperature for adaptive-thinking-only models', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-opus-4-8';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({ prompt: 'hello' });

      const args = mockCreate.mock.calls[0]?.[0];
      expect(args?.model).toBe('claude-opus-4-8');
      expect(args?.temperature).toBeUndefined();
    });

    it('omits temperature for Sonnet 5', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-sonnet-5';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({ prompt: 'hello', temperature: 0.5 });

      const args = mockCreate.mock.calls[0]?.[0];
      expect(args?.model).toBe('claude-sonnet-5');
      expect(args?.temperature).toBeUndefined();
    });

    it.each(['claude-fable-5', 'claude-mythos-preview'])('omits temperature for %s', async restrictedModel => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = restrictedModel;
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({ prompt: 'hello' });

      const args = mockCreate.mock.calls[0]?.[0];
      expect(args?.model).toBe(restrictedModel);
      expect(args?.temperature).toBeUndefined();
    });

    it('includes temperature for non-restricted models', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-sonnet-4-6';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({ prompt: 'hello' });

      const args = mockCreate.mock.calls[0]?.[0];
      expect(args?.model).toBe('claude-sonnet-4-6');
      expect(args?.temperature).toBe(0.7);
    });

    it('uses caller-provided temperature for non-restricted models', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-sonnet-4-6';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({ prompt: 'hello', temperature: 0 });

      const args = mockCreate.mock.calls[0]?.[0];
      expect(args?.temperature).toBe(0);
    });

    it('sends multimodal content when screenshots present in context', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-sonnet-4-20250514';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({
        prompt: 'Generate plan',
        context: {
          screenshots: [{ path: '/p/a.png', mediaType: 'image/png', base64: 'abc123' }],
        },
      });

      const call = mockCreate.mock.calls[0][0];
      const userContent = call.messages[0].content;
      expect(Array.isArray(userContent)).toBe(true);
      expect(userContent[0]).toMatchObject({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      });
      expect(userContent[1]).toMatchObject({ type: 'text', text: 'Generate plan' });
    });

    it('sends plain string content when no screenshots in context', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-sonnet-4-20250514';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.execute({ prompt: 'Generate plan' });

      const call = mockCreate.mock.calls[0][0];
      expect(typeof call.messages[0].content).toBe('string');
    });
  });

  describe('executeWithHistory', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('omits temperature for adaptive-thinking-only models', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model = 'claude-opus-4-7';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await adapter.executeWithHistory({
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
      });

      const args = mockCreate.mock.calls[0]?.[0];
      expect(args?.model).toBe('claude-opus-4-7');
      expect(args?.temperature).toBeUndefined();
    });
  });

  describe('initializeClient', () => {
    it('uses globalThis.fetch when available', () => {
      const adapter = createAdapter();
      (adapter as any).initializeClient();

      const client = (adapter as any).client as Anthropic;
      expect(client).toBeDefined();
      expect((client as any).fetch).toBe(globalThis.fetch);
    });

    it('falls back to node-fetch when globalThis.fetch is unavailable', () => {
      const originalFetch = globalThis.fetch;
      try {
        // @ts-expect-error — simulate Node < 18 where fetch is undefined
        delete globalThis.fetch;

        const adapter = createAdapter();
        (adapter as any).initializeClient();

        const client = (adapter as any).client as Anthropic;
        expect(client).toBeDefined();
        expect((client as any).fetch).toBe(require('node-fetch'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it('uses named strict JSON schema output configuration', async () => {
    const adapter = createAdapter();
    const mockCreate = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"value":"ok"}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    (adapter as unknown as { client: Anthropic }).client = {
      messages: { create: mockCreate },
    } as unknown as Anthropic;
    await adapter.execute({
      prompt: 'hello', structuredOutput: { name: 'example', schema: { type: 'object' } },
    });
    expect(mockCreate.mock.calls[0][0].output_config).toEqual({
      format: { type: 'json_schema', name: 'example', schema: { type: 'object' }, strict: true },
    });
  });

  it('omits output_config when structured output is absent', async () => {
    const adapter = createAdapter();
    const mockCreate = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 },
    });
    (adapter as unknown as { client: Anthropic }).client = {
      messages: { create: mockCreate },
    } as unknown as Anthropic;
    await adapter.execute({ prompt: 'hello' });
    expect(mockCreate.mock.calls[0][0].output_config).toBeUndefined();
  });

  describe('onModuleInit', () => {
    it('loads context config and enables warning when provider intent exists', async () => {
      const adapter = createAdapter();

      await adapter.onModuleInit();

      expect(loadAiContextConfig).toHaveBeenCalledWith(
        path.join(os.homedir(), '.claude', 'CLAUDE.md'),
        'CLAUDE.md',
        'anthropic',
        true
      );
    });

    it('disables warning when provider intent does not exist', async () => {
      const adapter = createAdapter([
        {
          provider: 'anthropic',
          apiKey: 'test-key',
        },
      ]);

      await adapter.onModuleInit();

      expect(loadAiContextConfig).toHaveBeenCalledWith(
        path.join(os.homedir(), '.claude', 'CLAUDE.md'),
        'CLAUDE.md',
        'anthropic',
        false
      );
    });
  });
});
