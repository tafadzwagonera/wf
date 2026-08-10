import { ConfigService } from '@nestjs/config';
import { StageAgentService } from './stage-agent.service';
import { ExecutionError } from '../../shared/utils/errors';
import { discoverDirAgentConfigs } from './adapters/discover-dir-agent-configs';

jest.mock('./adapters/claude-cli-runner', () => ({
  assertClaudeCliAvailable: jest.fn(),
  buildCliArgs: jest.fn().mockReturnValue([]),
  spawnCli: jest.fn(),
}));

jest.mock('./adapters/codex-cli-runner', () => ({
  assertCodexCliAvailable: jest.fn(),
  buildCodexCliArgs: jest.fn().mockReturnValue([]),
  spawnCodex: jest.fn(),
}));

const { spawnCli }: { spawnCli: jest.Mock } = jest.requireMock('./adapters/claude-cli-runner');
const { spawnCodex }: { spawnCodex: jest.Mock } = jest.requireMock('./adapters/codex-cli-runner');
const { buildCliArgs }: { buildCliArgs: jest.Mock } = jest.requireMock('./adapters/claude-cli-runner');
const mockDiscoverDirAgentConfigs = discoverDirAgentConfigs as jest.MockedFunction<typeof discoverDirAgentConfigs>;

jest.mock('./adapters/discover-dir-agent-configs', () => ({
  discoverDirAgentConfigs: jest.fn().mockReturnValue([]),
  PROVIDER_CONFIG_FILENAMES: {
    anthropic: 'CLAUDE.md',
    openai: 'AGENTS.md',
    google: 'GEMINI.md',
    deepseek: 'DEEPSEEK.md',
  },
}));

describe('StageAgentService', () => {
  const createConfigService = (): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'stages.plan.backend': 'agent',
          'stages.plan.provider': 'openai',
          'stages.plan.model': 'gpt-5.4',
          'stages.review.backend': 'agent',
          'stages.review.provider': 'openai',
          'stages.review.model': 'gpt-5.4',
          'stages.generate.backend': 'agent',
          'stages.generate.provider': 'openai',
          'stages.generate.model': 'gpt-5.4',
          'ai.provider': 'openai',
          'ai.model': 'gpt-5.4',
        };

        return key in values ? values[key] : defaultValue;
      }),
    }) as unknown as ConfigService;

  const createCodexConfigService = (): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'stages.plan.backend': 'cli',
          'stages.plan.provider': 'openai',
          'stages.plan.model': 'gpt-5.4-mini',
          'ai.provider': 'openai',
          'ai.model': 'gpt-5.4-mini',
        };

        return key in values ? values[key] : defaultValue;
      }),
    }) as unknown as ConfigService;

  const createCodexReviewConfigService = (): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'stages.review.backend': 'cli',
          'stages.review.provider': 'openai',
          'stages.review.model': 'gpt-5.4-mini',
          'ai.provider': 'openai',
          'ai.model': 'gpt-5.4-mini',
        };

        return key in values ? values[key] : defaultValue;
      }),
    }) as unknown as ConfigService;

  const createClaudeCliReviewConfigService = (): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'stages.review.backend': 'cli',
          'stages.review.provider': 'anthropic',
          'stages.review.model': 'claude-sonnet-4-5-20250514',
          'ai.provider': 'anthropic',
          'ai.model': 'claude-sonnet-4-5-20250514',
        };

        return key in values ? values[key] : defaultValue;
      }),
    }) as unknown as ConfigService;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('raises an AiProviderError with provider metadata when the plan response is blank', async () => {
    const service = new StageAgentService(createConfigService());
    (
      service as unknown as {
        runStagePrompt: jest.Mock;
      }
    ).runStagePrompt = jest.fn().mockResolvedValue({ content: '  ' });

    await expect(
      service.generatePlan({
        action: 'fix',
        issueContent: 'Fix callback handling',
      })
    ).rejects.toMatchObject({
      message: 'AI provider returned an empty plan response',
      details: expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    });
  });

  it('raises an AiProviderError with provider metadata when generated content is blank', async () => {
    const service = new StageAgentService(createConfigService());
    (
      service as unknown as {
        runStagePrompt: jest.Mock;
      }
    ).runStagePrompt = jest.fn().mockResolvedValue({ content: '' });

    await expect(service.generateFromPrompt('Summarise this diff')).rejects.toMatchObject({
      message: 'AI provider returned an empty generated content response',
      details: expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    });
  });

  it('raises an AiProviderError with provider metadata when an OpenAI chat turn is blank', async () => {
    const service = new StageAgentService(createConfigService());
    (
      service as unknown as {
        resolveStageBackend: jest.Mock;
        resolveStageProvider: jest.Mock;
        openAiChatTurn: jest.Mock;
      }
    ).resolveStageBackend = jest.fn().mockReturnValue('agent');
    (
      service as unknown as {
        resolveStageProvider: jest.Mock;
        resolveStageBackend: jest.Mock;
        openAiChatTurn: jest.Mock;
      }
    ).resolveStageProvider = jest.fn().mockReturnValue('openai');
    (
      service as unknown as {
        resolveStageProvider: jest.Mock;
        resolveStageBackend: jest.Mock;
        openAiChatTurn: jest.Mock;
      }
    ).openAiChatTurn = jest.fn().mockResolvedValue({
      content: ' ',
      session: { provider: 'openai' },
    });

    await expect(
      service.chatTurn({
        stage: 'review',
        userMessage: 'Why is this failing?',
        systemPrompt: 'Help',
      })
    ).rejects.toMatchObject({
      message: 'AI provider returned an empty chat response',
      details: expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    });
  });

  it('forwards onProgress callback to runStagePrompt when generating a plan', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Fix it',
        steps: ['step 1'],
        estimatedComplexity: 'low',
        affectedFiles: [],
        risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    const onProgress = jest.fn();
    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix callback handling',
      onProgress,
    });

    expect(mockRunStagePrompt).toHaveBeenCalledWith(expect.objectContaining({ onProgress }));
  });

  it('includes the prompt-quality rules when generating a plan', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Fix it',
        steps: ['step 1'],
        estimatedComplexity: 'low',
        affectedFiles: [],
        risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix callback handling',
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
            testPatterns: {
              fileSuffix: '.spec',
              mockPrefix: 'mock',
              mockFactoryPrefix: 'createMock',
              describeStyle: 'flat',
              helperPaths: ['src/test/helpers.ts'],
              mockCleanup: { namespace: 'jest', method: 'restoreAllMocks' },
              diSetupPattern: 'testing-module',
              errorHandlerExits: true,
            },
          },
        ],
      },
    });

    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Be explicit about before and after'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'Verification commands must be shell-safe'
        ),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'Trace impact across the codebase'
        ),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Return ONLY a valid JSON object. Reference:'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('When an optional field has no value, omit it from the JSON entirely. Do not use null.'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Prefer re-running generators over manually patching'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Mock setup must be concrete and complete'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Cross-check consistency'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Surface hidden gaps'),
      })
    );
  });

  describe('plan JSON validation', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('rejects a plan payload that passes JSON parsing but fails resolutionPlanSchema', async () => {
      const service = new StageAgentService(createConfigService());
      const mockRunStagePrompt = jest.fn().mockResolvedValue({
        content: JSON.stringify({
          action: 'fix',
          summary: 'Invalid plan',
          steps: ['Step 1'],
          estimatedComplexity: 'unexpected',
        }),
        sessionId: undefined,
      });
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

      await expect(
        service.generatePlan({
          action: 'fix',
          issueContent: 'Fix callback handling',
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse resolution plan from agent response'),
      });
      expect(mockRunStagePrompt).toHaveBeenCalledTimes(1);
    });
  });

  it('adds retry feedback only when a prior plan attempt was rejected', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Retry plan',
        steps: ['Rename AuthService to AuthSessionService in repo-a/src/auth.ts.'],
        estimatedComplexity: 'low',
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix callback handling',
      affectedRepositories: ['repo-a'],
      planQualityFeedback: ['[rename-target-required] Step 1 must name the replacement target.'],
    });

    const prompt = mockRunStagePrompt.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('Previous plan attempt was rejected for these exact reasons:');
    expect(prompt).toContain('[rename-target-required] Step 1 must name the replacement target.');
  });

  it('omits retry feedback when no prior plan rejection exists', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Fresh plan',
        steps: ['Inspect auth flow.'],
        estimatedComplexity: 'low',
        affectedFiles: ['repo-a/src/auth.ts'],
        affectedRepositories: ['repo-a'],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix callback handling',
      affectedRepositories: ['repo-a'],
    });

    const prompt = mockRunStagePrompt.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).not.toContain('Previous plan attempt was rejected for these exact reasons:');
  });

  it('places the no-null instruction after the plan example block', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Fix it',
        steps: ['step 1'],
        estimatedComplexity: 'low',
        affectedFiles: [],
        risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix callback handling',
      affectedRepositories: ['repo-a'],
    });

    const prompt = mockRunStagePrompt.mock.calls[0]?.[0]?.prompt as string;

    expect(prompt).toContain(
      'Return ONLY a valid JSON object. Reference:\n{"action":"fix","summary":"Extract shared auth guard into a reusable middleware.'
    );
    expect(prompt).toContain('When an optional field has no value, omit it from the JSON entirely. Do not use null.');
    expect(prompt.indexOf('When an optional field has no value, omit it from the JSON entirely. Do not use null.')).toBeLessThan(
      prompt.indexOf('IMPORTANT: Minify the JSON')
    );
  });

  it('includes prior plan context in the generated plan prompt when provided', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Fix it',
        steps: ['step 1'],
        estimatedComplexity: 'low',
        affectedFiles: [],
        risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix callback handling',
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

    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Related prior plans (repo-a):'),
      })
    );
  });

  it('omits node-specific shell-safety guidance when generating a non-node plan', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix',
        summary: 'Fix it',
        steps: ['step 1'],
        estimatedComplexity: 'low',
        affectedFiles: [],
        risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix terraform validation guidance',
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

    const prompt = mockRunStagePrompt.mock.calls[0]?.[0]?.prompt;
    expect(prompt).not.toContain(
      'Verification commands MUST be shell-safe by construction. For inline `node -e`, prefer'
    );
  });

  it('forwards onProgress callback to runStagePrompt when generating from prompt', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({ content: 'Generated content' });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    const onProgress = jest.fn();
    await service.generateFromPrompt('Summarise this', onProgress);

    expect(mockRunStagePrompt).toHaveBeenCalledWith(expect.objectContaining({ onProgress }));
  });

  it('does not pass onProgress when not provided', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({ content: 'Generated content' });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generateFromPrompt('Summarise this');

    expect(mockRunStagePrompt).toHaveBeenCalledWith(expect.objectContaining({ onProgress: undefined }));
  });

  describe('provider session ID logging', () => {
    const createCliConfigService = (): ConfigService =>
      ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.plan.backend': 'cli',
            'stages.plan.provider': 'anthropic',
            'stages.plan.model': 'claude-sonnet-4-5-20250514',
            'ai.provider': 'anthropic',
            'ai.model': 'claude-sonnet-4-5-20250514',
          };
          return key in values ? values[key] : defaultValue;
        }),
      }) as unknown as ConfigService;

    beforeEach(() => {
      spawnCli.mockClear();
    });

    it('logs provider session ID when CLI backend returns one', async () => {
      const sessionId = 'sess_abc123';
      async function* fakeSpawn() {
        yield { type: 'result', subtype: 'success', result: '{"action":"fix"}', session_id: sessionId };
      }
      spawnCli.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCliConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      const sessionLogs = logSpy.mock.calls.filter(call => String(call[0]).includes('Provider session:'));
      expect(sessionLogs.length).toBeGreaterThanOrEqual(1);
      expect(String(sessionLogs[0][0])).toContain(sessionId);

      logSpy.mockRestore();
    });

    it('does not log provider session when sessionId is undefined', async () => {
      async function* fakeSpawn() {
        yield { type: 'result', subtype: 'success', result: '{"action":"fix"}' };
      }
      spawnCli.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCliConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      const sessionLogs = logSpy.mock.calls.filter(call => String(call[0]).includes('Provider session:'));
      expect(sessionLogs).toHaveLength(0);

      logSpy.mockRestore();
    });

    it('uses the minified JSON retry prompt after a blank first pass', async () => {
      async function* firstPass() {
        yield { type: 'assistant', message: { content: [] }, session_id: 'sess_abc123' };
      }
      async function* secondPass() {
        yield { type: 'result', subtype: 'success', result: '{"action":"fix"}', session_id: 'sess_abc123' };
      }
      buildCliArgs.mockClear();
      spawnCli.mockImplementationOnce(firstPass).mockImplementationOnce(secondPass);

      const service = new StageAgentService(createCliConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      expect(buildCliArgs).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          prompt:
            'Your previous response did not include a usable result. Please output ONLY a valid JSON object matching the resolution plan schema. Do not include commentary or markdown — IMPORTANT: raw, minified JSON only (no unnecessary whitespace or newlines). JSON string values must not contain literal newline characters — use \\n for line breaks within strings.',
          sessionId: 'sess_abc123',
        })
      );

      logSpy.mockRestore();
    });

    it('rejects assistant_text and retries', async () => {
      async function* firstPass() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me think about this...' }] }, session_id: 'sess_abc123' };
      }
      async function* secondPass() {
        yield { type: 'result', subtype: 'success', result: '{"action":"fix"}', session_id: 'sess_abc123' };
      }
      spawnCli.mockImplementationOnce(firstPass).mockImplementationOnce(secondPass);

      const service = new StageAgentService(createCliConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      expect(result).toMatchObject({ content: '{"action":"fix"}' });
      const demotedLogs = logSpy.mock.calls.filter(call => String(call[0]).includes('assistant_text demoted'));
      expect(demotedLogs.length).toBeGreaterThanOrEqual(1);
      expect(spawnCli).toHaveBeenCalledTimes(2);

      logSpy.mockRestore();
    });

    it('terminates after stall threshold with consecutive assistant_text passes', async () => {
      async function* firstPass() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Still thinking...' }] }, session_id: 'sess_abc123' };
      }
      async function* secondPass() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Still thinking...' }] }, session_id: 'sess_abc123' };
      }
      spawnCli.mockImplementationOnce(firstPass).mockImplementationOnce(secondPass);

      const service = new StageAgentService(createCliConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      await expect(runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' })).rejects.toThrow(/workload not decreasing/);
      expect(spawnCli).toHaveBeenCalledTimes(2);
    });

    it('stall error includes sessionId from CLI stream', async () => {
      async function* firstPass() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking...' }] }, session_id: 'sess_stall_123' };
      }
      async function* secondPass() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking...' }] }, session_id: 'sess_stall_123' };
      }
      spawnCli.mockImplementationOnce(firstPass).mockImplementationOnce(secondPass);

      const service = new StageAgentService(createCliConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      try {
        await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });
        throw new Error('should not reach');
      } catch (error: unknown) {
        expect((error as any).category).toBe('stall');
        expect((error as any).details?.sessionId).toBe('sess_stall_123');
      }
    });

    it('review-stage stall error includes sessionId despite fresh-start reset', async () => {
      async function* firstPass() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking...' }] }, session_id: 'sess_review_stall' };
      }
      async function* secondPass() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'still thinking...' }] }, session_id: 'sess_review_stall_2' };
      }
      spawnCli.mockImplementationOnce(firstPass).mockImplementationOnce(secondPass);

      const service = new StageAgentService(createClaudeCliReviewConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      try {
        await runner({ stage: 'review', prompt: 'review prompt', systemPrompt: 'sys' });
        throw new Error('should not reach');
      } catch (error: unknown) {
        expect((error as any).category).toBe('stall');
        expect((error as any).details?.sessionId).toBe('sess_review_stall_2');
      }
    });

    it('accepts structured_output on pass 1 without retry', async () => {
      async function* fakeSpawn() {
        yield { type: 'result', subtype: 'success', structured_output: { action: 'fix' }, session_id: 'sess_abc123' };
      }
      spawnCli.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCliConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      expect(result).toMatchObject({ content: '{"action":"fix"}' });
      expect(spawnCli).toHaveBeenCalledTimes(1);

      logSpy.mockRestore();
    });

    it('accepts result on pass 1 without retry', async () => {
      async function* fakeSpawn() {
        yield { type: 'result', subtype: 'success', result: '{"action":"fix"}', session_id: 'sess_abc123' };
      }
      spawnCli.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCliConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      expect(result).toMatchObject({ content: '{"action":"fix"}' });
      expect(spawnCli).toHaveBeenCalledTimes(1);

      logSpy.mockRestore();
    });

    it('throws AiProviderError when CLI result has stop_reason max_tokens', async () => {
      async function* fakeSpawn() {
        yield { type: 'result', result: '{"action":"fix"}', stop_reason: 'max_tokens' };
      }
      spawnCli.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCliConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      await expect(runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' })).rejects.toThrow(
        /reduce prompt\/context size|switch to OpenAI/i
      );
    });

    it('logs when Codex emits multiple agent_message chunks', async () => {
      async function* fakeSpawn() {
        yield { type: 'thread.started', thread_id: 'tid-123' };
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'first chunk' } };
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'final chunk' } };
      }
      spawnCodex.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCodexConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCodexCliStagePrompt.bind(service);
      const result = await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      expect(result).toMatchObject({ content: 'final chunk' });
      expect(logSpy.mock.calls.map(call => String(call[0])).join('\n')).toContain('agent_message chunks');
      logSpy.mockRestore();
    });

    it('emits Codex progress lines without extra indentation', async () => {
      async function* fakeSpawn() {
        yield { type: 'thread.started', thread_id: 'tid-123' };
        yield { type: 'item.started', item: { type: 'command_execution', command: 'yarn build' } };
        yield { type: 'item.completed', item: { type: 'command_execution', command: 'yarn build', exit_code: 0 } };
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'final chunk' } };
      }
      spawnCodex.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCodexConfigService());
      const onProgress = jest.fn();
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCodexCliStagePrompt.bind(service);
      await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys', onProgress });

      expect(onProgress).toHaveBeenCalledWith('  [codex-cli] Session started: tid-123');
      expect(onProgress).toHaveBeenCalledWith('  [codex-cli] Running: yarn build');
      expect(onProgress).toHaveBeenCalledWith('  [codex-cli] Command completed: yarn build');
      expect(onProgress).toHaveBeenCalledWith('  [codex-cli] Agent: final chunk');
      expect(onProgress.mock.calls.some(call => String(call[0]).startsWith('  [codex-cli]'))).toBe(true);

      logSpy.mockRestore();
    });

    it('does not throw when stop_reason is absent', async () => {
      async function* fakeSpawn() {
        yield { type: 'result', result: '{"action":"fix"}' };
      }
      spawnCli.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCliConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });
      expect(result).toMatchObject({ content: expect.any(String) });
    });
  });

  describe('review stage fresh-start retry', () => {
    beforeEach(() => {
      spawnCli.mockClear();
      buildCliArgs.mockClear();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('starts fresh session on review retry instead of resuming', async () => {
      async function* firstPass() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Let me think...' }] },
          session_id: 'sess_abc',
        };
      }
      async function* secondPass() {
        yield { type: 'result', subtype: 'success', result: '{"comments":[]}' };
      }
      spawnCli.mockImplementationOnce(firstPass).mockImplementationOnce(secondPass);

      const service = new StageAgentService(createClaudeCliReviewConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'review', prompt: 'original review prompt', systemPrompt: 'sys' });

      expect(buildCliArgs).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          prompt: 'original review prompt',
          sessionId: undefined,
        })
      );
      expect(result).toMatchObject({ content: '{"comments":[]}' });
      expect(result.sessionId).toBeUndefined();

      const freshStartLogs = logSpy.mock.calls.filter(call =>
        String(call[0]).includes('Review retry starts fresh')
      );
      expect(freshStartLogs.length).toBeGreaterThanOrEqual(1);

      logSpy.mockRestore();
    });

    it('still resumes session on non-review stage retry', async () => {
      async function* firstPass() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Let me think...' }] },
          session_id: 'sess_abc',
        };
      }
      async function* secondPass() {
        yield { type: 'result', subtype: 'success', result: '{"action":"fix"}', session_id: 'sess_abc' };
      }
      spawnCli.mockImplementationOnce(firstPass).mockImplementationOnce(secondPass);

      const createCliConfigService = (): ConfigService =>
        ({
          get: jest.fn((key: string, defaultValue?: unknown) => {
            const values: Record<string, unknown> = {
              'stages.plan.backend': 'cli',
              'stages.plan.provider': 'anthropic',
              'stages.plan.model': 'claude-sonnet-4-5-20250514',
              'ai.provider': 'anthropic',
              'ai.model': 'claude-sonnet-4-5-20250514',
            };
            return key in values ? values[key] : defaultValue;
          }),
        }) as unknown as ConfigService;

      const service = new StageAgentService(createCliConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'plan', prompt: 'original plan prompt', systemPrompt: 'sys' });

      expect(buildCliArgs).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          prompt:
            'Your previous response did not include a usable result. Please output ONLY a valid JSON object matching the resolution plan schema. Do not include commentary or markdown — IMPORTANT: raw, minified JSON only (no unnecessary whitespace or newlines). JSON string values must not contain literal newline characters — use \\n for line breaks within strings.',
          sessionId: 'sess_abc',
        })
      );
      expect(result).toMatchObject({ content: '{"action":"fix"}' });

      logSpy.mockRestore();
    });

    it('throws stall error after 2 fresh review attempts', async () => {
      async function* firstPass() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Still thinking...' }] },
          session_id: 'sess_abc',
        };
      }
      async function* secondPass() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Still thinking...' }] },
          session_id: undefined,
        };
      }
      spawnCli.mockImplementationOnce(firstPass).mockImplementationOnce(secondPass);

      const service = new StageAgentService(createClaudeCliReviewConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      await expect(
        runner({ stage: 'review', prompt: 'original review prompt', systemPrompt: 'sys' })
      ).rejects.toThrow(/workload not decreasing/);
      expect(spawnCli).toHaveBeenCalledTimes(2);
    });
  });

  it('sets executionMode to cli when review backend is cli', async () => {
    const configService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'stages.review.backend': 'cli',
          'stages.review.provider': 'openai',
          'stages.review.model': 'gpt-5.4',
          'ai.provider': 'openai',
          'ai.model': 'gpt-5.4',
        };
        return key in values ? values[key] : defaultValue;
      }),
    } as unknown as ConfigService;

    const service = new StageAgentService(configService);
    const mockReviewJson = JSON.stringify({
      summary: 'Looks good',
      issues: [],
      suggestions: [],
      approved: true,
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = jest
      .fn()
      .mockResolvedValue({ content: mockReviewJson, sessionId: undefined });

    const { review } = await service.reviewCode('diff --git a/f b/f', []);
    expect(review.executionMode).toBe('cli');
  });

  it('places the JSON minification instruction after the review example block', async () => {
    const service = new StageAgentService(createConfigService());
    const mockReviewJson = JSON.stringify({
      summary: 'Looks good',
      issues: [],
      suggestions: [],
      approved: true,
    });
    const mockRunStagePrompt = jest.fn().mockResolvedValue({ content: mockReviewJson, sessionId: undefined });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.reviewCode('diff --git a/f b/f', []);

    const prompt = mockRunStagePrompt.mock.calls[0]?.[0]?.prompt as string;

    expect(prompt).toContain('"approved":true}\n\nPrefer an absolute line number.');
    expect(prompt).not.toContain('"approved":true}\nIMPORTANT: Minify the JSON');
  });

  it('sets executionMode to agent when review backend is agent', async () => {
    const service = new StageAgentService(createConfigService());
    const mockReviewJson = JSON.stringify({
      summary: 'Looks good',
      issues: [],
      suggestions: [],
      approved: true,
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = jest
      .fn()
      .mockResolvedValue({ content: mockReviewJson, sessionId: undefined });

    const { review } = await service.reviewCode('diff --git a/f b/f', []);
    expect(review.executionMode).toBe('agent');
  });

  it('enables the review stage when backend is omitted from config', () => {
    const configService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'stages.review.provider': 'openai',
          'stages.review.model': 'gpt-5.4',
          'ai.provider': 'openai',
          'ai.model': 'gpt-5.4',
        };

        return key in values ? values[key] : defaultValue;
      }),
    } as unknown as ConfigService;

    const service = new StageAgentService(configService);

    expect(service.isEnabledForStage('review')).toBe(true);
  });

  describe('review JSON validation', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('throws AiProviderError when LLM response is missing suggestions field', async () => {
      const configService = createConfigService();
      const service = new StageAgentService(configService);
      const mockReviewJson = JSON.stringify({
        summary: 'Review summary',
        issues: [],
        approved: true,
        // Missing suggestions field
      });
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = jest
        .fn()
        .mockResolvedValue({ content: mockReviewJson, sessionId: undefined });

      await expect(service.reviewCode('diff --git a/f b/f', [])).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse code review'),
      });
    });

    it('review parse error includes sessionId in details', async () => {
      spawnCli.mockImplementationOnce(async function* () {
        yield { type: 'result', subtype: 'success', result: 'not valid json', session_id: 'sess_review_789' };
      });

      const service = new StageAgentService(createClaudeCliReviewConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await service.reviewCode('diff content', ['guideline'], undefined, undefined, undefined, undefined, undefined);
        throw new Error('should not reach');
      } catch (error: unknown) {
        expect((error as any).category).toBe('parse');
        expect((error as any).details?.sessionId).toBe('sess_review_789');
      }
    });

    it('parses successfully when all required fields are present', async () => {
      const configService = createConfigService();
      const service = new StageAgentService(configService);
      const mockReviewJson = JSON.stringify({
        summary: 'Review complete',
        issues: [],
        suggestions: ['Consider adding tests'],
        approved: true,
      });
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = jest
        .fn()
        .mockResolvedValue({ content: mockReviewJson, sessionId: undefined });

      const { review } = await service.reviewCode('diff --git a/f b/f', []);

      expect(review.summary).toBe('Review complete');
      expect(review.suggestions).toEqual(['Consider adding tests']);
      expect(review.approved).toBe(true);
    });
  });

  describe('Codex CLI stage prompt', () => {
    const makeCodexStream = (...messages: object[]) =>
      async function* () {
        for (const m of messages) yield m;
      };

    const validPlanJson = JSON.stringify({
      action: 'fix',
      summary: 'Test summary',
      steps: ['Step 1'],
      estimatedComplexity: 'low',
    });

    it('extracts result from a single item.completed agent_message event', async () => {
      spawnCodex.mockImplementation(
        makeCodexStream({
          type: 'item.completed',
          item: { type: 'agent_message', text: validPlanJson },
        })
      );

      const service = new StageAgentService(createCodexConfigService());
      const result = await service.generatePlan({
        action: 'fix',
        issueContent: 'Test issue',
      });

      expect(result.plan.action).toBe('fix');
      expect(result.plan.summary).toBe('Test summary');
    });

    it('extracts session ID from a thread.started event', async () => {
      spawnCodex.mockImplementation(
        makeCodexStream(
          { type: 'thread.started', thread_id: 'tid-123' },
          { type: 'item.completed', item: { type: 'agent_message', text: validPlanJson } }
        )
      );

      const service = new StageAgentService(createCodexConfigService());
      const result = await service.generatePlan({
        action: 'fix',
        issueContent: 'Test issue',
      });

      expect(result.sessionId).toBe('tid-123');
    });

    it('throws AiProviderError containing "without returning a result" when no agent_message events are emitted', async () => {
      spawnCodex.mockImplementation(makeCodexStream({ type: 'thread.started', thread_id: 'tid-123' }));

      const service = new StageAgentService(createCodexConfigService());

      await expect(
        service.generatePlan({
          action: 'fix',
          issueContent: 'Test issue',
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining('without returning a result'),
      });
    });

    it('uses the last agent_message text when multiple are emitted', async () => {
      const plan1 = JSON.stringify({
        action: 'fix',
        summary: 'First',
        steps: [],
        estimatedComplexity: 'low',
      });
      const plan2 = JSON.stringify({
        action: 'fix',
        summary: 'Second',
        steps: [],
        estimatedComplexity: 'low',
      });
      const plan3 = JSON.stringify({
        action: 'fix',
        summary: 'Third',
        steps: [],
        estimatedComplexity: 'low',
      });

      spawnCodex.mockImplementation(
        makeCodexStream(
          { type: 'item.completed', item: { type: 'agent_message', text: plan1 } },
          { type: 'item.completed', item: { type: 'agent_message', text: plan2 } },
          { type: 'item.completed', item: { type: 'agent_message', text: plan3 } }
        )
      );

      const service = new StageAgentService(createCodexConfigService());
      const result = await service.generatePlan({
        action: 'fix',
        issueContent: 'Test issue',
      });

      expect(result.plan.summary).toBe('Third');
    });

    it('throws AiProviderError when Codex agent_message is truncated', async () => {
      spawnCodex.mockImplementation(
        makeCodexStream({
          type: 'item.completed',
          stop_reason: 'max_tokens',
          item: { type: 'agent_message', text: validPlanJson },
        })
      );

      const service = new StageAgentService(createCodexConfigService());

      await expect(
        service.generatePlan({
          action: 'fix',
          issueContent: 'Test issue',
        })
      ).rejects.toThrow(/reduce prompt\/context size|switch to provider-backed OpenAI/i);
    });

    it('ignores message.session_id field — sessionId stays undefined when only session_id (not thread_id) is present', async () => {
      spawnCodex.mockImplementation(
        makeCodexStream(
          { type: 'some.event', session_id: 'old-id' },
          { type: 'item.completed', item: { type: 'agent_message', text: validPlanJson } }
        )
      );

      const service = new StageAgentService(createCodexConfigService());
      const result = await service.generatePlan({
        action: 'fix',
        issueContent: 'Test issue',
      });

      expect(result.sessionId).toBeUndefined();
    });
  });

  describe('CLI review epilogue', () => {
    beforeEach(() => {
      spawnCli.mockReset();
      spawnCodex.mockReset();
    });

    const makeCodexStream = (...messages: object[]) =>
      async function* () {
        for (const message of messages) {
          yield message;
        }
      };

    const makeClaudeStream = (...messages: object[]) =>
      async function* () {
        for (const message of messages) {
          yield message;
        }
      };

    const validReviewJson = JSON.stringify({
      summary: 'Looks good overall',
      issues: [],
      suggestions: ['Add unit tests'],
      approved: true,
    });

    it('sends epilogue turn after successful Codex CLI review', async () => {
      spawnCodex
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'thread.started', thread_id: 'review-session-42' },
            { type: 'item.completed', item: { type: 'agent_message', text: validReviewJson } }
          )
        )
        .mockImplementationOnce(
          makeCodexStream({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Approved. No major issues found.' },
          })
        );

      const service = new StageAgentService(createCodexReviewConfigService());

      const result = await service.reviewCode('diff --git a/f b/f', []);

      expect(result.review.approved).toBe(true);
      expect(result.sessionId).toBe('review-session-42');
      expect(spawnCodex).toHaveBeenCalledTimes(2);
      expect(spawnCodex).toHaveBeenLastCalledWith(
        expect.any(Array),
        process.cwd(),
        expect.stringContaining('Summarize the code review you just completed'),
        undefined,
        5000
      );
    });

    it('sends epilogue turn after successful Claude CLI review', async () => {
      spawnCli
        .mockImplementationOnce(
          makeClaudeStream({
            type: 'result',
            subtype: 'success',
            result: validReviewJson,
            session_id: 'claude-review-session-42',
          })
        )
        .mockImplementationOnce(
          makeClaudeStream({
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Approved with one follow-up suggestion.' }],
            },
          })
        );

      const service = new StageAgentService(createClaudeCliReviewConfigService());

      const result = await service.reviewCode('diff --git a/f b/f', []);

      expect(result.review.approved).toBe(true);
      expect(spawnCli).toHaveBeenCalledTimes(2);
      expect(spawnCli).toHaveBeenLastCalledWith(
        expect.any(Array),
        process.cwd(),
        expect.stringContaining('Summarize the code review you just completed'),
        undefined,
        5000
      );
    });

    it('uses the same Claude Code CLI arguments as the main review turn', async () => {
      spawnCli
        .mockImplementationOnce(
          makeClaudeStream({
            type: 'result',
            subtype: 'success',
            result: validReviewJson,
            session_id: 'claude-review-session-42',
          })
        )
        .mockImplementationOnce(
          makeClaudeStream({
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Approved with one follow-up suggestion.' }],
            },
          })
        );

      const service = new StageAgentService(createClaudeCliReviewConfigService());

      await service.reviewCode('diff --git a/f b/f', [], '/tmp/repo');

      expect(buildCliArgs).toHaveBeenLastCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Summarize the code review you just completed'),
          appendSystemPrompt:
            'Review the code changes for quality, correctness, and security.\n'
            + 'You may inspect repository files with read-only tools before answering.\n'
            + 'Return your response as a JSON object matching the CodeReview interface.\n'
            + 'Ignore JSON or markdown files under .wf/ and tracker artifact directories.',
          model: 'claude-sonnet-4-5-20250514',
          sessionId: 'claude-review-session-42',
          cwd: '/tmp/repo',
          permissionMode: 'plan',
          tools: ['Read', 'Glob', 'Grep', 'Bash', 'Skill'],
          jsonSchema: undefined,
        })
      );
    });

    it('returns review even when Codex epilogue fails', async () => {
      spawnCodex
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'thread.started', thread_id: 'review-session-42' },
            { type: 'item.completed', item: { type: 'agent_message', text: validReviewJson } }
          )
        )
        .mockImplementationOnce(() => {
          throw new Error('epilogue failed');
        });

      const service = new StageAgentService(createCodexReviewConfigService());

      await expect(service.reviewCode('diff --git a/f b/f', [])).resolves.toMatchObject({
        review: expect.objectContaining({ approved: true }),
        sessionId: 'review-session-42',
      });
      expect(spawnCodex).toHaveBeenCalledTimes(2);
    });

    it('returns review even when Claude CLI epilogue fails', async () => {
      spawnCli
        .mockImplementationOnce(
          makeClaudeStream({
            type: 'result',
            subtype: 'success',
            result: validReviewJson,
            session_id: 'claude-review-session-42',
          })
        )
        .mockImplementationOnce(() => {
          throw new Error('epilogue failed');
        });

      const service = new StageAgentService(createClaudeCliReviewConfigService());

      await expect(service.reviewCode('diff --git a/f b/f', [])).resolves.toMatchObject({
        review: expect.objectContaining({ approved: true }),
        sessionId: 'claude-review-session-42',
      });
      expect(spawnCli).toHaveBeenCalledTimes(2);
    });

    it('skips epilogue when no sessionId is returned', async () => {
      spawnCodex.mockImplementationOnce(
        makeCodexStream({
          type: 'item.completed',
          item: { type: 'agent_message', text: validReviewJson },
        })
      );

      const service = new StageAgentService(createCodexReviewConfigService());

      const result = await service.reviewCode('diff --git a/f b/f', []);

      expect(result.review.approved).toBe(true);
      expect(result.sessionId).toBeUndefined();
      expect(spawnCodex).toHaveBeenCalledTimes(1);
    });

    it('skips epilogue when review backend is not cli', async () => {
      const service = new StageAgentService(createConfigService());
      (
        service as unknown as {
          runStagePrompt: jest.Mock;
        }
      ).runStagePrompt = jest.fn().mockResolvedValue({
        content: validReviewJson,
        sessionId: 'review-session-42',
      });

      const result = await service.reviewCode('diff --git a/f b/f', []);

      expect(result.review.approved).toBe(true);
      expect(spawnCodex).not.toHaveBeenCalled();
      expect(spawnCli).not.toHaveBeenCalled();
    });
  });

  describe('parseStagePlanResponse fallback — sessionId preserved in AiProviderError', () => {
    const createCliConfigService = (): ConfigService =>
      ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.plan.backend': 'cli',
            'stages.plan.provider': 'anthropic',
            'stages.plan.model': 'claude-sonnet-4-6',
            'ai.provider': 'anthropic',
            'ai.model': 'claude-sonnet-4-6',
          };
          return key in values ? values[key] : defaultValue;
        }),
      }) as unknown as ConfigService;

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('includes sessionId in the thrown AiProviderError when plan parsing fails', async () => {
      const fakeSessionId = 'sess_plan_fallback_test';

      const service = new StageAgentService(createCliConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = jest.fn().mockResolvedValue({
        content: 'this is not json',
        sessionId: fakeSessionId,
      });

      await expect(
        service.generatePlan({
          action: 'fix',
          issueContent: 'Fix the bug',
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse resolution plan'),
        details: expect.objectContaining({ sessionId: fakeSessionId }),
      });
    });
  });

  describe('stale resume fallback', () => {
    type StagePromptParams = {
      stage: string;
      prompt: string;
      systemPrompt: string;
      resumeProviderSessionId?: string;
    };

    const createAnthropicAgentConfigService = (): ConfigService =>
      ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.plan.backend': 'agent',
            'stages.plan.provider': 'anthropic',
            'stages.plan.model': 'claude-sonnet-4-6',
            'ai.provider': 'anthropic',
            'ai.model': 'claude-sonnet-4-6',
          };
          return key in values ? values[key] : defaultValue;
        }),
      }) as unknown as ConfigService;

    const createClaudeCliConfigService = (): ConfigService =>
      ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.plan.backend': 'cli',
            'stages.plan.provider': 'anthropic',
            'stages.plan.model': 'claude-sonnet-4-6',
            'ai.provider': 'anthropic',
            'ai.model': 'claude-sonnet-4-6',
          };
          return key in values ? values[key] : defaultValue;
        }),
      }) as unknown as ConfigService;

    const createCodexCliConfigService = (): ConfigService =>
      ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.plan.backend': 'cli',
            'stages.plan.provider': 'openai',
            'stages.plan.model': 'gpt-5.4-mini',
            'ai.provider': 'openai',
            'ai.model': 'gpt-5.4-mini',
          };
          return key in values ? values[key] : defaultValue;
        }),
      }) as unknown as ConfigService;

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('retries fresh when Anthropic agent backend throws a stale-resume error', async () => {
      const service = new StageAgentService(createAnthropicAgentConfigService());
      const mockDispatch = jest.fn()
        .mockRejectedValueOnce(new Error('session_id not found'))
        .mockResolvedValueOnce({ content: 'fresh result', sessionId: 'new-sid' });
      (service as unknown as { dispatchToBackend: jest.Mock }).dispatchToBackend = mockDispatch;
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await (service as unknown as {
        runStagePrompt: (params: StagePromptParams) => Promise<{ content: string; sessionId?: string }>;
      }).runStagePrompt({ stage: 'plan', prompt: 'test', systemPrompt: 'sys', resumeProviderSessionId: 'stale-sid' });

      expect(result.content).toBe('fresh result');
      expect(mockDispatch).toHaveBeenCalledTimes(2);
      expect(mockDispatch.mock.calls[1][0].resumeProviderSessionId).toBeUndefined();
      const warnCalls = logSpy.mock.calls.filter(call => String(call[0]).toLowerCase().includes('stale'));
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('retries fresh when Claude CLI backend throws a stale-resume error', async () => {
      const service = new StageAgentService(createClaudeCliConfigService());
      const mockDispatch = jest.fn()
        .mockRejectedValueOnce(new Error('invalid session for resume'))
        .mockResolvedValueOnce({ content: 'cli fresh result', sessionId: 'new-cli-sid' });
      (service as unknown as { dispatchToBackend: jest.Mock }).dispatchToBackend = mockDispatch;
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await (service as unknown as {
        runStagePrompt: (params: StagePromptParams) => Promise<{ content: string; sessionId?: string }>;
      }).runStagePrompt({ stage: 'plan', prompt: 'test', systemPrompt: 'sys', resumeProviderSessionId: 'stale-cli-sid' });

      expect(result.content).toBe('cli fresh result');
      expect(mockDispatch).toHaveBeenCalledTimes(2);
      expect(mockDispatch.mock.calls[1][0].resumeProviderSessionId).toBeUndefined();
    });

    it('retries fresh when Codex CLI backend throws a stale-resume error', async () => {
      const service = new StageAgentService(createCodexCliConfigService());
      const mockDispatch = jest.fn()
        .mockRejectedValueOnce(new Error('thread not found'))
        .mockResolvedValueOnce({ content: 'codex fresh result', sessionId: 'new-codex-sid' });
      (service as unknown as { dispatchToBackend: jest.Mock }).dispatchToBackend = mockDispatch;
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await (service as unknown as {
        runStagePrompt: (params: StagePromptParams) => Promise<{ content: string; sessionId?: string }>;
      }).runStagePrompt({ stage: 'plan', prompt: 'test', systemPrompt: 'sys', resumeProviderSessionId: 'stale-codex-sid' });

      expect(result.content).toBe('codex fresh result');
      expect(mockDispatch).toHaveBeenCalledTimes(2);
      expect(mockDispatch.mock.calls[1][0].resumeProviderSessionId).toBeUndefined();
    });

    it('retries fresh regardless of TTY state', async () => {
      const originalIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

      const service = new StageAgentService(createAnthropicAgentConfigService());
      const mockDispatch = jest.fn()
        .mockRejectedValueOnce(new Error('session_id not found'))
        .mockResolvedValueOnce({ content: 'non-tty fresh result', sessionId: 'new-sid' });
      (service as unknown as { dispatchToBackend: jest.Mock }).dispatchToBackend = mockDispatch;
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await (service as unknown as {
        runStagePrompt: (params: StagePromptParams) => Promise<{ content: string; sessionId?: string }>;
      }).runStagePrompt({ stage: 'plan', prompt: 'test', systemPrompt: 'sys', resumeProviderSessionId: 'stale-sid' });

      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });

      expect(result.content).toBe('non-tty fresh result');
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    it('throws ExecutionError without looping when retry also fails with stale-resume error', async () => {
      const service = new StageAgentService(createAnthropicAgentConfigService());
      const mockDispatch = jest.fn()
        .mockRejectedValueOnce(new Error('session_id not found'))
        .mockRejectedValueOnce(new Error('invalid session ID on retry'));
      (service as unknown as { dispatchToBackend: jest.Mock }).dispatchToBackend = mockDispatch;
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        (service as unknown as {
          runStagePrompt: (params: StagePromptParams) => Promise<{ content: string; sessionId?: string }>;
        }).runStagePrompt({ stage: 'plan', prompt: 'test', systemPrompt: 'sys', resumeProviderSessionId: 'stale-sid' })
      ).rejects.toBeInstanceOf(ExecutionError);
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    it('does not retry when error is not a resume-continuity problem', async () => {
      const service = new StageAgentService(createAnthropicAgentConfigService());
      const mockDispatch = jest.fn().mockRejectedValue(new Error('network timeout'));
      (service as unknown as { dispatchToBackend: jest.Mock }).dispatchToBackend = mockDispatch;

      await expect(
        (service as unknown as {
          runStagePrompt: (params: StagePromptParams) => Promise<{ content: string; sessionId?: string }>;
        }).runStagePrompt({ stage: 'plan', prompt: 'test', systemPrompt: 'sys', resumeProviderSessionId: 'sid' })
      ).rejects.toThrow('network timeout');
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('JSON validation gate', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    type CliPassResultLike = {
      result: string;
      source: 'structured_output' | 'result' | 'assistant_text' | undefined;
      hadContent: boolean;
      diagnostics: string[];
      sessionId: string | undefined;
      stopReason: string | undefined;
    };

    type FinalizeCliPass = (
      passResult: CliPassResultLike,
      stage: string,
      passNumber: number,
      sessionId?: string
    ) => { content: string; sessionId?: string } | undefined;

    const createClaudeCliPlanConfigService = (): ConfigService =>
      ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.plan.backend': 'cli',
            'stages.plan.provider': 'anthropic',
            'stages.plan.model': 'claude-sonnet-4-6',
            'ai.provider': 'anthropic',
            'ai.model': 'claude-sonnet-4-6',
          };
          return key in values ? values[key] : defaultValue;
        }),
      }) as unknown as ConfigService;

    it('review stage CLI call passes a jsonSchema for structured output', async () => {
      buildCliArgs.mockClear();
      spawnCli
        .mockImplementationOnce(async function* () {
          yield {
            type: 'result',
            subtype: 'success',
            result: JSON.stringify({
              summary: 'Looks good overall',
              issues: [],
              suggestions: [],
              approved: true,
            }),
            session_id: 'claude-review-session-99',
          };
        })
        .mockImplementationOnce(async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Approved.' }] },
          };
        });

      const service = new StageAgentService(createClaudeCliReviewConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await service.reviewCode('diff --git a/f b/f', [], '/tmp/repo');

      const mainCallArgs = buildCliArgs.mock.calls[0];
      expect((mainCallArgs[0] as Record<string, unknown>).jsonSchema).toBeDefined();
    });

    it('tryFinalizeCliPass accepts valid JSON result on plan stage', () => {
      const service = new StageAgentService(createClaudeCliPlanConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      const passResult: CliPassResultLike = {
        result: JSON.stringify({ summary: 'test', steps: [] }),
        source: 'result',
        hadContent: true,
        diagnostics: [],
        sessionId: undefined,
        stopReason: 'end_turn',
      };

      const finalize = (service as unknown as { tryFinalizeCliPass: FinalizeCliPass }).tryFinalizeCliPass;

      const result = finalize.call(service, passResult, 'plan', 1);
      expect(result).toBeDefined();
      expect(result?.content).toContain('"summary"');
    });
  });

  it('forwards onProgress callback to runStagePrompt when reviewing code', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Looks good',
        issues: [],
        suggestions: [],
        approved: true,
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    const onProgress = jest.fn();
    await service.reviewCode('diff --git a/f b/f', [], undefined, undefined, undefined, onProgress);

    expect(mockRunStagePrompt).toHaveBeenCalledWith(expect.objectContaining({ onProgress }));

    jest.restoreAllMocks();
  });

  describe('enrichPlanWithDirectoryConfigs', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('appends discovered config paths to plan.affectedFilesContext', () => {
      const config = createConfigService();
      const service = new StageAgentService(config);
      const plan: any = {
        summary: 'test',
        steps: [],
        estimatedComplexity: 'low',
        affectedFiles: [{ filePath: 'wf/src/agents/planner.ts', status: 'found' }],
        affectedRepositories: ['wf'],
        affectedFilesContext: [],
      };
      mockDiscoverDirAgentConfigs.mockReturnValue([
        { filePath: 'wf/src/agents/CLAUDE.md', status: 'found' },
      ]);

      service.enrichPlanWithDirectoryConfigs(plan, '/repos/wf');

      expect(plan.affectedFilesContext).toContainEqual({
        filePath: 'wf/src/agents/CLAUDE.md',
        status: 'found',
      });
    });

    it('does not duplicate paths already in affectedFilesContext', () => {
      const config = createConfigService();
      const service = new StageAgentService(config);
      const existing = { filePath: 'wf/src/agents/CLAUDE.md', status: 'found' as const };
      const plan: any = {
        summary: 'test',
        steps: [],
        estimatedComplexity: 'low',
        affectedFiles: [{ filePath: 'wf/src/agents/planner.ts', status: 'found' }],
        affectedRepositories: ['wf'],
        affectedFilesContext: [existing],
      };
      mockDiscoverDirAgentConfigs.mockReturnValue([existing]);

      service.enrichPlanWithDirectoryConfigs(plan, '/repos/wf');

      const matches = plan.affectedFilesContext.filter(
        (e: any) => e.filePath === 'wf/src/agents/CLAUDE.md',
      );
      expect(matches).toHaveLength(1);
    });

    it('uses implement stage provider from config for filename resolution', () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'stages.implement.provider' ? 'openai' : undefined,
        ),
      } as unknown as ConfigService;
      const service = new StageAgentService(config);
      const plan: any = {
        summary: 'test',
        steps: [],
        estimatedComplexity: 'low',
        affectedFiles: [{ filePath: 'wf/src/commands/plan.ts', status: 'found' }],
        affectedRepositories: ['wf'],
        affectedFilesContext: [],
      };
      mockDiscoverDirAgentConfigs.mockReturnValue([]);

      service.enrichPlanWithDirectoryConfigs(plan, '/repos/wf');

      expect(mockDiscoverDirAgentConfigs).toHaveBeenCalledWith(
        expect.any(Array),
        'openai',
        expect.any(String),
      );
    });

    it('is a no-op when no config files are found', () => {
      const config = createConfigService();
      const service = new StageAgentService(config);
      const plan: any = {
        summary: 'test',
        steps: [],
        estimatedComplexity: 'low',
        affectedFiles: [],
        affectedRepositories: ['wf'],
        affectedFilesContext: [{ filePath: 'wf/package.json', status: 'found' }],
      };
      mockDiscoverDirAgentConfigs.mockReturnValue([]);

      service.enrichPlanWithDirectoryConfigs(plan, '/repos/wf');

      expect(plan.affectedFilesContext).toHaveLength(1);
    });

    it('initializes affectedFilesContext as [] when originally undefined', () => {
      const config = createConfigService();
      const service = new StageAgentService(config);
      const plan: any = {
        summary: 'test',
        steps: [],
        estimatedComplexity: 'low',
        affectedFiles: [{ filePath: 'wf/src/agents/planner.ts', status: 'found' }],
        affectedRepositories: ['wf'],
        affectedFilesContext: undefined,
      };
      mockDiscoverDirAgentConfigs.mockReturnValue([
        { filePath: 'wf/src/agents/CLAUDE.md', status: 'found' },
      ]);

      service.enrichPlanWithDirectoryConfigs(plan, '/repos/wf');

      expect(plan.affectedFilesContext).toEqual([
        { filePath: 'wf/src/agents/CLAUDE.md', status: 'found' },
      ]);
    });
  });
});
