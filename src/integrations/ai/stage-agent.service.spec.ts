import { ConfigService } from '@nestjs/config';
import { StageAgentService } from './stage-agent.service';

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

  it('raises an AIError with provider metadata when the plan response is blank', async () => {
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

  it('raises an AIError with provider metadata when generated content is blank', async () => {
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

  it('raises an AIError with provider metadata when an OpenAI chat turn is blank', async () => {
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
        prompt: expect.stringContaining('A step that says only "rename X" without the target'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'Verification commands MUST be shell-safe by construction. For inline `node -e`, prefer'
        ),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'When a step introduces an interface field typed with `| null` or `.nullable()`,'
        ),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Generated-doc workflows (e.g., auto-generated README sections, API docs from'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Mock isolation: always prescribe'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('testing-module'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('process.exit'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('help/doc text drift'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('verification of both working-tree and staged/index state'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('explicitly mark it as incomplete with a reason'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('strongest viable positive assertion'),
      })
    );
    expect(mockRunStagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Silent error swallowing without coverage is a latent bug'),
      })
    );
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

  it('places the JSON minification instruction after the plan example block', async () => {
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

    expect(prompt).toContain('  }\n}\n\nIMPORTANT: Minify the JSON — no unnecessary whitespace or newlines.');
    expect(prompt).not.toContain('  }\nIMPORTANT: Minify the JSON — no unnecessary whitespace or newlines.\n}');
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

    it('throws AIError when CLI result has stop_reason max_tokens', async () => {
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

      expect(onProgress).toHaveBeenCalledWith('[codex-cli] Session started: tid-123');
      expect(onProgress).toHaveBeenCalledWith('[codex-cli] Running: yarn build');
      expect(onProgress).toHaveBeenCalledWith('[codex-cli] Command completed: yarn build');
      expect(onProgress).toHaveBeenCalledWith('[codex-cli] Agent: final chunk');
      expect(onProgress.mock.calls.some(call => String(call[0]).startsWith('  [codex-cli]'))).toBe(false);

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

    expect(prompt).toContain(
      '  "approved": true\n}\n\nIMPORTANT: Minify the JSON — no unnecessary whitespace or newlines.'
    );
    expect(prompt).not.toContain(
      '  "approved": true\nIMPORTANT: Minify the JSON — no unnecessary whitespace or newlines.\n}'
    );
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

    it('throws AIError when LLM response is missing suggestions field', async () => {
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

    it('throws AIError containing "without returning a result" when no agent_message events are emitted', async () => {
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

    it('throws AIError when Codex agent_message is truncated', async () => {
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
            'You are an expert code reviewer providing constructive feedback.\n'
            + 'You may inspect repository files with read-only tools before answering.\n'
            + 'Focus on code quality, bugs, security, and the changed execution path.\n'
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

  describe('parseStagePlanResponse fallback — sessionId preserved in AIError', () => {
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

    it('includes sessionId in the thrown AIError when plan parsing fails', async () => {
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

    it('review stage CLI call does not pass a jsonSchema', async () => {
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
      expect((mainCallArgs[0] as Record<string, unknown>).jsonSchema).toBeUndefined();
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
});
