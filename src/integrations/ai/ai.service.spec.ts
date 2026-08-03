import { ConfigService } from '@nestjs/config';
import { AiService, parseJsonResponse } from './ai.service';
import { LoggerService } from '../../shared/logger/logger.service';
import type { LlmAdapter } from './llm-adapter.interface';
import { AIError } from '../../shared/utils/errors';
import { KNOWN_SKILLS, registerSkill } from '../../skills/skill-registry';

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
        provider: 'openai',
        model: 'gpt-5.4',
      }),
      executeWithHistory: jest.fn().mockResolvedValue({ content: 'ok' }),
    }) as unknown as jest.Mocked<LlmAdapter>;

  describe('provider naming', () => {
    it('returns OpenAI display and short names when ai.provider is openai', () => {
      const service = new AiService(mockLogger, createAdapter(), createConfigService());

      expect(service.getProviderDisplayName()).toBe('OpenAI');
      expect(service.getProviderShortName()).toBe('OpenAI');
    });

    describe('stage-aware provider names', () => {
      it('returns Gemini short name when stage is review with ai.stages.review.provider override', () => {
        const service = new AiService(mockLogger, createAdapter(), createConfigService());

        expect(service.getProviderShortName('review')).toBe('Gemini');
      });

      it('returns Google Gemini display name when stage is review with ai.stages.review.provider override', () => {
        const service = new AiService(mockLogger, createAdapter(), createConfigService());

        expect(service.getProviderDisplayName('review')).toBe('Google Gemini');
      });

      it('returns Claude short name when stage is implement with stages.implement.provider override', () => {
        const service = new AiService(mockLogger, createAdapter(), createConfigService());

        expect(service.getProviderShortName('implement')).toBe('Claude');
      });

      it('returns Anthropic Claude display name when stage is implement with stages.implement.provider override', () => {
        const service = new AiService(mockLogger, createAdapter(), createConfigService());

        expect(service.getProviderDisplayName('implement')).toBe('Anthropic Claude');
      });

      it('falls back to global OpenAI short name when stage is plan with no override configured', () => {
        const service = new AiService(mockLogger, createAdapter(), createConfigService());

        expect(service.getProviderShortName('plan')).toBe('OpenAI');
      });

      it('falls back to global OpenAI display name when stage is plan with no override configured', () => {
        const service = new AiService(mockLogger, createAdapter(), createConfigService());

        expect(service.getProviderDisplayName('plan')).toBe('OpenAI');
      });
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
          provider: 'openai',
          model: 'gpt-5.4',
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
          maxTokens: 16384,
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
        provider: 'openai',
        model: 'gpt-5.4',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.generatePlan('fix', '# WBP-123: Fix criteria resolution', {
        affectedRepositories: ['repo-a'],
        testInfra: {
          primary: 'node',
          ecosystems: [
            {
              ecosystem: 'node',
              nodeVersionMajor: 22,
              hasNodeTest: true,
              frameworks: ['jest'],
              scripts: { test: 'jest' },
              allScriptNames: ['test'],
            },
          ],
        },
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
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'Verification commands MUST be shell-safe by construction. For inline `node -e`, prefer'
          ),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'Each verification command MUST target the specific behavior introduced by the step it validates'
          ),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'When a step says "remove line X inside block Y", the plan MUST state whether the'
          ),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'Generated-doc workflows (e.g., auto-generated README sections, API docs from'
          ),
        })
      );
    });

    it('requires explicit rename targets and null-consumer tracing in the plan prompt', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          action: 'fix',
          summary: 'Resolve rename planning gaps',
          steps: ['Inspect rename guidance'],
          estimatedComplexity: 'low',
          affectedFiles: ['repo-a/src/example.ts'],
          affectedRepositories: ['repo-a'],
        }),
        provider: 'openai',
        model: 'gpt-5.4',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.generatePlan('fix', '# WBP-124: Tighten rename guidance', {
        affectedRepositories: ['repo-a'],
      });

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('A step that says only "rename X" without the target'),
        })
      );
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'When a step introduces an interface field typed with `| null` or `.nullable()`,'
          ),
        })
      );
    });

    it('adds retry feedback only when a prior plan attempt was rejected', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          action: 'fix',
          summary: 'Retry plan',
          steps: ['Rename AuthService to AuthSessionService in repo-a/src/auth.ts.'],
          estimatedComplexity: 'low',
          affectedFiles: ['repo-a/src/auth.ts'],
          affectedRepositories: ['repo-a'],
        }),
        provider: 'openai',
        model: 'gpt-5.4',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.generatePlan('fix', '# WBP-127: Retry invalid plan', {
        affectedRepositories: ['repo-a'],
        planQualityFeedback: ['[rename-target-required] Step 1 must name the replacement target.'],
      });

      const executeCall = (adapter.execute as jest.Mock).mock.calls[0]?.[0];
      expect(executeCall.prompt).toContain('Previous plan attempt was rejected for these exact reasons:');
      expect(executeCall.prompt).toContain('[rename-target-required] Step 1 must name the replacement target.');
    });

    it('omits retry feedback when no prior quality failures are provided', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          action: 'fix',
          summary: 'Fresh plan',
          steps: ['Inspect auth flow.'],
          estimatedComplexity: 'low',
          affectedFiles: ['repo-a/src/auth.ts'],
          affectedRepositories: ['repo-a'],
        }),
        provider: 'openai',
        model: 'gpt-5.4',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.generatePlan('fix', '# WBP-128: Fresh plan', {
        affectedRepositories: ['repo-a'],
      });

      const executeCall = (adapter.execute as jest.Mock).mock.calls[0]?.[0];
      expect(executeCall.prompt).not.toContain('Previous plan attempt was rejected for these exact reasons:');
    });

    it('includes prior plan context in the plan prompt when provided', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          action: 'fix',
          summary: 'Resolve prior plan reuse',
          steps: ['Inspect historical plans'],
          estimatedComplexity: 'low',
          affectedFiles: ['repo-a/src/example.ts'],
          affectedRepositories: ['repo-a'],
        }),
        provider: 'openai',
        model: 'gpt-5.4',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.generatePlan('fix', '# WBP-126: Reuse prior plans', {
        affectedRepositories: ['repo-a'],
        priorPlans: {
          repoName: 'repo-a',
          plans: [
            {
              title: 'Fix pricing timeout',
              summary: 'Fix pricing timeout',
              filename: '2026-07-01-abc123-fix-plan.json',
              artifactPath: '/fake/.wf/repo-a/jira/2026-07-01-abc123-fix-plan.json',
              keywords: ['PricingService'],
              steps: ['Inspect PricingService'],
              action: 'fix',
              estimatedComplexity: 'medium',
              ticketKey: 'WBP-123',
            },
          ],
        },
      });

      expect(adapter.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Related prior plans (repo-a):'),
        })
      );
    });

    it('omits node-specific shell-safety guidance when the detected repo is not node-based', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          action: 'fix',
          summary: 'Keep terraform prompt generic',
          steps: ['Inspect verification guidance'],
          estimatedComplexity: 'low',
          affectedFiles: ['repo-a/main.tf'],
          affectedRepositories: ['repo-a'],
        }),
        provider: 'openai',
        model: 'gpt-5.4',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.generatePlan('fix', '# WBP-125: Keep non-node prompts generic', {
        affectedRepositories: ['repo-a'],
        testInfra: {
          primary: 'terraform',
          ecosystems: [
            {
              ecosystem: 'terraform',
              hasTfFiles: true,
              hasBackendConfig: false,
            },
          ],
        },
      });

      const executeCall = (adapter.execute as jest.Mock).mock.calls[0]?.[0];
      expect(executeCall.prompt).not.toContain(
        'Verification commands MUST be shell-safe by construction. For inline `node -e`, prefer'
      );
    });

    it('stamps plan provider and source from the API response metadata', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          action: 'fix',
          summary: 'Use response metadata',
          steps: ['Step 1'],
          estimatedComplexity: 'low',
          affectedFiles: ['repo/src/file.ts'],
          affectedRepositories: ['repo'],
        }),
        provider: 'anthropic',
        model: 'claude-opus-4-6',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      const plan = await service.generatePlan('fix', '# Fix metadata', {
        affectedRepositories: ['repo'],
      });

      expect(plan.provider).toBe('anthropic');
      expect(plan.source).toBe('opus-4-6');
    });

    it('falls back to stage-resolved provider when response has no metadata', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          action: 'fix',
          summary: 'No response metadata',
          steps: ['Step 1'],
          estimatedComplexity: 'low',
          affectedFiles: ['repo/src/file.ts'],
          affectedRepositories: ['repo'],
        }),
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      const plan = await service.generatePlan('fix', '# Fix metadata fallback', {
        affectedRepositories: ['repo'],
      });

      expect(plan.provider).toBe('openai');
      expect(plan.source).toBe('5.4');
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

    it('throws an actionable AIError when the plan response is truncated', async () => {
      const adapter = {
        execute: jest.fn().mockResolvedValue({
          content: '{"action":"fix","summary":"Truncated',
          stopReason: 'max_tokens',
          usage: { inputTokens: 1000, outputTokens: 4096 },
        }),
        executeWithHistory: jest.fn().mockResolvedValue({ content: 'ok' }),
      } as unknown as jest.Mocked<LlmAdapter>;
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(service.generatePlan('fix', '# WBP-999: Truncation test')).rejects.toMatchObject({
        message: expect.stringContaining('stages.plan.maxTokens'),
      });
    });

    it('detects truncation via finishReason for non-Anthropic providers', async () => {
      const adapter = {
        execute: jest.fn().mockResolvedValue({
          content: '{"action":"fix","summary":"Truncated',
          finishReason: 'length',
          usage: { inputTokens: 1000, outputTokens: 4096 },
        }),
        executeWithHistory: jest.fn().mockResolvedValue({ content: 'ok' }),
      } as unknown as jest.Mocked<LlmAdapter>;
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(service.generatePlan('fix', '# WBP-1000: OpenAI truncation')).rejects.toMatchObject({
        message: expect.stringContaining('stages.plan.maxTokens'),
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
    afterEach(() => {
      jest.restoreAllMocks();
    });

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
  "callStack": [
    {
      "frame": "eventPaymentRecorded()",
      "children": [
        {
          "frame": "addPaymentToBooking()"
        }
      ]
    }
  ],
  "stateTransition": {
    "from": "eventPaymentRecorded",
    "to": "addPaymentToBooking",
    "steps": [
      {
        "frame": "eventPaymentRecorded()"
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
      expect(review.callStack).toEqual([
        {
          frame: 'eventPaymentRecorded()',
          children: [
            {
              frame: 'addPaymentToBooking()',
            },
          ],
        },
      ]);
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

    it('preserves traces where suggestions appears as a code identifier', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          summary: 'ok',
          issues: [],
          traceProvenance: 'evidence-based',
          callStack: [
            {
              frame: 'handleProviderError()',
              children: [
                {
                  frame: 'getSuggestion(error.code)',
                  children: [
                    {
                      frame: 'suggestions[ERROR_CODE.AI_PROVIDER_ERROR]',
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
          stateTransition: {
            from: 'handleProviderError',
            to: 'getSuggestion',
            steps: [
              {
                frame: 'handleProviderError()',
                captured: {
                  'suggestion map key': 'computed property',
                },
                changes: {},
                children: [],
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
diff --git a/src/error/error.handler.ts b/src/error/error.handler.ts
@@
+function handleProviderError() {
+  return getSuggestion(error.code);
+}
`,
        ['guideline']
      );

      expect(review.traceProvenance).toBe('evidence-based');
      expect(review.callStack).toEqual([
        {
          frame: 'handleProviderError()',
          children: [
            {
              frame: 'getSuggestion(error.code)',
              children: [
                {
                  frame: 'suggestions[ERROR_CODE.AI_PROVIDER_ERROR]',
                  children: [],
                },
              ],
            },
          ],
        },
      ]);
      expect(review.stateTransition).toEqual(
        expect.objectContaining({
          from: 'handleProviderError',
        })
      );
    });

    it('sanitizes traces containing reviewer-narration phrase generating suggestions', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          summary: 'ok',
          issues: [],
          traceProvenance: 'evidence-based',
          callStack: [
            {
              frame: 'Generating suggestions for payment.controller.ts',
              children: [
                {
                  frame: 'eventPaymentRecorded()',
                  children: [],
                },
              ],
            },
          ],
          stateTransition: {
            from: 'initial',
            to: 'complete',
            steps: [],
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

    it('retries a prose review response once and returns the second valid review', async () => {
      const adapter = createAdapter();
      adapter.execute
        .mockResolvedValueOnce({
          content: 'The code looks good overall. Nice work on the refactoring.',
          provider: 'openai',
          model: 'gpt-5.4',
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
          provider: 'openai',
          model: 'gpt-5.4',
          finishReason: 'stop',
        });
      const service = new AiService(mockLogger, adapter, createConfigService());

      const review = await service.reviewCode('diff', ['guideline']);

      expect(adapter.execute).toHaveBeenCalledTimes(2);
      expect(review.summary).toBe('ok');
    });

    it('raises an AIError with prose message when both attempts return prose', async () => {
      const adapter = createAdapter();
      adapter.execute
        .mockResolvedValueOnce({
          content: 'The code looks good overall.',
          provider: 'openai',
          model: 'gpt-5.4',
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: 'I recommend improving the error handling.',
          provider: 'openai',
          model: 'gpt-5.4',
          finishReason: 'stop',
        });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(service.reviewCode('diff', ['guideline'])).rejects.toMatchObject({
        message: 'AI provider returned a prose review response without JSON',
        details: expect.objectContaining({
          provider: 'openai',
          model: 'gpt-5.4',
        }),
      });
      expect(adapter.execute).toHaveBeenCalledTimes(2);
    });

    it('does not retry prose responses when provider metadata indicates content_filter', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: 'I cannot review this code.',
        provider: 'openai',
        model: 'gpt-5.4',
        finishReason: 'content_filter',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(service.reviewCode('diff', ['guideline'])).rejects.toMatchObject({
        message: 'AI provider returned a prose review response without JSON',
        details: expect.objectContaining({
          provider: 'openai',
          finishReason: 'content_filter',
        }),
      });
      expect(adapter.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('review JSON validation', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('throws AIError when LLM response is missing suggestions field', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          summary: 'Review summary',
          issues: [],
          approved: true,
          // Missing suggestions field
        }),
        provider: 'openai',
        model: 'gpt-5.4',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      await expect(service.reviewCode('diff', ['guideline'])).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse code review'),
      });
    });

    it('parses successfully when all required fields are present', async () => {
      const adapter = createAdapter();
      adapter.execute.mockResolvedValueOnce({
        content: JSON.stringify({
          summary: 'Review complete',
          issues: [],
          suggestions: ['Consider adding tests'],
          approved: true,
        }),
        provider: 'openai',
        model: 'gpt-5.4',
      });
      const service = new AiService(mockLogger, adapter, createConfigService());

      const review = await service.reviewCode('diff', ['guideline']);

      expect(review.summary).toBe('Review complete');
      expect(review.suggestions).toEqual(['Consider adding tests']);
      expect(review.approved).toBe(true);
    });
  });

  describe('parseJsonResponse greedy extraction', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('extracts deeply nested JSON with brace-containing string values and escaped quotes via greedy candidate', () => {
      const response
        = 'Here is my code review:\n'
          + '{"summary": "ok", "issues": [], "traceProvenance": "evidence-based",'
          + ' "callStack": [{"frame": "toPageId(\\"tour\\")", "children": [],'
          + ' "typeInfo": "Record<string, AggregateRating> | {}"}],'
          + ' "stateTransition": {"from": "start", "to": "end", "steps": []},'
          + ' "suggestions": ["Add tests"], "approved": false}';

      const result = parseJsonResponse<{ suggestions: string[]; approved: boolean }>(response);

      expect(result.suggestions).toEqual(['Add tests']);
      expect(result.approved).toBe(false);
    });

    it('falls through from greedy to conservative when prose after JSON contains a stray brace', () => {
      const response
        = 'Here is my review:\n'
          + '{"summary": "ok", "issues": [], "suggestions": [], "approved": true}'
          + '\n\nSee config}';

      const result = parseJsonResponse<{ summary: string; approved: boolean }>(response);

      expect(result.summary).toBe('ok');
      expect(result.approved).toBe(true);
    });

    it('repairs JSON with an extra ]} pair from deeply nested callStack', () => {
      // The AI produced an extra nesting level in callStack, adding one excess ]}
      // pair. JSON.parse considers the outer object complete at the premature },
      // leaving suggestions and approved orphaned after the "valid" object.
      // The repair candidate removes the }] at the failure boundary.
      const response
        = '{"summary": "ok", "issues": [], "callStack": ['
          + '{"frame": "a()", "children": ['
          + '{"frame": "b()", "children": ['
          + '{"frame": "c()", "children": []}'
          + ']}'
          + ']}'
          + ']}' // extra ]} — closes the outer object prematurely
          + '], "suggestions": ["fix it"], "approved": false}';

      const result = parseJsonResponse<{ suggestions: string[]; approved: boolean }>(response);

      expect(result.suggestions).toEqual(['fix it']);
      expect(result.approved).toBe(false);
    });

    it('parses clean JSON, code-fenced JSON, and standard prose+JSON without regression', () => {
      const clean = '{"key": "value", "approved": true}';
      expect(parseJsonResponse<{ key: string; approved: boolean }>(clean)).toEqual({
        key: 'value',
        approved: true,
      });

      const fenced = '```json\n{"key": "fenced", "approved": false}\n```';
      expect(parseJsonResponse<{ key: string; approved: boolean }>(fenced)).toEqual({
        key: 'fenced',
        approved: false,
      });

      const proseAndJson = 'Sure, here you go:\n{"key": "prose", "approved": true}';
      expect(parseJsonResponse<{ key: string; approved: boolean }>(proseAndJson)).toEqual({
        key: 'prose',
        approved: true,
      });
    });
  });

  describe('review progress callback', () => {
    it('should invoke onProgress with Synthesizing review message', async () => {
      const adapter = createAdapter();
      const service = new AiService(mockLogger, adapter, createConfigService());
      const onProgress = jest.fn();

      await service.reviewCode('diff', ['guideline'], onProgress);

      expect(onProgress).toHaveBeenCalledWith('Synthesizing review...');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });
  });

  describe('reviewCode skill injection', () => {
    const savedSkills = new Map(KNOWN_SKILLS);

    beforeEach(() => {
      KNOWN_SKILLS.clear();
      registerSkill({ id: 'receiving-code-review', stages: ['review', 'implement'] });
    });

    afterEach(() => {
      KNOWN_SKILLS.clear();
      for (const [k, v] of savedSkills) KNOWN_SKILLS.set(k, v);
      jest.restoreAllMocks();
    });

    it('includes skill invocation hints in review prompt when skills are configured', async () => {
      const adapter = createAdapter();
      const configService = {
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'ai.provider': 'openai',
            'ai.model': 'gpt-5.4',
            'ai.providers': [{ provider: 'openai', apiKey: 'k', model: 'gpt-5.4', default: true }],
            'stages.review.skills': ['receiving-code-review'],
          };
          return key in values ? values[key] : defaultValue;
        }),
      } as unknown as ConfigService;
      const service = new AiService(mockLogger, adapter, configService);

      await service.reviewCode('diff --git a/file', ['check style']);

      const prompt = (adapter.execute as jest.Mock).mock.calls[0][0].prompt as string;
      expect(prompt).toContain("Skill('receiving-code-review')");
      expect(prompt).toContain('Skill-specific instructions:');
    });

    it('omits skill section from review prompt when no skills are configured', async () => {
      const adapter = createAdapter();
      const service = new AiService(mockLogger, adapter, createConfigService());

      await service.reviewCode('diff --git a/file', ['check style']);

      const prompt = (adapter.execute as jest.Mock).mock.calls[0][0].prompt as string;
      expect(prompt).not.toContain('Skill-specific instructions:');
    });
  });
});
