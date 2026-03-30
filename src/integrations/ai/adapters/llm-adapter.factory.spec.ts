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
    it('returns an OpenAI adapter when ai.provider is openai', () => {
      const mockConfigService = {
        get: jest.fn((key: string, defaultValue?: string) => {
          if (key === 'ai.provider') return 'openai';
          return defaultValue;
        }),
      } as unknown as ConfigService;

      const adapter = LlmAdapterFactory.useFactory(
        mockConfigService,
        mockLogger,
      );

      expect(adapter.constructor.name).toBe('OpenAIAdapter');
    });
  });
});
