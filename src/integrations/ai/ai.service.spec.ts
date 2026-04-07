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

    describe('generateFileChange — code fence stripping', () => {
      const buildAdapter = (responseContent: string): jest.Mocked<LlmAdapter> =>
        ({
          execute: jest.fn().mockResolvedValue({ content: responseContent }),
          executeWithHistory: jest.fn().mockResolvedValue({ content: 'ok' }),
        }) as unknown as jest.Mocked<LlmAdapter>;

      it('returns the inner code when the entire response is a single code fence', async () => {
        const service = new AiService(
          mockLogger,
          buildAdapter('```ts\nexport const x = 1;\n```'),
          createConfigService(),
        );

        const result = await service.generateFileChange({
          ticketContent: 'ticket',
          planSteps: ['add export'],
          filePath: 'src/x.ts',
          existingContent: '',
        });

        expect(result).toBe('export const x = 1;\n');
      });

      it('extracts the code block when the model prepends reasoning text before the fence', async () => {
        const service = new AiService(
          mockLogger,
          buildAdapter(
            'Looking at the failing tests, I need to update the export.\n```ts\nexport const x = 1;\n```',
          ),
          createConfigService(),
        );

        const result = await service.generateFileChange({
          ticketContent: 'ticket',
          planSteps: ['add export'],
          filePath: 'src/x.ts',
          existingContent: '',
        });

        expect(result).toBe('export const x = 1;\n');
      });

      it('extracts the code block when the model appends trailing text after the fence', async () => {
        const service = new AiService(
          mockLogger,
          buildAdapter('```ts\nexport const x = 1;\n```\nHope this helps!'),
          createConfigService(),
        );

        const result = await service.generateFileChange({
          ticketContent: 'ticket',
          planSteps: ['add export'],
          filePath: 'src/x.ts',
          existingContent: '',
        });

        expect(result).toBe('export const x = 1;\n');
      });

      it('extracts the code block when the model wraps the fence in both preamble and trailing text', async () => {
        const service = new AiService(
          mockLogger,
          buildAdapter(
            'Here is the updated file:\n```ts\nexport const x = 1;\n```\nLet me know if you need anything else.',
          ),
          createConfigService(),
        );

        const result = await service.generateFileChange({
          ticketContent: 'ticket',
          planSteps: ['add export'],
          filePath: 'src/x.ts',
          existingContent: '',
        });

        expect(result).toBe('export const x = 1;\n');
      });

      it('returns the content unchanged when the response contains no code fence', async () => {
        const service = new AiService(
          mockLogger,
          buildAdapter('export const x = 1;'),
          createConfigService(),
        );

        const result = await service.generateFileChange({
          ticketContent: 'ticket',
          planSteps: ['add export'],
          filePath: 'src/x.ts',
          existingContent: '',
        });

        expect(result).toBe('export const x = 1;');
      });
    });

    describe('generateFileChange — system prompt', () => {
      it('contains write-to-disk warning and does not contain "Reconcile" or "Self-review"', async () => {
        const adapter: jest.Mocked<LlmAdapter> = {
          execute: jest
            .fn()
            .mockResolvedValue({ content: 'export const x = 1;' }),
          executeWithHistory: jest.fn().mockResolvedValue({ content: 'ok' }),
        } as unknown as jest.Mocked<LlmAdapter>;
        const service = new AiService(
          mockLogger,
          adapter,
          createConfigService(),
        );

        await service.generateFileChange({
          ticketContent: 'ticket',
          planSteps: ['add export'],
          filePath: 'src/x.ts',
          existingContent: '',
        });

        expect(adapter.execute).toHaveBeenCalledTimes(1);
        const call = (adapter.execute as jest.Mock).mock.calls[0][0] as {
          systemPrompt: string;
        };
        expect(call.systemPrompt).toContain('written byte-for-byte to disk');
        expect(call.systemPrompt).not.toContain('Reconcile');
        expect(call.systemPrompt).not.toContain('Self-review');
      });
    });

    it('uses the affected repository names in the plan prompt and forbids raw failing verification commands', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          action: 'fix',
          summary: 'Resolve criteria path handling',
          steps: ['Add failing test', 'Implement resolver'],
          estimatedComplexity: 'medium',
          filesAffected: ['repo-a/src/commands/issue-review.command.ts'],
          repositoriesAffected: ['repo-a'],
        }),
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.generatePlan('fix', '# WBP-123: Fix criteria resolution', {
        affectedRepositories: ['repo-a'],
      });

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            '"filesAffected": ["repo-a/src/path/to/file.ts", ...]',
          ),
        }),
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'If you need to prove an expected failure, wrap it in a shell assertion that exits 0 when the expected failure occurs.',
          ),
        }),
      );
    });
  });
});
