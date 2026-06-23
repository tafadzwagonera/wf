import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as os from 'os';
import * as path from 'path';
import { LoggerService } from '../../../shared/logger/logger.service';
import { GeminiAdapter } from './gemini.adapter';
import { loadAiContextConfig } from './load-ai-context-config';

jest.mock('./load-ai-context-config', () => ({
  loadAiContextConfig: jest.fn(),
}));

describe('GeminiAdapter', () => {
  const mockLogger = {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as LoggerService;

  beforeEach(() => {
    jest.clearAllMocks();
    (
      loadAiContextConfig as jest.MockedFunction<typeof loadAiContextConfig>
    ).mockResolvedValue('');
  });

  const createAdapter = (configOverrides?: Record<string, string | number>) => {
    const mockConfigService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'ai.geminiApiKey': 'test-key',
          'ai.model': 'gemini-2.5-pro',
          'ai.maxTokens': 8192,
          'ai.providers': [
            {
              provider: 'google',
              apiKey: 'test-key',
              model: 'gemini-2.5-pro',
              default: true,
            },
          ],
          ...configOverrides,
        };

        return key in values ? values[key] : defaultValue;
      }),
    } as unknown as ConfigService;

    return new GeminiAdapter(mockConfigService, mockLogger);
  };

  describe('execute', () => {
    it('uses config-level ai.maxTokens for Gemini models', async () => {
      const adapter = createAdapter();
      const mockGenerateContent = jest.fn().mockResolvedValue({
        response: {
          text: () => 'ok',
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
          },
        },
      });
      const mockGetGenerativeModel = jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      });

      (adapter as unknown as { client: GoogleGenerativeAI }).client = {
        getGenerativeModel: mockGetGenerativeModel,
      } as unknown as GoogleGenerativeAI;
      (adapter as unknown as { model: string }).model = 'gemini-2.5-pro';
      (adapter as unknown as { maxTokens: number }).maxTokens = 8192;

      await adapter.execute({ prompt: 'hello' });

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({
            maxOutputTokens: 8192,
          }),
        }),
      );
    });

    it('applies the Gemini 2.5 minimum token floor to low request overrides', async () => {
      const adapter = createAdapter({ 'ai.maxTokens': 512 });
      const mockGenerateContent = jest.fn().mockResolvedValue({
        response: {
          text: () => 'ok',
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
          },
        },
      });
      const mockGetGenerativeModel = jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      });

      (adapter as unknown as { client: GoogleGenerativeAI }).client = {
        getGenerativeModel: mockGetGenerativeModel,
      } as unknown as GoogleGenerativeAI;
      (adapter as unknown as { model: string }).model = 'gemini-2.5-pro';
      (adapter as unknown as { maxTokens: number }).maxTokens = 512;

      await adapter.execute({ prompt: 'hello', maxTokens: 500 });

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({
            maxOutputTokens: 4096,
          }),
        }),
      );
    });

    it('preserves metadata for blank Gemini text responses', async () => {
      const adapter = createAdapter();
      const mockGenerateContent = jest.fn().mockResolvedValue({
        response: {
          text: () => '   ',
          candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 0,
          },
        },
      });
      const mockGetGenerativeModel = jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      });

      (adapter as unknown as { client: GoogleGenerativeAI }).client = {
        getGenerativeModel: mockGetGenerativeModel,
      } as unknown as GoogleGenerativeAI;
      (adapter as unknown as { model: string }).model = 'gemini-2.5-pro';
      (adapter as unknown as { maxTokens: number }).maxTokens = 8192;

      await expect(adapter.execute({ prompt: 'hello' })).resolves.toMatchObject(
        {
          content: '   ',
          provider: 'google',
          model: 'gemini-2.5-pro',
          finishReason: 'STOP',
          contentTypes: ['text'],
        },
      );
    });
  });

  describe('onModuleInit', () => {
    it('loads global and project config from GEMINI.md paths', async () => {
      const adapter = createAdapter();

      await adapter.onModuleInit();

      expect(loadAiContextConfig).toHaveBeenCalledWith(
        path.join(os.homedir(), '.gemini', 'GEMINI.md'),
        'GEMINI.md',
        'gemini',
        true,
      );
    });
  });
});
