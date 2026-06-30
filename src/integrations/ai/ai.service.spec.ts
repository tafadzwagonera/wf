import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';
import { LoggerService } from '../../shared/logger/logger.service';
import type { LlmAdapter } from './llm-adapter.interface';
import { AIError } from '../../shared/utils/errors';

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
            {
              provider: 'anthropic',
              apiKey: 'anthropic-key',
              model: 'claude-sonnet-4-20250514',
              default: false,
            },
          ],
          'ai.stages.commit.provider': 'google',
          'ai.stages.commit.model': 'gemini-2.5-pro',
          'ai.stages.review.provider': 'google',
          'ai.stages.review.model': 'gemini-2.5-pro',
          'stages.implement.provider': 'anthropic',
          'stages.implement.model': 'claude-haiku-4-5-20251001',
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
      const service = new AiService(mockLogger, createAdapter(), createConfigService());

      expect(service.getProviderDisplayName()).toBe('OpenAI');
      expect(service.getProviderShortName()).toBe('OpenAI');
    });
  });

  describe('stage overrides', () => {
    it('routes review requests to the configured explicit stage target', async () => {
      const adapter = createAdapter();
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.reviewCode('diff', ['guideline']);

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'google',
          model: 'gemini-2.5-pro',
        })
      );
    });

    it('routes commit requests to the configured explicit stage target', async () => {
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
        })
      );
    });

    it('fails fast when only a model override is provided', async () => {
      const adapter = createAdapter();
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(
        service.execute({
          prompt: 'commit',
          stage: 'commit',
          model: 'gpt-5.4',
        })
      ).rejects.toThrow(/provider and model overrides must be supplied together/i);
    });

    it('requests and preserves plan-level verification policies when generating plans', async () => {
      const adapter = {
        execute: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            action: 'fix',
            summary: 'Resolve criteria path handling',
            steps: ['Add failing test', 'Implement resolver'],
            estimatedComplexity: 'medium',
            affectedFiles: ['repo-a/src/commands/issue-review.command.ts'],
            affectedRepositories: ['repo-a'],
            risks: ['Path resolution regressions'],
            verification: {
              targeted: [
                {
                  id: 'manual-review',
                  run: 'yarn test:manual -- test-issue-review',
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

      const plan = await service.generatePlan('fix', '# WBP-123: Fix criteria resolution', {
        affectedRepositories: ['repo-a'],
      });

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('"verification": {'),
        })
      );
      expect(plan.verification).toEqual({
        targeted: [
          {
            id: 'manual-review',
            run: 'yarn test:manual -- test-issue-review',
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

    it('uses the affected repository names in the plan prompt and forbids raw failing verification commands', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          action: 'fix',
          summary: 'Resolve criteria path handling',
          steps: ['Add failing test', 'Implement resolver'],
          estimatedComplexity: 'medium',
          affectedFiles: ['repo-a/src/commands/issue-review.command.ts'],
          affectedRepositories: ['repo-a'],
        }),
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.generatePlan('fix', '# WBP-123: Fix criteria resolution', {
        affectedRepositories: ['repo-a'],
      });

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            '"affectedFiles": [{ "filePath": "repo-a/src/path/to/file.ts", "status": "found" }'
          ),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'If you need to prove an expected failure, wrap it in a shell assertion that exits 0 when the expected failure occurs.'
          ),
        })
      );
    });

    it('raises an AIError with provider metadata when the plan response is blank', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: '',
        provider: 'openai',
        model: 'gpt-5.4',
        finishReason: 'stop',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(service.generatePlan('fix', '# WBP-123: Fix criteria resolution')).rejects.toMatchObject({
        message: 'AI provider returned an empty plan response',
        details: expect.objectContaining({
          provider: 'openai',
          model: 'gpt-5.4',
        }),
      });
    });
  });

  describe('non-review empty response handling', () => {
    it('raises an AIError with provider metadata when findings output is blank', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: '  ',
        provider: 'openai',
        model: 'gpt-5.4',
        finishReason: 'stop',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(
        service.generateFindings({
          action: 'investigate',
          summary: 'Investigate',
          findings: [],
          recommendations: [],
          conclusion: 'Pending',
        } as any)
      ).rejects.toMatchObject({
        message: 'AI provider returned an empty investigation findings response',
        details: expect.objectContaining({
          provider: 'openai',
          model: 'gpt-5.4',
        }),
      });
    });

    it('raises an AIError with provider metadata when commit output is blank', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: '',
        provider: 'openai',
        model: 'gpt-5.4',
        finishReason: 'stop',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(service.generateCommitMessage('diff --git a/file b/file', [])).rejects.toMatchObject({
        message: 'AI provider returned an empty commit message response',
        details: expect.objectContaining({
          provider: 'openai',
          model: 'gpt-5.4',
        }),
      });
    });
  });

  describe('reviewCode trace validation', () => {
    it('raises an AIError with provider metadata when the review response is blank', async () => {
      const adapter = createAdapter();
      adapter.execute
        .mockResolvedValueOnce({
          content: '   ',
          provider: 'openai',
          model: 'gpt-5.4',
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: '   ',
          provider: 'openai',
          model: 'gpt-5.4',
          finishReason: 'stop',
        });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(service.reviewCode('diff', ['guideline'])).rejects.toMatchObject({
        message: 'AI provider returned an empty review response',
        details: expect.objectContaining({
          provider: 'openai',
          model: 'gpt-5.4',
          finishReason: 'stop',
        }),
      });
      expect(adapter.execute).toHaveBeenCalledTimes(2);
    });

    it('retries a blank review response once and returns the second valid review', async () => {
      const adapter = createAdapter();
      adapter.execute
        .mockResolvedValueOnce({
          content: '',
          provider: 'google',
          model: 'gemini-2.5-pro',
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            summary: 'ok',
            issues: [],
            traceProvenance: 'unavailable',
            callStack: [],
            stateTransition: {},
            suggestions: [],
            approved: true,
          }),
          provider: 'google',
          model: 'gemini-2.5-pro',
          finishReason: 'stop',
        });
      const service = new AiService(mockLogger, adapter, createConfigService());

      const review = await service.reviewCode('diff', ['guideline']);

      expect(adapter.execute).toHaveBeenCalledTimes(2);
      expect(review.summary).toBe('ok');
      expect(review.executionMode).toBe('standard');
    });

    it('does not retry blank responses when provider metadata indicates refusal', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: '',
        provider: 'openai',
        model: 'gpt-5.4',
        finishReason: 'content_filter',
        refusal: 'Safety refusal',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(service.reviewCode('diff', ['guideline'])).rejects.toMatchObject({
        message: 'AI provider returned an empty review response',
        details: expect.objectContaining({
          provider: 'openai',
          refusal: 'Safety refusal',
          finishReason: 'content_filter',
        }),
      });
      expect(adapter.execute).toHaveBeenCalledTimes(1);
    });

    it('parses the first valid JSON payload when extra fenced output trails the review', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: `\`\`\`json
{
  "summary": "ok",
  "issues": [],
  "traceProvenance": "evidence-based",
  "callStack": ["eventPaymentRecorded()", "addPaymentToBooking()"],
  "stateTransition": {
    "from": "eventPaymentRecorded",
    "to": "addPaymentToBooking",
    "steps": [
      {
        "state": "eventPaymentRecorded",
        "next": "addPaymentToBooking"
      }
    ]
  },
  "suggestions": [],
  "approved": true
}
\`\`\`
\`\`\`text
review complete
\`\`\`
`,
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      const review = await service.reviewCode(
        `
diff --git a/src/payment/payment.controller.ts b/src/payment/payment.controller.ts
@@
+export async function eventPaymentRecorded() {
+  return addPaymentToBooking();
+}
`,
        ['guideline']
      );

      expect(review.summary).toBe('ok');
      expect(review.approved).toBe(true);
      expect(review.callStack).toEqual(['eventPaymentRecorded()', 'addPaymentToBooking()']);
    });

    it('asks for code-path traces and rejects reviewer-analysis language in the prompt', async () => {
      const adapter = createAdapter();
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.reviewCode(
        `
diff --git a/src/payment/payment.controller.ts b/src/payment/payment.controller.ts
@@
+export async function eventPaymentRecorded() {
+  return addPaymentToBooking();
+}
`,
        ['guideline']
      );

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('walks the changed code path'),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Do not return review-process steps such as "diff loaded"'),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Evidence-based traces must mention concrete identifiers from the diff.'),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'Use concrete code identifiers as callStack node labels, such as Class.method(...), functionName(...), or Client.method(...).'
          ),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'Nest child callStack nodes under the parent frame that directly invokes or depends on them.'
          ),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'Use `captured` for the variables or objects observed at a frame, and `changes` for the values that changed between the current frame and the previous one.'
          ),
        })
      );
    });

    it('downgrades reviewer-analysis traces to unavailable', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          summary: 'ok',
          issues: [],
          traceProvenance: 'evidence-based',
          callStack: [
            {
              frame: 'Analyzing payment.controller.ts for changes to event handling.',
              children: [
                {
                  frame: 'Diff loaded and reviewed.',
                  children: [
                    {
                      frame: 'Issues found.',
                    },
                  ],
                },
              ],
            },
          ],
          stateTransition: {
            from: 'initial',
            to: 'reviewed',
            steps: [
              {
                frame: 'Analyzing payment.controller.ts for changes to event handling.',
                captured: {
                  diffLoaded: true,
                },
                changes: {
                  reviewState: {
                    before: 'initial',
                    after: 'diff_loaded',
                  },
                },
                children: [
                  {
                    frame: 'Diff loaded and reviewed.',
                    changes: {
                      reviewState: {
                        before: 'diff_loaded',
                        after: 'reviewed',
                      },
                    },
                  },
                ],
              },
            ],
          },
          suggestions: [],
          approved: true,
        }),
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      const review = await service.reviewCode(
        `
diff --git a/src/payment/payment.controller.ts b/src/payment/payment.controller.ts
@@
+export async function eventPaymentRecorded() {
+  return addPaymentToBooking();
+}
`,
        ['guideline']
      );

      expect(review.traceProvenance).toBe('unavailable');
      expect(review.callStack).toEqual([]);
      expect(review.stateTransition).toEqual({});
    });

    it('preserves concrete code-path traces when they anchor to the diff', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          summary: 'ok',
          issues: [],
          traceProvenance: 'evidence-based',
          callStack: [
            {
              frame: 'eventPaymentRecorded()',
              children: [
                {
                  frame: 'addPaymentToBooking()',
                  children: [
                    {
                      frame: 'booking retry loop',
                    },
                  ],
                },
              ],
            },
          ],
          stateTransition: {
            from: 'eventPaymentRecorded',
            to: 'addPaymentToBooking',
            steps: [
              {
                frame: 'eventPaymentRecorded()',
                captured: {
                  bookingId: 'booking-123',
                },
                changes: {
                  paymentState: {
                    before: 'recorded',
                    after: 'linking',
                  },
                },
                children: [
                  {
                    frame: 'addPaymentToBooking()',
                    changes: {
                      paymentState: {
                        before: 'linking',
                        after: 'linked',
                      },
                    },
                  },
                ],
              },
            ],
          },
          suggestions: [],
          approved: true,
        }),
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      const review = await service.reviewCode(
        `
diff --git a/src/payment/payment.controller.ts b/src/payment/payment.controller.ts
@@
+export async function eventPaymentRecorded() {
+  return addPaymentToBooking();
+}
`,
        ['guideline']
      );

      expect(review.traceProvenance).toBe('evidence-based');
      expect(review.callStack).toEqual([
        {
          frame: 'eventPaymentRecorded()',
          children: [
            {
              frame: 'addPaymentToBooking()',
              children: [
                {
                  frame: 'booking retry loop',
                },
              ],
            },
          ],
        },
      ]);
      expect(review.stateTransition).toEqual({
        from: 'eventPaymentRecorded',
        to: 'addPaymentToBooking',
        steps: [
          {
            frame: 'eventPaymentRecorded()',
            captured: {
              bookingId: 'booking-123',
            },
            changes: {
              paymentState: {
                before: 'recorded',
                after: 'linking',
              },
            },
            children: [
              {
                frame: 'addPaymentToBooking()',
                changes: {
                  paymentState: {
                    before: 'linking',
                    after: 'linked',
                  },
                },
              },
            ],
          },
        ],
      });
    });

    it('asks the model to return issue-local suggestions and detached global suggestions separately', async () => {
      const adapter = createAdapter();
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.reviewCode(
        `
diff --git a/src/payment/payment.controller.ts b/src/payment/payment.controller.ts
@@
+export async function eventPaymentRecorded() {
+  return addPaymentToBooking();
+}
`,
        ['guideline']
      );

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('A suggestion for each issue when remediation is clear'),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('"suggestion": "optional issue-specific remediation"'),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('"suggestions": ["general follow-up suggestion 1", ...]'),
        })
      );
    });
  });
});
