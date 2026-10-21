import { ConfigService } from '@nestjs/config';
import { LlmAdapterFactory } from './llm-adapter.factory';
import { LoggerService } from '../../../common/logger/logger.service';

describe('LlmAdapterFactory', () => {
  const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as LoggerService;

  describe('useFactory', () => {
    it('routes execute calls to the configured provider adapter', async () => {
      const mockConfigService = {
        get: jest.fn((key: string, defaultValue?: string) => {
          if (key === 'ai.provider') return 'openai';
          return defaultValue;
        }),
      } as unknown as ConfigService;
      const mockAnthropicAdapter = {
        execute: jest.fn(),
        executeWithHistory: jest.fn(),
      };
      const mockOpenAIAdapter = {
        execute: jest.fn().mockResolvedValue({ content: 'ok' }),
        executeWithHistory: jest.fn(),
      };
      const mockGeminiAdapter = {
        execute: jest.fn(),
        executeWithHistory: jest.fn(),
      };
      const mockDeepSeekAdapter = {
        execute: jest.fn(),
        executeWithHistory: jest.fn(),
      };

      const adapter = LlmAdapterFactory.useFactory(
        mockConfigService,
        mockLogger,
        mockAnthropicAdapter as any,
        mockOpenAIAdapter as any,
        mockGeminiAdapter as any,
        mockDeepSeekAdapter as any
      );

      await adapter.execute({ prompt: 'hello' });

      expect(mockOpenAIAdapter.execute).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello' }));
    });

    it('records an llm.call log line with usage and billing after a routed call', async () => {
      const logFileWriter = require('../../../common/logger/log-file-writer');
      const appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);

      const mockConfigService = {
        get: jest.fn((key: string, defaultValue?: string) => {
          if (key === 'ai.provider') return 'anthropic';
          return defaultValue;
        }),
      } as unknown as ConfigService;
      const mockAnthropicAdapter = {
        execute: jest.fn().mockResolvedValue({
          content: 'ok',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
        executeWithHistory: jest.fn(),
      };
      const emptyAdapter = { execute: jest.fn(), executeWithHistory: jest.fn() };

      const adapter = LlmAdapterFactory.useFactory(
        mockConfigService,
        mockLogger,
        mockAnthropicAdapter as any,
        emptyAdapter as any,
        emptyAdapter as any,
        emptyAdapter as any
      );

      await adapter.execute({ prompt: 'hello', stage: 'plan' });

      const line = appendSpy.mock.calls.map(call => String(call[1])).find(l => l.startsWith('llm.call'));
      expect(line).toContain('stage=plan');
      expect(line).toContain('provider=anthropic');
      expect(line).toContain('model=claude-sonnet-4-6');
      expect(line).toContain('inputTokens=10');
      expect(line).toContain('outputTokens=5');
      expect(line).toContain('billing=api-key');

      appendSpy.mockRestore();
    });
  });
});
