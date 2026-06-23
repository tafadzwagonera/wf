import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import { LoggerService } from '../../../shared/logger/logger.service';
import { DeepSeekAdapter } from './deepseek.adapter';
import { loadAiContextConfig } from './load-ai-context-config';

jest.mock('./load-ai-context-config', () => ({
  loadAiContextConfig: jest.fn(),
}));

describe('DeepSeekAdapter', () => {
  const mockLogger = {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as LoggerService;

  const createAdapter = (
    providers: Array<Record<string, unknown>> = [
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: 'deepseek-reasoner',
        default: true,
      },
    ],
  ): DeepSeekAdapter => {
    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'ai.deepseekApiKey') return 'test-key';
        if (key === 'ai.model') return 'deepseek-reasoner';
        if (key === 'ai.providers') return providers;
        return defaultValue;
      }),
    } as unknown as ConfigService;

    return new DeepSeekAdapter(mockConfigService, mockLogger);
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
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      (adapter as unknown as { client: OpenAI }).client = {
        chat: { completions: { create: mockCreate } },
      } as unknown as OpenAI;
      (adapter as unknown as { model: string }).model = 'deepseek-reasoner';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;
      (adapter as unknown as { contextConfig: string }).contextConfig =
        '## Project Config\nrules\n\n';

      await adapter.execute({
        prompt: 'hello',
        systemPrompt: 'original prompt',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            {
              role: 'system',
              content: '## Project Config\nrules\n\noriginal prompt',
            },
          ]),
        }),
      );
    });

    it('preserves empty DeepSeek completion diagnostics', async () => {
      const adapter = createAdapter();
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: 'length',
            message: {
              content: null,
              refusal: null,
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 0 },
      });

      (adapter as unknown as { client: OpenAI }).client = {
        chat: { completions: { create: mockCreate } },
      } as unknown as OpenAI;
      (adapter as unknown as { model: string }).model = 'deepseek-reasoner';
      (adapter as unknown as { maxTokens: number }).maxTokens = 4096;

      await expect(adapter.execute({ prompt: 'hello' })).resolves.toMatchObject(
        {
          content: '',
          provider: 'deepseek',
          model: 'deepseek-reasoner',
          finishReason: 'length',
        },
      );
    });
  });

  describe('onModuleInit', () => {
    it('loads global and project DeepSeek config when provider intent exists', async () => {
      const adapter = createAdapter();

      await adapter.onModuleInit();

      expect(loadAiContextConfig).toHaveBeenCalledWith(
        path.join(os.homedir(), '.deepseek', 'DEEPSEEK.md'),
        'DEEPSEEK.md',
        'deepseek',
        true,
      );
    });

    it('disables warning when provider intent does not exist', async () => {
      const adapter = createAdapter([
        {
          provider: 'deepseek',
          apiKey: 'test-key',
        },
      ]);

      await adapter.onModuleInit();

      expect(loadAiContextConfig).toHaveBeenCalledWith(
        path.join(os.homedir(), '.deepseek', 'DEEPSEEK.md'),
        'DEEPSEEK.md',
        'deepseek',
        false,
      );
    });
  });
});
