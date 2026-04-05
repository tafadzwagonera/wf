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

  const createConfigService = (): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'ai.provider': 'openai',
          'ai.model': 'gpt-5.4',
          'ai.providers': [
            {
              provider: 'openai',
              apiKey: 'openai-key',
              model: 'gpt-5.4',
              default: true,
            },
            {
              provider: 'google',
              apiKey: 'gemini-key',
              model: 'gemini-2.5-pro',
              default: false,
            },
          ],
          'ai.stages.commit': 'gemini-2.5-pro',
          'ai.stages.review': 'gemini-2.5-pro',
          'stages.implement.model': 'gemini-2.5-pro',
        };

        return key in values ? values[key] : defaultValue;
      }),
    }) as unknown as ConfigService;

  const createAdapter = (): jest.Mocked<LlmAdapter> =>
    ({
      execute: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          summary: 'ok',
          issues: [],
          suggestions: [],
          approved: true,
        }),
      }),
      executeWithHistory: jest.fn().mockResolvedValue({ content: 'ok' }),
    }) as unknown as jest.Mocked<LlmAdapter>;

  describe('provider naming', () => {
    it('returns OpenAI display and short names when ai.provider is openai', () => {
      const service = new AiService(
        mockLogger,
        createAdapter(),
        createConfigService(),
      );

      expect(service.getProviderDisplayName()).toBe('OpenAI');
      expect(service.getProviderShortName()).toBe('OpenAI');
    });
  });

  describe('stage overrides', () => {
    it('routes review requests to the provider whose model matches the configured stage override', async () => {
      const adapter = createAdapter();
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.reviewCode('diff', ['guideline']);

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'google',
          model: 'gemini-2.5-pro',
        }),
      );
    });

    it('routes implement requests using stages.implement.model when configured', async () => {
      const adapter = createAdapter();
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.generateFileChange({
        ticketContent: 'ticket',
        planSteps: ['update file'],
        filePath: 'src/example.ts',
        existingContent: 'export const value = 0;\n',
      });

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'google',
          model: 'gemini-2.5-pro',
          stage: 'implement',
        }),
      );
    });

    it('routes commit requests to the provider whose model matches the configured stage override', async () => {
      const adapter = createAdapter();
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.execute({
        prompt: 'commit',
        stage: 'commit',
      });

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'google',
          model: 'gemini-2.5-pro',
          stage: 'commit',
        }),
      );
    });

    it('requests and preserves plan-level verification policies when generating plans', async () => {
      const adapter = {
        execute: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            action: 'fix',
            summary: 'Resolve criteria path handling',
            steps: ['Add failing test', 'Implement resolver'],
            estimatedComplexity: 'medium',
            filesAffected: ['repo-a/src/commands/issue-review.command.ts'],
            repositoriesAffected: ['repo-a'],
            risks: ['Path resolution regressions'],
            verification: {
              targeted: [
                {
                  id: 'manual-review',
                  run: 'npm run test:manual -- test-issue-review',
                  policy: 'enforced',
                  reason: 'Covers review command resolution paths',
                },
              ],
              waivers: [
                {
                  id: 'e2e',
                  reason: 'Command-level fix does not touch app runtime paths',
                },
              ],
            },
          }),
        }),
        executeWithHistory: jest.fn().mockResolvedValue({ content: 'ok' }),
      } as unknown as jest.Mocked<LlmAdapter>;
      const service = new AiService(mockLogger, adapter, createConfigService());

      const plan = await service.generatePlan(
        'fix',
        '# WBP-123: Fix criteria resolution',
        {
          affectedRepositories: ['repo-a'],
        },
      );

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('"verification": {'),
        }),
      );
      expect(plan.verification).toEqual({
        targeted: [
          {
            id: 'manual-review',
            run: 'npm run test:manual -- test-issue-review',
            policy: 'enforced',
            reason: 'Covers review command resolution paths',
          },
        ],
        waivers: [
          {
            id: 'e2e',
            reason: 'Command-level fix does not touch app runtime paths',
          },
        ],
      });
    });
  });
});
