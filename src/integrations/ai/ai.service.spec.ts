import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';
import { LoggerService } from '../../shared/logger/logger.service';
import type { LlmAdapter } from './llm-adapter.interface';

describe('AiService', () => {
  const mockLogger = {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as LoggerService;

  const mockAdapter = {
    execute: jest.fn(),
    executeWithHistory: jest.fn(),
  } as unknown as LlmAdapter;

  describe('provider naming', () => {
    it('returns OpenAI display and short names when ai.provider is openai', () => {
      const mockConfigService = {
        get: jest.fn((key: string, defaultValue?: string) => {
          if (key === 'ai.provider') return 'openai';
          return defaultValue;
        }),
      } as unknown as ConfigService;

      const service = new AiService(mockLogger, mockAdapter, mockConfigService);

      expect(service.getProviderDisplayName()).toBe('OpenAI');
      expect(service.getProviderShortName()).toBe('OpenAI');
    });
  });
});
