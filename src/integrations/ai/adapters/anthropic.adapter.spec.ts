import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import * as os from 'os';
import * as path from 'path';
import { LoggerService } from '../../../shared/logger/logger.service';
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
