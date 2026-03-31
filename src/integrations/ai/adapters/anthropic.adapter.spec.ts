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
    ],
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
    (
      loadAiContextConfig as jest.MockedFunction<typeof loadAiContextConfig>
    ).mockResolvedValue('');
  });

  describe('execute', () => {
    it('prepends loaded context config to the system prompt', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      (adapter as unknown as { client: Anthropic }).client = {
        messages: { create: mockCreate },
      } as unknown as Anthropic;
      (adapter as unknown as { model: string }).model =
        'claude-sonnet-4-20250514';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;
      (adapter as unknown as { contextConfig: string }).contextConfig =
        '## Project Config\nrules\n\n';

      await adapter.execute({
        prompt: 'hello',
        systemPrompt: 'original prompt',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: '## Project Config\nrules\n\noriginal prompt',
        }),
      );
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
        true,
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
        false,
      );
    });
  });
});
