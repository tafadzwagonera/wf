import { ConfigService } from '@nestjs/config';
import { LlmAdapterFactory } from './llm-adapter.factory';
import { LoggerService } from '../../../shared/logger/logger.service';

describe('LlmAdapterFactory', () => {
  const mockLogger = {
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
        mockDeepSeekAdapter as any,
      );

      await adapter.execute({ prompt: 'hello' });

      expect(mockOpenAIAdapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'hello' }),
      );
    });
  });
});
