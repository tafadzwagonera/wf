import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { buildAnthropicBaseOptions, StageAgentService, buildSanitisedJsonSchema, extractCliResultContent } from './stage-agent.service';
import { AiProviderError, ExecutionError } from '../../shared/utils/errors';
import { discoverDirAgentConfigs } from './adapters/discover-dir-agent-configs';
import { batchSummarySchema } from '../../shared/schemas/batch-summary.schema';
import * as logFileWriter from '../../shared/logger/log-file-writer';

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
const { buildCodexCliArgs }: { buildCodexCliArgs: jest.Mock } = jest.requireMock('./adapters/codex-cli-runner');
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

jest.mock('./adapters/load-anthropic-agent-sdk', () => ({
  loadAnthropicAgentSdk: jest.fn(),
}));
const { loadAnthropicAgentSdk: mockLoadAnthropicAgentSdk }: { loadAnthropicAgentSdk: jest.Mock } = jest.requireMock('./adapters/load-anthropic-agent-sdk');

describe('StageAgentService', () => {
  it('normalizes Claude structured output before shared response parsing', () => {
    expect(extractCliResultContent({ type: 'result', structured_output: { value: 'ok' } })).toEqual({
      result: '{"value":"ok"}', source: 'structured_output',
    });
  });

  it('propagates structured output to Anthropic Agent SDK options', () => {
    const options = buildAnthropicBaseOptions({
      apiKey: 'key', model: 'claude-sonnet-4-6', prompt: 'prompt', systemPrompt: 'sys',
      anthropicContext: '', structuredOutput: { name: 'example', schema: { type: 'object' } },
    }, 'sys');
    expect(options.outputFormat).toEqual({
      type: 'json_schema', name: 'example', schema: { type: 'object' }, strict: true,
    });
  });

  it('normalizes deterministic OpenAI Agent SDK structured output', async () => {
    const service = new StageAgentService(createConfigService());
    const build = (service as unknown as {
      buildOpenAiStageAgent: (options: Record<string, unknown>) => Promise<{
        agent: { outputType: unknown; modelSettings: { temperature?: number } };
      }>;
    }).buildOpenAiStageAgent;
    const result = await build.call(service, {
      stage: 'plan', systemPrompt: 'sys', apiKey: 'key',
      structuredOutput: {
        name: 'example',
        schema: {
          $schema: 'schema',
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      },
    });
    expect(result.agent.outputType).toEqual({
      type: 'json_schema',
      name: 'example',
      schema: {
        type: 'object',
        properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
        required: ['value'],
      },
      strict: true,
    });
    expect(result.agent.modelSettings.temperature).toBe(0);
  });

  it('throws config error when OpenAI Agent SDK receives array-root schema', async () => {
    const service = new StageAgentService(createConfigService());
    const build = (service as unknown as {
      buildOpenAiStageAgent: (options: Record<string, unknown>) => Promise<void>;
    }).buildOpenAiStageAgent;

    await expect(
      build.call(service, {
        stage: 'plan',
        systemPrompt: 'sys',
        apiKey: 'key',
        structuredOutput: { name: 'example', schema: [] as unknown as Record<string, unknown> },
      })
    ).rejects.toMatchObject({ category: 'config' });
  });

  it('normalizes structuredOutput schema in Codex stage by stripping $schema', () => {
    const service = new StageAgentService(createCodexConfigService());
    const resolveCodexStageJsonSchema = (service as unknown as {
      resolveCodexStageJsonSchema: (params: Record<string, unknown>) => string | undefined;
    }).resolveCodexStageJsonSchema;

    const result = resolveCodexStageJsonSchema.call(service, {
      stage: 'plan',
      structuredOutput: {
        name: 'example',
        schema: { $schema: 'schema', type: 'object', properties: { x: { type: 'string' } } },
      },
    });

    expect(result).toBeDefined();
    expect(JSON.parse(result as string)).toEqual({
      type: 'object',
      properties: { x: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['x'],
    });
  });

  it('throws config error when Codex stage receives array-root schema', () => {
    const service = new StageAgentService(createCodexConfigService());
    const resolveCodexStageJsonSchema = (service as unknown as {
      resolveCodexStageJsonSchema: (params: Record<string, unknown>) => string | undefined;
    }).resolveCodexStageJsonSchema;

    expect(() =>
      resolveCodexStageJsonSchema.call(service, {
        stage: 'plan',
        structuredOutput: { schema: [] as unknown as Record<string, unknown> },
      })
    ).toThrow(expect.objectContaining({ category: 'config' }));
  });

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

  const createCodexImplementConfigService = (): ConfigService =>
    ({
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          'stages.implement.backend': 'cli',
          'stages.implement.provider': 'openai',
          'stages.implement.model': 'gpt-5.6-luna',
          'ai.provider': 'openai',
          'ai.model': 'gpt-5.6-luna',
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
          'shell-safe'
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
        prompt: expect.stringContaining('Keep mock setup concrete'),
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

  it('lists captured Figma links and defers exact values to the figma skills', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix', summary: 'Fix it', steps: ['step 1'],
        estimatedComplexity: 'low', affectedFiles: [], risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Style the card',
      figmaLinks: ['https://figma.com/design/abc123/Card'],
    });

    const prompt = mockRunStagePrompt.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('Figma reference(s) captured for this ticket:');
    expect(prompt).toContain('https://figma.com/design/abc123/Card');
    expect(prompt).toContain('Do not write any plan step that fetches Figma data');
  });

  it('warns when no Figma link was captured for a repo with a detected design system', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix', summary: 'Fix it', steps: ['step 1'],
        estimatedComplexity: 'low', affectedFiles: [], risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Style the card',
      conventions: {
        language: 'typescript',
        namingPattern: 'kebab-case',
        importStyle: 'esm',
        folderStructure: [],
        keyDependencies: [],
        errorHandlingPaths: [],
        gitHooks: [],
        designSystem: {
          framework: 'vue', componentLibrary: 'nuxt-ui', interactionPatterns: [],
        },
      } as any,
    });

    const prompt = mockRunStagePrompt.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('No Figma reference was found for this ticket.');
  });

  it('omits the Figma section entirely when there are no links and no detected design system', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix', summary: 'Fix it', steps: ['step 1'],
        estimatedComplexity: 'low', affectedFiles: [], risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({ action: 'fix', issueContent: 'Fix a backend timeout' });

    const prompt = mockRunStagePrompt.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).not.toContain('Figma reference');
  });

  it('omits Design system section for a non-UI-relevant ticket even when conventions include a design system', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix', summary: 'Fix it', steps: ['step 1'],
        estimatedComplexity: 'low', affectedFiles: [], risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix a database connection timeout in the auth service',
      conventions: {
        language: 'typescript',
        namingPattern: 'kebab-case',
        importStyle: 'esm',
        folderStructure: [],
        keyDependencies: ['nuxt-ui'],
        errorHandlingPaths: [],
        gitHooks: [],
        designSystem: { framework: 'vue', componentLibrary: 'nuxt-ui', interactionPatterns: [] },
      } as any,
    });

    const prompt = mockRunStagePrompt.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).not.toContain('Design system:');
    expect(prompt).not.toContain('- Known UI interaction patterns');
  });

  it('includes Design system section for a UI-relevant ticket when conventions include a design system', async () => {
    const service = new StageAgentService(createConfigService());
    const mockRunStagePrompt = jest.fn().mockResolvedValue({
      content: JSON.stringify({
        action: 'fix', summary: 'Fix it', steps: ['step 1'],
        estimatedComplexity: 'low', affectedFiles: [], risks: [],
      }),
    });
    (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix the card component layout on mobile',
      conventions: {
        language: 'typescript',
        namingPattern: 'kebab-case',
        importStyle: 'esm',
        folderStructure: [],
        keyDependencies: ['nuxt-ui'],
        errorHandlingPaths: [],
        gitHooks: [],
        designSystem: { framework: 'vue', componentLibrary: 'nuxt-ui', interactionPatterns: [] },
      } as any,
    });

    const prompt = mockRunStagePrompt.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('Design system:');
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
      const validResult = JSON.stringify({ action: 'fix', summary: 'Test', steps: ['Step 1'], estimatedComplexity: 'low' });
      async function* fakeSpawn() {
        yield { type: 'result', subtype: 'success', result: validResult, session_id: sessionId };
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
      const validResult = JSON.stringify({ action: 'fix', summary: 'Test', steps: ['Step 1'], estimatedComplexity: 'low' });
      async function* fakeSpawn() {
        yield { type: 'result', subtype: 'success', result: validResult };
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
      const validResult = JSON.stringify({ action: 'fix', summary: 'Test', steps: ['Step 1'], estimatedComplexity: 'low' });
      async function* firstPass() {
        yield { type: 'assistant', message: { content: [] }, session_id: 'sess_abc123' };
      }
      async function* secondPass() {
        yield { type: 'result', subtype: 'success', result: validResult, session_id: 'sess_abc123' };
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
            'Your previous response did not include a usable result. Please output ONLY a valid JSON object matching the JSON schema provided in the original instructions. Do not include commentary or markdown — IMPORTANT: raw, minified JSON only (no unnecessary whitespace or newlines). JSON string values must not contain literal newline characters — use \\n for line breaks within strings.',
          sessionId: 'sess_abc123',
        })
      );

      logSpy.mockRestore();
    });

    it('rejects assistant_text and retries without terminal noise', async () => {
      const validResult = JSON.stringify({ action: 'fix', summary: 'Test', steps: ['Step 1'], estimatedComplexity: 'low' });
      async function* firstPass() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me think about this...' }] }, session_id: 'sess_abc123' };
      }
      async function* secondPass() {
        yield { type: 'result', subtype: 'success', result: validResult, session_id: 'sess_abc123' };
      }
      spawnCli.mockImplementationOnce(firstPass).mockImplementationOnce(secondPass);

      const service = new StageAgentService(createCliConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      expect(result).toMatchObject({ content: validResult });
      const demotedLogs = logSpy.mock.calls.filter(call => String(call[0]).includes('assistant_text demoted'));
      expect(demotedLogs).toHaveLength(0);
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

    it('records each unusable pass and the stall to the log file', async () => {
      const logFileWriter = require('../../shared/logger/log-file-writer');
      const appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);

      async function* pass() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking...' }] }, session_id: 'sess_log_1' };
      }
      spawnCli.mockImplementationOnce(pass).mockImplementationOnce(pass);

      const service = new StageAgentService(createCliConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      await expect(runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' })).rejects.toThrow();

      const lines = appendSpy.mock.calls.map(call => String(call[1]));
      const passLines = lines.filter(line => line.startsWith('cli.pass_unusable'));
      expect(passLines.length).toBeGreaterThanOrEqual(1);
      expect(passLines[0]).toContain('source=assistant_text');
      expect(passLines[0]).toContain('pass=1');

      const stallLine = lines.find(line => line.startsWith('cli.stall'));
      expect(stallLine).toContain('workload not decreasing');
      expect(stallLine).not.toContain('\n');

      appendSpy.mockRestore();
    });

    it('classifies a rate-limited stall as rate-limit and logs cli.rate_limited', async () => {
      const logFileWriter = require('../../shared/logger/log-file-writer');
      const appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);

      async function* pass() {
        yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' }, session_id: 'sess_rl' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'waiting for limit reset...' }] }, session_id: 'sess_rl' };
      }
      spawnCli.mockImplementationOnce(pass).mockImplementationOnce(pass);

      const service = new StageAgentService(createCliConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      await expect(runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' })).rejects.toMatchObject({
        category: 'rate-limit',
        message: expect.stringContaining('hit a rate or usage limit'),
      });

      const lines = appendSpy.mock.calls.map(call => String(call[1]));
      expect(lines.find(line => line.startsWith('cli.rate_limited'))).toBeDefined();
      expect(lines.find(line => line.startsWith('cli.stall'))).toBeUndefined();

      appendSpy.mockRestore();
    });

    it('stall error carries pass count and diagnostics in details', async () => {
      async function* pass() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking...' }] }, session_id: 'sess_detail' };
      }
      spawnCli.mockImplementationOnce(pass).mockImplementationOnce(pass);

      const service = new StageAgentService(createCliConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      try {
        await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });
        throw new Error('should not reach');
      } catch (error: unknown) {
        expect((error as any).details?.passes).toBe(2);
        expect((error as any).details?.sessionId).toBe('sess_detail');
      }
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

    it('review-stage stall error includes sessionId from the latest pass', async () => {
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
      const validStructuredOutput = { action: 'fix', summary: 'Test', steps: ['Step 1'], estimatedComplexity: 'low' };
      async function* fakeSpawn() {
        yield { type: 'result', subtype: 'success', structured_output: validStructuredOutput, session_id: 'sess_abc123' };
      }
      spawnCli.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCliConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      expect(result).toMatchObject({ content: JSON.stringify(validStructuredOutput) });
      expect(spawnCli).toHaveBeenCalledTimes(1);

      logSpy.mockRestore();
    });

    it('accepts result on pass 1 without retry', async () => {
      const validResult = JSON.stringify({ action: 'fix', summary: 'Test', steps: ['Step 1'], estimatedComplexity: 'low' });
      async function* fakeSpawn() {
        yield { type: 'result', subtype: 'success', result: validResult, session_id: 'sess_abc123' };
      }
      spawnCli.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCliConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      expect(result).toMatchObject({ content: validResult });
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
      const validTicket = JSON.stringify({
        title: 'Fix login timeout',
        type: 'bug',
        priority: 'high',
        description: 'The session expires prematurely.',
      });
      async function* fakeSpawn() {
        yield { type: 'thread.started', thread_id: 'tid-123' };
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'first chunk' } };
        yield { type: 'item.completed', item: { type: 'agent_message', text: validTicket } };
      }
      spawnCodex.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCodexConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCodexCliStagePrompt.bind(service);
      const result = await runner({ stage: 'generate', prompt: 'test', systemPrompt: 'sys' });

      expect(result).toMatchObject({ content: validTicket });
      expect(logSpy.mock.calls.map(call => String(call[0])).join('\n')).toContain('agent_message chunks');
      logSpy.mockRestore();
    });

    it('emits Codex progress lines without extra indentation', async () => {
      const validTicket = JSON.stringify({
        title: 'Fix login timeout',
        type: 'bug',
        priority: 'high',
        description: 'The session expires prematurely.',
      });
      async function* fakeSpawn() {
        yield { type: 'thread.started', thread_id: 'tid-123' };
        yield { type: 'item.started', item: { type: 'command_execution', command: 'yarn build' } };
        yield { type: 'item.completed', item: { type: 'command_execution', command: 'yarn build', exit_code: 0 } };
        yield { type: 'item.completed', item: { type: 'agent_message', text: validTicket } };
      }
      spawnCodex.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCodexConfigService());
      const onProgress = jest.fn();
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCodexCliStagePrompt.bind(service);
      await runner({ stage: 'generate', prompt: 'test', systemPrompt: 'sys', onProgress });

      expect(onProgress).toHaveBeenCalledWith('  [codex-cli] Session started: tid-123');
      expect(onProgress).toHaveBeenCalledWith('  [codex-cli] Running: yarn build');
      expect(onProgress).toHaveBeenCalledWith('  [codex-cli] Command completed: yarn build');
      expect(onProgress).toHaveBeenCalledWith(`  [codex-cli] Agent: ${validTicket}`);
      expect(onProgress).toHaveBeenCalledWith(expect.stringMatching(/^\s+\[codex-cli\]/));

      logSpy.mockRestore();
    });

    it('does not throw when stop_reason is absent', async () => {
      const validResult = JSON.stringify({ action: 'fix', summary: 'Test', steps: ['Step 1'], estimatedComplexity: 'low' });
      async function* fakeSpawn() {
        yield { type: 'result', result: validResult };
      }
      spawnCli.mockReturnValue(fakeSpawn());

      const service = new StageAgentService(createCliConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });
      expect(result).toMatchObject({ content: validResult });
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

    it('resumes session on review retry instead of starting fresh', async () => {
      const validReview = JSON.stringify({ summary: 'ok', issues: [], suggestions: [], approved: true });
      async function* firstPass() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Let me think...' }] },
          session_id: 'sess_abc',
        };
      }
      async function* secondPass() {
        yield { type: 'result', subtype: 'success', result: validReview, session_id: 'sess_abc' };
      }
      spawnCli
        .mockImplementationOnce(firstPass)
        .mockImplementationOnce(secondPass);

      const service = new StageAgentService(createClaudeCliReviewConfigService());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'review', prompt: 'original review prompt', systemPrompt: 'sys' });

      expect(buildCliArgs).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          sessionId: 'sess_abc',
        })
      );
      expect(result).toMatchObject({ content: validReview, sessionId: 'sess_abc' });

      logSpy.mockRestore();
    });

    it('still resumes session on non-review stage retry', async () => {
      const validResult = JSON.stringify({ action: 'fix', summary: 'Test', steps: ['Step 1'], estimatedComplexity: 'low' });
      async function* firstPass() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Let me think...' }] },
          session_id: 'sess_abc',
        };
      }
      async function* secondPass() {
        yield { type: 'result', subtype: 'success', result: validResult, session_id: 'sess_abc' };
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
            'Your previous response did not include a usable result. Please output ONLY a valid JSON object matching the JSON schema provided in the original instructions. Do not include commentary or markdown — IMPORTANT: raw, minified JSON only (no unnecessary whitespace or newlines). JSON string values must not contain literal newline characters — use \\n for line breaks within strings.',
          sessionId: 'sess_abc',
        })
      );
      expect(result).toMatchObject({ content: validResult });

      logSpy.mockRestore();
    });

    it('throws stall error after 2 review retry attempts', async () => {
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
      spawnCli
        .mockImplementationOnce(async function* () {
          yield { type: 'result', subtype: 'success', result: 'not valid json', session_id: 'sess_review_789' };
        })
        .mockImplementationOnce(async function* () {
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
        expect((error as any).message).toContain('Failed to parse code review from agent response');
        expect((error as any).message).not.toContain('resolution plan');
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

    it('surfaces a Codex error event instead of reporting a missing result', async () => {
      spawnCodex.mockImplementation(makeCodexStream(
        { type: 'thread.started', thread_id: 'tid-123' },
        { type: 'error', subtype: 'context_window_exceeded', is_error: true, result: 'context window exceeded' }
      ));

      const service = new StageAgentService(createCodexConfigService());

      await expect(
        service.generatePlan({
          action: 'fix',
          issueContent: 'Test issue',
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining('context window exceeded'),
      });
    });

    it('surfaces the provider message from a Codex error event', async () => {
      spawnCodex.mockImplementation(makeCodexStream(
        {
          type: 'error',
          is_error: true,
          message: "The model 'gpt-5.5' may not exist or you may not have access to it",
        }
      ));

      const service = new StageAgentService(createCodexConfigService());

      await expect(
        service.generatePlan({ action: 'fix', issueContent: 'Test issue' })
      ).rejects.toMatchObject({
        message: expect.stringContaining('gpt-5.5'),
      });
    });

    it('classifies provider response-schema rejection as configuration error', async () => {
      spawnCodex.mockImplementation(makeCodexStream(
        { type: 'thread.started', thread_id: 'tid-123' },
        {
          type: 'error', is_error: true, result: JSON.stringify({
            error: { code: 'invalid_json_schema', message: 'propertyNames is not permitted' },
          }),
        }
      ));

      const service = new StageAgentService(createCodexConfigService());

      await expect(service.generatePlan({ action: 'fix', issueContent: 'Test issue' }))
        .rejects.toMatchObject({ category: 'config' });
    });

    it('classifies a no-progress abort as a stall error', async () => {
      spawnCodex.mockImplementation(makeCodexStream(
        { type: 'thread.started', thread_id: 'tid-123' },
        { type: 'error', subtype: 'no_progress', is_error: true, result: 'aborted as stalled' }
      ));

      const service = new StageAgentService(createCodexConfigService());

      await expect(service.generatePlan({ action: 'fix', issueContent: 'Test issue' }))
        .rejects.toMatchObject({ category: 'stall' });
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

    it('removes propertyNames from record schemas for strict Codex compatibility', () => {
      const json = JSON.parse(buildSanitisedJsonSchema({
        type: 'object',
        properties: {
          captured: {
            type: 'object',
            propertyNames: { type: 'string' },
            additionalProperties: {},
          },
        },
        additionalProperties: false,
      }) ?? '{}');

      expect(json.properties.captured).toEqual({
        anyOf: [{ type: 'object', additionalProperties: false }, { type: 'null' }],
      });
    });
  });

  describe('Codex schema retry loop', () => {
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

    const incidentShape = JSON.stringify({
      action: 'fix',
      summary: 'Test summary',
      phases: [{ name: 'Phase 1', steps: ['Step 1'], verificationCheckpoint: 'verify' }],
    });

    const validReviewJson = JSON.stringify({
      summary: 'Looks good',
      issues: [],
      suggestions: [],
      approved: true,
    });

    beforeEach(() => {
      spawnCodex.mockReset();
      buildCodexCliArgs.mockReset();
      buildCodexCliArgs.mockReturnValue([]);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('injects JSON Schema into the codex plan prompt', async () => {
      spawnCodex.mockImplementation(
        makeCodexStream(
          { type: 'thread.started', thread_id: 'tid-1' },
          { type: 'item.completed', item: { type: 'agent_message', text: validPlanJson } }
        )
      );

      const service = new StageAgentService(createCodexConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCodexCliStagePrompt.bind(service);
      await runner({ stage: 'plan', prompt: 'test', systemPrompt: 'sys' });

      const promptArg = spawnCodex.mock.calls[0][2] as string;
      expect(promptArg).toContain('Output contract');
      expect(promptArg).toContain('"stepIndices"');
      expect(promptArg).toContain('"phases"');

      expect(buildCodexCliArgs).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ outputSchemaPath: expect.any(String) }),
      );
      const schemaPath = (buildCodexCliArgs.mock.calls[0][0] as { outputSchemaPath: string }).outputSchemaPath;
      expect(existsSync(schemaPath)).toBe(false);
    });

    it('injects JSON Schema into the codex generate prompt and returns schema-valid ticket JSON on a single pass', async () => {
      const createCodexGenerateConfigService = (): ConfigService =>
        ({
          get: jest.fn((key: string, defaultValue?: unknown) => {
            const values: Record<string, unknown> = {
              'stages.generate.backend': 'cli',
              'stages.generate.provider': 'openai',
              'stages.generate.model': 'gpt-5.4-mini',
              'ai.provider': 'openai',
              'ai.model': 'gpt-5.4-mini',
            };
            return key in values ? values[key] : defaultValue;
          }),
        }) as unknown as ConfigService;

      const validTicket = JSON.stringify({
        title: 'Fix login timeout',
        type: 'bug',
        priority: 'high',
        description: 'The session expires prematurely.',
      });
      spawnCodex.mockImplementation(
        makeCodexStream({ type: 'item.completed', item: { type: 'agent_message', text: validTicket } })
      );

      const service = new StageAgentService(createCodexGenerateConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCodexCliStagePrompt.bind(service);
      const result = await runner({ stage: 'generate', prompt: 'write docs', systemPrompt: 'sys' });

      expect(spawnCodex).toHaveBeenCalledTimes(1);
      const promptArg = spawnCodex.mock.calls[0][2] as string;
      expect(promptArg).toContain('Output contract');
      expect(result.content).toBe(validTicket);
    });

    it('retries with the codex retry prompt when pass 1 emits a schema-invalid plan', async () => {
      spawnCodex
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'thread.started', thread_id: 'tid-1' },
            { type: 'item.completed', item: { type: 'agent_message', text: incidentShape } }
          )
        )
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'item.completed', item: { type: 'agent_message', text: validPlanJson } }
          )
        );

      const service = new StageAgentService(createCodexConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await service.generatePlan({ action: 'fix', issueContent: 'Test issue' });

      expect(spawnCodex).toHaveBeenCalledTimes(2);
      expect(buildCodexCliArgs).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ sessionId: 'tid-1', model: 'gpt-5.4-mini' })
      );
      const retryPrompt = spawnCodex.mock.calls[1][2] as string;
      expect(retryPrompt).toContain('did not validate');
      expect(retryPrompt).toContain("Field: 'steps'");
      expect(result.plan.summary).toBe('Test summary');
      expect(result.sessionId).toBe('tid-1');
    });

    it('rejects with a parse-category error when both codex passes emit schema-invalid content', async () => {
      spawnCodex
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'thread.started', thread_id: 'tid-1' },
            { type: 'item.completed', item: { type: 'agent_message', text: incidentShape } }
          )
        )
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'item.completed', item: { type: 'agent_message', text: incidentShape } }
          )
        );

      const service = new StageAgentService(createCodexConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        service.generatePlan({ action: 'fix', issueContent: 'Test issue' })
      ).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse resolution plan from agent response'),
        category: 'parse',
        details: expect.objectContaining({
          sessionId: 'tid-1',
          zodIssues: expect.stringContaining("Field: 'steps'"),
        }),
      });
    });

    it('does not retry when no thread sessionId was received', async () => {
      spawnCodex.mockImplementationOnce(
        makeCodexStream({ type: 'item.completed', item: { type: 'agent_message', text: incidentShape } })
      );

      const service = new StageAgentService(createCodexConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        service.generatePlan({ action: 'fix', issueContent: 'Test issue' })
      ).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse resolution plan from agent response'),
        category: 'parse',
      });
      expect(spawnCodex).toHaveBeenCalledTimes(1);
    });

    it('retries codex review schema miss and still sends epilogue as a third call', async () => {
      const wrongReview = JSON.stringify({ wrong: 'shape' });
      spawnCodex
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'thread.started', thread_id: 'review-tid-1' },
            { type: 'item.completed', item: { type: 'agent_message', text: wrongReview } }
          )
        )
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'item.completed', item: { type: 'agent_message', text: validReviewJson } }
          )
        )
        .mockImplementationOnce(
          makeCodexStream({ type: 'item.completed', item: { type: 'agent_message', text: 'Summary.' } })
        );

      const service = new StageAgentService(createCodexReviewConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await service.reviewCode('diff --git a/f b/f', []);

      expect(result.review.approved).toBe(true);
      expect(spawnCodex).toHaveBeenCalledTimes(3);

      const reviewPromptArg = spawnCodex.mock.calls[0][2] as string;
      expect(reviewPromptArg).toContain('Output contract');
    });

    it('rejects with a review-flavored parse message when both codex review passes emit schema-invalid content', async () => {
      const wrongReview = JSON.stringify({ wrong: 'shape' });
      spawnCodex
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'thread.started', thread_id: 'review-tid-2' },
            { type: 'item.completed', item: { type: 'agent_message', text: wrongReview } }
          )
        )
        .mockImplementationOnce(
          makeCodexStream({ type: 'item.completed', item: { type: 'agent_message', text: wrongReview } })
        );

      const service = new StageAgentService(createCodexReviewConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(service.reviewCode('diff --git a/f b/f', [])).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse code review from agent response'),
        category: 'parse',
      });
    });

    it('surfaces a clean parse error using pass 1 content when the retry pass itself throws (e.g. stale resume)', async () => {
      spawnCodex
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'thread.started', thread_id: 'tid-9' },
            { type: 'item.completed', item: { type: 'agent_message', text: incidentShape } }
          )
        )
        .mockImplementationOnce(async function* () {
          throw new Error('Codex CLI failed: thread not found');
          yield undefined;
        });

      const service = new StageAgentService(createCodexConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        service.generatePlan({ action: 'fix', issueContent: 'Test issue' })
      ).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse resolution plan from agent response'),
        category: 'parse',
        details: expect.objectContaining({
          response: incidentShape,
          sessionId: 'tid-9',
        }),
      });
      expect(spawnCodex).toHaveBeenCalledTimes(2);
    });

    it('propagates a stall error from the retry pass unretried instead of masking it as a parse failure', async () => {
      spawnCodex
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'thread.started', thread_id: 'tid-10' },
            { type: 'item.completed', item: { type: 'agent_message', text: incidentShape } }
          )
        )
        .mockImplementationOnce(makeCodexStream());

      const service = new StageAgentService(createCodexConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        service.generatePlan({ action: 'fix', issueContent: 'Test issue' })
      ).rejects.toMatchObject({
        message: expect.stringContaining('Codex CLI finished without returning a result'),
        category: 'stall',
      });
      expect(spawnCodex).toHaveBeenCalledTimes(2);
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
        expect.stringContaining('Summarize the review for the developer'),
        undefined,
        30000
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
        expect.stringContaining('Summarize the review for the developer'),
        undefined,
        30000,
        undefined,
        { wallClock: 'stages.review.epilogueTimeoutMs' }
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
          prompt: expect.stringContaining('Summarize the review for the developer'),
          appendSystemPrompt:
            'You are a code reviewer. Assess quality, correctness, and security using your judgment — flag what matters, skip noise.\n'
            + 'You may inspect repository files with read-only tools before answering.\n'
            + 'Ignore JSON or markdown files under .wf/ and tracker artifact directories.\n'
            + 'Return your response as a JSON object matching the CodeReview interface.',
          model: 'claude-sonnet-4-5-20250514',
          sessionId: 'claude-review-session-42',
          cwd: '/tmp/repo',
          permissionMode: 'plan',
          tools: ['Read', 'Glob', 'Grep', 'Bash', 'Skill'],
          jsonSchema: undefined,
          forkSession: true,
        })
      );
    });

    it('resumes the Codex session for the review epilogue without unsupported fork flag', async () => {
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

      await service.reviewCode('diff --git a/f b/f', []);

      const epilogueArgs = buildCodexCliArgs.mock.calls.at(-1)?.[0];
      expect(epilogueArgs).toEqual(expect.objectContaining({ sessionId: 'review-session-42' }));
      expect(epilogueArgs).not.toHaveProperty('forkSession');
    });

    it('reports epilogue failure instead of false success when the CLI yields an error message', async () => {
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
            type: 'result',
            subtype: 'error',
            is_error: true,
            result: 'timed out',
          })
        );
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const service = new StageAgentService(createClaudeCliReviewConfigService());

      await service.reviewCode('diff --git a/f b/f', []);

      expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Review epilogue sent'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Review epilogue failed'));
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

    it('includes the thrown error message as a reason in the epilogue failure log', async () => {
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
          throw new Error('network timeout on epilogue');
        });
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const service = new StageAgentService(createClaudeCliReviewConfigService());
      await service.reviewCode('diff --git a/f b/f', []);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('network timeout on epilogue'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Review epilogue failed'));
    });

    it('includes the CLI is_error result as a reason in the epilogue failure log', async () => {
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
            type: 'result',
            subtype: 'error',
            is_error: true,
            result: 'timed out',
          })
        );
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const service = new StageAgentService(createClaudeCliReviewConfigService());
      await service.reviewCode('diff --git a/f b/f', []);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('timed out'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Review epilogue failed'));
    });

    it('uses stages.review.epilogueTimeoutMs from config as the spawn timeout', async () => {
      const customTimeout = 45_000;
      spawnCodex
        .mockImplementationOnce(
          makeCodexStream(
            { type: 'thread.started', thread_id: 'review-session-99' },
            { type: 'item.completed', item: { type: 'agent_message', text: validReviewJson } }
          )
        )
        .mockImplementationOnce(
          makeCodexStream({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Epilogue text.' },
          })
        );

      const configService = {
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.review.backend': 'cli',
            'stages.review.provider': 'openai',
            'stages.review.model': 'gpt-4.1',
            'ai.provider': 'openai',
            'ai.model': 'gpt-4.1',
            'stages.review.epilogueTimeoutMs': customTimeout,
          };
          return key in values ? values[key] : defaultValue;
        }),
      } as unknown as ConfigService;

      const service = new StageAgentService(configService);
      await service.reviewCode('diff --git a/f b/f', []);

      expect(spawnCodex).toHaveBeenLastCalledWith(
        expect.any(Array),
        process.cwd(),
        expect.stringContaining('Summarize the review for the developer'),
        undefined,
        customTimeout
      );
    });

    it('uses stages.review.epilogueTimeoutMs from config as the Claude CLI epilogue spawn timeout', async () => {
      const customTimeout = 45_000;
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
            type: 'result',
            subtype: 'success',
            result: 'Epilogue text.',
          })
        );

      const configService = {
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.review.backend': 'cli',
            'stages.review.provider': 'anthropic',
            'stages.review.model': 'claude-sonnet-4-5-20250514',
            'ai.provider': 'anthropic',
            'ai.model': 'claude-sonnet-4-5-20250514',
            'stages.review.epilogueTimeoutMs': customTimeout,
          };
          return key in values ? values[key] : defaultValue;
        }),
      } as unknown as ConfigService;

      const service = new StageAgentService(configService);
      await service.reviewCode('diff --git a/f b/f', []);

      expect(spawnCli).toHaveBeenLastCalledWith(
        expect.any(Array),
        process.cwd(),
        expect.stringContaining('Summarize the review for the developer'),
        undefined,
        customTimeout,
        undefined,
        { wallClock: 'stages.review.epilogueTimeoutMs' }
      );
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

  describe('chatTurn with CLI backend', () => {
    const makeStream = (...messages: object[]) =>
      (async function* () {
        for (const message of messages) yield message;
      })();

    beforeEach(() => {
      spawnCli.mockReset();
      spawnCodex.mockReset();
      buildCliArgs.mockClear();
      buildCodexCliArgs.mockReset();
      buildCliArgs.mockReturnValue([]);
      buildCodexCliArgs.mockReturnValue([]);
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('routes OpenAI CLI chat turns through Codex with the configured implement model', async () => {
      spawnCodex.mockReturnValueOnce(makeStream(
        { type: 'thread.started', thread_id: 'codex-chat-1' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'assessed' } }
      ));
      const service = new StageAgentService(createCodexImplementConfigService());

      const result = await service.chatTurn({
        stage: 'implement', userMessage: 'Assess steps', systemPrompt: 'sys', repoDir: '/tmp/repo',
      });

      expect(result.content).toBe('assessed');
      expect(result.session).toMatchObject({ provider: 'openai', backend: 'cli', sessionId: 'codex-chat-1' });
      expect(buildCodexCliArgs).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.6-luna' }));
      expect(spawnCodex).toHaveBeenCalledTimes(1);
      expect(spawnCli).toHaveBeenCalledTimes(0);
    });

    it('writes a normalized structured-output schema for Codex chat turns', async () => {
      let writtenSchema: string | undefined;
      buildCodexCliArgs.mockImplementation(({ outputSchemaPath }: { outputSchemaPath?: string }) => {
        writtenSchema = outputSchemaPath
          ? require('node:fs').readFileSync(outputSchemaPath, 'utf8')
          : undefined;
        return [];
      });
      spawnCodex.mockReturnValueOnce(makeStream(
        { type: 'thread.started', thread_id: 'codex-structured-1' },
        { type: 'item.completed', item: { type: 'agent_message', text: '{"value":"ok"}' } }
      ));
      const service = new StageAgentService(createCodexImplementConfigService());

      await service.chatTurn({
        stage: 'implement', userMessage: 'Assess steps', systemPrompt: 'sys', repoDir: '/tmp/repo',
        structuredOutput: {
          name: 'example',
          schema: {
            $schema: 'schema',
            type: 'object',
            properties: { value: { type: 'string' } },
          },
        },
      });

      expect(buildCodexCliArgs).toHaveBeenCalledWith(expect.objectContaining({ outputSchemaPath: expect.any(String) }));
      expect(JSON.parse(writtenSchema ?? '{}')).toEqual({
        type: 'object',
        properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
        required: ['value'],
      });
    });

    it('does not apply the review schema to an unstructured Codex chat turn', async () => {
      spawnCodex.mockReturnValueOnce(makeStream(
        { type: 'thread.started', thread_id: 'codex-fidelity-1' },
        { type: 'item.completed', item: { type: 'agent_message', text: '{"findings":[]}' } }
      ));
      const service = new StageAgentService(createCodexReviewConfigService());

      const result = await service.chatTurn({
        stage: 'review', userMessage: 'Check the plan step', systemPrompt: 'Return fidelity findings', repoDir: '/tmp/repo',
      });

      expect(result.content).toBe('{"findings":[]}');
      expect(spawnCodex).toHaveBeenCalledTimes(1);
    });

    it('validates a custom review chat schema instead of the code review schema', async () => {
      const batchSummary = JSON.stringify({ summaries: [{ file: 'stamp.svg', summary: '- asset update' }] });
      spawnCodex.mockReturnValueOnce(makeStream(
        { type: 'thread.started', thread_id: 'codex-summary-1' },
        { type: 'item.completed', item: { type: 'agent_message', text: batchSummary } }
      ));
      const service = new StageAgentService(createCodexReviewConfigService());

      const result = await service.chatTurn({
        stage: 'review', userMessage: 'Summarise the file', systemPrompt: 'Return batch summaries', repoDir: '/tmp/repo',
        jsonSchema: '{"type":"object","properties":{"summaries":{"type":"array"}}}',
        responseValidator: {
          label: 'batch summary',
          parse: value => batchSummarySchema.parse(value),
        },
      });

      expect(JSON.parse(result.content)).toEqual({
        summaries: [{ file: 'stamp.svg', summary: '- asset update' }],
      });
      expect(spawnCodex).toHaveBeenCalledTimes(1);
    });

    it('completes a plain chat turn without forwarding a json schema', async () => {
      spawnCli.mockReturnValueOnce(makeStream({
        type: 'result', subtype: 'success', result: '- summary', session_id: 'chat-1',
      }));
      const service = new StageAgentService(createClaudeCliReviewConfigService());

      const result = await service.chatTurn({
        stage: 'review', userMessage: 'hello', systemPrompt: 'sys', repoDir: '/tmp/repo',
      });

      expect(result.content).toBe('- summary');
      expect(spawnCli).toHaveBeenCalledTimes(1);
      expect(buildCliArgs).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello', jsonSchema: undefined }));
    });

    it('forwards jsonSchema to buildCliArgs and returns structured output content', async () => {
      spawnCli.mockReturnValueOnce(makeStream({
        type: 'result', subtype: 'success',
        structured_output: { summaries: [{ file: 'a.ts', summary: '- x' }] },
        session_id: 'chat-2',
      }));
      const service = new StageAgentService(createClaudeCliReviewConfigService());

      const result = await service.chatTurn({
        stage: 'review', userMessage: 'File: a.ts', systemPrompt: 'sys', repoDir: '/tmp/repo',
        jsonSchema: '{"type":"object"}',
      });

      expect(buildCliArgs).toHaveBeenCalledWith(expect.objectContaining({ jsonSchema: '{"type":"object"}' }));
      expect(JSON.parse(result.content)).toEqual({ summaries: [{ file: 'a.ts', summary: '- x' }] });
    });

    it('converts structuredOutput metadata to the Claude CLI schema flag', async () => {
      spawnCli.mockReturnValueOnce(makeStream({
        type: 'result', subtype: 'success', structured_output: { value: 'ok' }, session_id: 'chat-structured',
      }));
      const service = new StageAgentService(createClaudeCliReviewConfigService());
      await service.chatTurn({
        stage: 'review', userMessage: 'hello', systemPrompt: 'sys', repoDir: '/tmp/repo',
        structuredOutput: { name: 'example', schema: { type: 'object' } },
      });
      expect(buildCliArgs).toHaveBeenCalledWith(expect.objectContaining({ jsonSchema: '{"type":"object"}' }));
    });

    it('retries with the schema retry prompt when a schema is set but structured output is missing', async () => {
      spawnCli
        .mockReturnValueOnce(makeStream({
          type: 'result', subtype: 'success', result: 'not json', session_id: 'chat-3',
        }))
        .mockReturnValueOnce(makeStream({
          type: 'result', subtype: 'success', structured_output: { summaries: [] }, session_id: 'chat-3',
        }));
      const service = new StageAgentService(createClaudeCliReviewConfigService());

      const result = await service.chatTurn({
        stage: 'review', userMessage: 'File: a.ts', systemPrompt: 'sys', repoDir: '/tmp/repo',
        jsonSchema: '{"type":"object"}',
      });

      expect(spawnCli).toHaveBeenCalledTimes(2);
      expect(buildCliArgs).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: 'chat-3',
        jsonSchema: '{"type":"object"}',
        prompt: expect.stringContaining('JSON object matching the JSON schema'),
      }));
      expect(JSON.parse(result.content)).toEqual({ summaries: [] });
    });

    it('does not validate a custom CLI schema against the built-in review schema', async () => {
      const validReview = JSON.stringify({ summary: 'review', issues: [], suggestions: [], approved: true });
      spawnCli
        .mockReturnValueOnce(makeStream({
          type: 'result', subtype: 'success', result: '{"summaries":[]}', session_id: 'chat-custom-schema',
        }))
        .mockReturnValueOnce(makeStream({
          type: 'result', subtype: 'success', result: validReview, session_id: 'chat-custom-schema',
        }));
      const service = new StageAgentService(createClaudeCliReviewConfigService());

      await expect(service.chatTurn({
        stage: 'review', userMessage: 'File: a.ts', systemPrompt: 'sys', repoDir: '/tmp/repo',
        jsonSchema: '{"type":"object","properties":{"summaries":{"type":"array"}}}',
      })).rejects.toThrow('Structured output was not returned');
    });

    it('exposes buildSanitisedJsonSchema stripping the $schema key', () => {
      const json = buildSanitisedJsonSchema({ $schema: 'x', type: 'object' });
      expect(json).toBe('{"type":"object"}');
    });

    it('normalises optional object properties for strict Codex schemas', () => {
      const json = JSON.parse(buildSanitisedJsonSchema({
        type: 'object',
        properties: { children: { type: 'array' } },
        additionalProperties: false,
      }) ?? '{}');

      expect(json.required).toEqual(['children']);
      expect(json.properties.children).toEqual({
        anyOf: [{ type: 'array' }, { type: 'null' }],
      });
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

  describe('parse error diagnostics', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('includes Zod issue details in the plan parse error when response is valid JSON but wrong shape', async () => {
      const wrongShapeResponse = JSON.stringify({
        action: 'fix',
        summary: 's',
        phases: [{ name: 'p', steps: ['a'], verificationCheckpoint: 'v' }],
      });
      const service = new StageAgentService(createConfigService());
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = jest.fn().mockResolvedValue({
        content: wrongShapeResponse,
        sessionId: 'sess_zod_test',
      });

      await expect(
        service.generatePlan({ action: 'fix', issueContent: 'Test' })
      ).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse resolution plan from agent response'),
        details: expect.objectContaining({
          zodIssues: expect.stringContaining("Field: 'steps'"),
        }),
      });
    });

    it('omits zodIssues from the plan parse error when response is not JSON', async () => {
      const service = new StageAgentService(createConfigService());
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = jest.fn().mockResolvedValue({
        content: 'this is plain prose, not JSON',
        sessionId: 'sess_syntax_test',
      });

      const error: unknown = await service.generatePlan({ action: 'fix', issueContent: 'Test' }).catch(e => e);
      expect((error as any).message).toContain('Failed to parse resolution plan from agent response');
      expect((error as any).details?.zodIssues).toBeUndefined();
    });

    it('includes Zod issue details in the review parse error when response is valid JSON but wrong shape', async () => {
      const wrongShapeResponse = JSON.stringify({ wrong: 'shape' });
      const service = new StageAgentService(createConfigService());
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = jest.fn().mockResolvedValue({
        content: wrongShapeResponse,
        sessionId: 'sess_review_zod_test',
      });

      await expect(
        service.reviewCode('diff --git a/f b/f', [])
      ).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse code review from agent response'),
        details: expect.objectContaining({
          zodIssues: expect.any(String),
        }),
      });
    });

    it('omits zodIssues from the review parse error when response is not JSON', async () => {
      const service = new StageAgentService(createConfigService());
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = jest.fn().mockResolvedValue({
        content: 'this is plain prose, not JSON',
        sessionId: 'sess_review_syntax_test',
      });

      const error: unknown = await service.reviewCode('diff --git a/f b/f', []).catch(e => e);
      expect((error as any).message).toContain('Failed to parse code review from agent response');
      expect((error as any).details?.zodIssues).toBeUndefined();
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
      const appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);

      const result = await (service as unknown as {
        runStagePrompt: (params: StagePromptParams) => Promise<{ content: string; sessionId?: string }>;
      }).runStagePrompt({ stage: 'plan', prompt: 'test', systemPrompt: 'sys', resumeProviderSessionId: 'stale-sid' });

      expect(result.content).toBe('fresh result');
      expect(mockDispatch).toHaveBeenCalledTimes(2);
      expect(mockDispatch.mock.calls[1][0].resumeProviderSessionId).toBeUndefined();
      const warnCalls = logSpy.mock.calls.filter(call => String(call[0]).includes('issue.session.resume-fallback'));
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      expect(appendSpy).toHaveBeenCalledWith(
        'WARN',
        expect.stringContaining('issue.session.resume-fallback stage=plan provider=anthropic backend=agent'),
        'stage-agent'
      );
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

      const error = await (async () => {
        try {
          await (service as unknown as {
            runStagePrompt: (params: StagePromptParams) => Promise<{ content: string; sessionId?: string }>;
          }).runStagePrompt({ stage: 'plan', prompt: 'test', systemPrompt: 'sys', resumeProviderSessionId: 'stale-sid' });
        } catch (caught) {
          return caught;
        }
        throw new Error('Expected resume fallback to fail');
      })();
      expect(error).toBeInstanceOf(ExecutionError);
      expect((error as ExecutionError).details).toEqual(expect.objectContaining({
        originalError: 'session_id not found',
        retryError: 'invalid session ID on retry',
      }));
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

    it('retries fresh when the CLI reports No conversation found with session ID', async () => {
      const service = new StageAgentService(createClaudeCliConfigService());
      const mockDispatch = jest.fn()
        .mockRejectedValueOnce(new Error('No conversation found with session ID: bb330ac9-691d-4df9-aec6-575029e72777'))
        .mockResolvedValueOnce({ content: 'fresh cli result', sessionId: 'new-sid' });
      (service as unknown as { dispatchToBackend: jest.Mock }).dispatchToBackend = mockDispatch;
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await (service as unknown as {
        runStagePrompt: (params: StagePromptParams) => Promise<{ content: string; sessionId?: string }>;
      }).runStagePrompt({
        stage: 'implement', prompt: 'test', systemPrompt: 'sys',
        resumeProviderSessionId: 'bb330ac9-691d-4df9-aec6-575029e72777',
      });

      expect(result.content).toBe('fresh cli result');
      expect(mockDispatch).toHaveBeenCalledTimes(2);
      expect(mockDispatch.mock.calls[1][0].resumeProviderSessionId).toBeUndefined();
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

    type CliPassOutcome
      = { kind: 'completed'; content: string; sessionId?: string }
        | { kind: 'schema-retry'; content: string; issues: string }
        | { kind: 'no-result' };

    type FinalizeCliPass = (
      passResult: CliPassResultLike,
      stage: string,
      passNumber: number,
      sessionId?: string,
      validate?: boolean
    ) => CliPassOutcome;

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

    it('review stage CLI call strips $schema from jsonSchema payload', async () => {
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
            session_id: 'claude-review-session-100',
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
      const jsonSchema = (mainCallArgs[0] as Record<string, unknown>).jsonSchema as string;
      expect(jsonSchema).toBeDefined();
      expect(jsonSchema).not.toContain('$schema');
    });

    it('tryFinalizeCliPass returns completed outcome for a schema-valid plan result', () => {
      const service = new StageAgentService(createClaudeCliPlanConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      const passResult: CliPassResultLike = {
        result: JSON.stringify({ action: 'fix', summary: 'test', steps: ['Step 1'], estimatedComplexity: 'low' }),
        source: 'result',
        hadContent: true,
        diagnostics: [],
        sessionId: undefined,
        stopReason: 'end_turn',
      };

      const finalize = (service as unknown as { tryFinalizeCliPass: FinalizeCliPass }).tryFinalizeCliPass;

      const outcome = finalize.call(service, passResult, 'plan', 1, undefined, true);
      expect(outcome.kind).toBe('completed');
      if (outcome.kind === 'completed') {
        expect(outcome.content).toContain('"summary"');
      }
    });

    it('tryFinalizeCliPass returns schema-retry outcome for a schema-invalid plan result', () => {
      const service = new StageAgentService(createClaudeCliPlanConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      const passResult: CliPassResultLike = {
        result: JSON.stringify({ action: 'fix' }),
        source: 'result',
        hadContent: true,
        diagnostics: [],
        sessionId: undefined,
        stopReason: 'end_turn',
      };

      const finalize = (service as unknown as { tryFinalizeCliPass: FinalizeCliPass }).tryFinalizeCliPass;

      const outcome = finalize.call(service, passResult, 'plan', 1, undefined, true);
      expect(outcome.kind).toBe('schema-retry');
      if (outcome.kind === 'schema-retry') {
        expect(outcome.issues).toContain("Field: 'steps'");
      }
    });

    it('tryFinalizeCliPass skips schema validation for structured_output source (Gate 2)', () => {
      const service = new StageAgentService(createClaudeCliPlanConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      const passResult: CliPassResultLike = {
        result: JSON.stringify({ action: 'fix' }),
        source: 'structured_output',
        hadContent: true,
        diagnostics: [],
        sessionId: undefined,
        stopReason: 'end_turn',
      };

      const finalize = (service as unknown as { tryFinalizeCliPass: FinalizeCliPass }).tryFinalizeCliPass;

      const outcome = finalize.call(service, passResult, 'plan', 1, undefined, true);
      expect(outcome.kind).toBe('completed');
    });
  });

  describe('Claude schema retry', () => {
    const createClaudeCliPlanSvc = (): ConfigService =>
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

    const createClaudeCliGenerateSvc = (): ConfigService =>
      ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.generate.backend': 'cli',
            'stages.generate.provider': 'anthropic',
            'stages.generate.model': 'claude-sonnet-4-6',
            'ai.provider': 'anthropic',
            'ai.model': 'claude-sonnet-4-6',
          };
          return key in values ? values[key] : defaultValue;
        }),
      }) as unknown as ConfigService;

    const validPlanResult = JSON.stringify({
      action: 'fix',
      summary: 'Retry success',
      steps: ['Step 1'],
      estimatedComplexity: 'low',
    });

    const schemaInvalidPlan = JSON.stringify({ action: 'fix', summary: 'bad' });

    beforeEach(() => {
      spawnCli.mockReset();
      buildCliArgs.mockReset();
      buildCliArgs.mockReturnValue([]);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('retries with the cliRetryPrompt when pass 1 emits a schema-invalid plan', async () => {
      spawnCli
        .mockImplementationOnce(async function* () {
          yield { type: 'result', subtype: 'success', result: schemaInvalidPlan, session_id: 'sess-s10' };
        })
        .mockImplementationOnce(async function* () {
          yield { type: 'result', subtype: 'success', result: validPlanResult, session_id: 'sess-s10' };
        });

      const service = new StageAgentService(createClaudeCliPlanSvc());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await service.generatePlan({ action: 'fix', issueContent: 'Issue content' });

      expect(spawnCli).toHaveBeenCalledTimes(2);
      expect(buildCliArgs).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ sessionId: 'sess-s10' })
      );
      const retryPromptArg = (buildCliArgs.mock.calls[1][0] as Record<string, unknown>).prompt as string;
      expect(retryPromptArg).toContain('JSON schema provided in the original instructions');
      expect(result.plan.summary).toBe('Retry success');
    });

    it('rejects with a parse-category error when both passes emit schema-invalid content', async () => {
      spawnCli
        .mockImplementationOnce(async function* () {
          yield { type: 'result', subtype: 'success', result: schemaInvalidPlan, session_id: 'sess-s11' };
        })
        .mockImplementationOnce(async function* () {
          yield { type: 'result', subtype: 'success', result: schemaInvalidPlan, session_id: 'sess-s11' };
        });

      const service = new StageAgentService(createClaudeCliPlanSvc());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        service.generatePlan({ action: 'fix', issueContent: 'Issue content' })
      ).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse resolution plan from agent response'),
        category: 'parse',
        details: expect.objectContaining({
          response: schemaInvalidPlan,
          sessionId: 'sess-s11',
        }),
      });
    });

    it('accepts a schema-valid plan wrapped in a markdown code fence without retrying', async () => {
      const fencedPlanResult = `\`\`\`json\n${validPlanResult}\n\`\`\``;
      spawnCli.mockImplementationOnce(async function* () {
        yield { type: 'result', subtype: 'success', result: fencedPlanResult, session_id: 'sess-s14' };
      });

      const service = new StageAgentService(createClaudeCliPlanSvc());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await service.generatePlan({ action: 'fix', issueContent: 'Issue content' });

      expect(spawnCli).toHaveBeenCalledTimes(1);
      expect(result.plan.summary).toBe('Retry success');
    });

    it('returns valid generate ticket JSON verbatim on a single pass without retrying (Gate 1)', async () => {
      const validTicket = JSON.stringify({
        title: 'Fix login timeout',
        type: 'bug',
        priority: 'high',
        description: 'The session expires prematurely.',
      });
      spawnCli.mockImplementationOnce(async function* () {
        yield { type: 'result', subtype: 'success', result: validTicket, session_id: 'sess-s12' };
      });

      const service = new StageAgentService(createClaudeCliGenerateSvc());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const runner = (service as any).runCliStagePrompt.bind(service);
      const result = await runner({ stage: 'generate', prompt: 'write docs', systemPrompt: 'sys' });

      expect(spawnCli).toHaveBeenCalledTimes(1);
      expect(result.content).toBe(validTicket);
    });

    it('accepts structured_output payload without re-validation (Gate 2)', async () => {
      const validStructuredOutput = { action: 'fix', summary: 'SO plan', steps: ['Step 1'], estimatedComplexity: 'low' };
      spawnCli.mockImplementationOnce(async function* () {
        yield { type: 'result', subtype: 'success', structured_output: validStructuredOutput, session_id: 'sess-s13' };
      });

      const service = new StageAgentService(createClaudeCliPlanSvc());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await service.generatePlan({ action: 'fix', issueContent: 'Issue content' });

      expect(spawnCli).toHaveBeenCalledTimes(1);
      expect(result.plan.summary).toBe('SO plan');
    });
  });

  describe('generate schema registration', () => {
    beforeEach(() => {
      spawnCli.mockReset();
      buildCliArgs.mockReset();
      buildCliArgs.mockReturnValue([]);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('resolveStageJsonSchema returns a non-empty string for the generate stage', () => {
      const service = new StageAgentService(createConfigService());
      const schema = (service as unknown as { resolveStageJsonSchema: (s: string) => string | undefined })
        .resolveStageJsonSchema('generate');
      expect(typeof schema).toBe('string');
      expect((schema as string).length).toBeGreaterThan(0);
    });

    it('rejects with a parse-category error whose message references "ticket" when both CLI passes emit schema-invalid content', async () => {
      const invalidContent = JSON.stringify({ title: 'T' });
      spawnCli
        .mockImplementationOnce(async function* () {
          yield { type: 'result', subtype: 'success', result: invalidContent, session_id: 'sess-gen-1' };
        })
        .mockImplementationOnce(async function* () {
          yield { type: 'result', subtype: 'success', result: invalidContent, session_id: 'sess-gen-1' };
        });

      const createClaudeCliGenerateConfigService = (): ConfigService =>
        ({
          get: jest.fn((key: string, defaultValue?: unknown) => {
            const values: Record<string, unknown> = {
              'stages.generate.backend': 'cli',
              'stages.generate.provider': 'anthropic',
              'stages.generate.model': 'claude-sonnet-4-6',
              'ai.provider': 'anthropic',
              'ai.model': 'claude-sonnet-4-6',
            };
            return key in values ? values[key] : defaultValue;
          }),
        }) as unknown as ConfigService;

      const service = new StageAgentService(createClaudeCliGenerateConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        service.generateFromPrompt('Generate a ticket')
      ).rejects.toMatchObject({
        category: 'parse',
        message: expect.stringContaining('Failed to parse ticket'),
      });
    });

    it('forwards resumeProviderSessionId to runStagePrompt when provided', async () => {
      const service = new StageAgentService(createConfigService());
      const validContent = JSON.stringify({ title: 'T', type: 'task', priority: 'medium', description: 'D' });
      const mockRunStagePrompt = jest.fn().mockResolvedValue({ content: validContent, sessionId: 'sess_resumed' });
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;

      const result = await service.generateFromPrompt('Generate a ticket', undefined, 'sess_prior');

      expect(mockRunStagePrompt).toHaveBeenCalledWith(
        expect.objectContaining({ resumeProviderSessionId: 'sess_prior' })
      );
      expect(result.sessionId).toBe('sess_resumed');
    });
  });

  describe('S1 diff threading', () => {
    const minimalDiff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 0000001..0000002 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,3 @@',
      ' line 1',
      '+line 2 added',
      ' line 2',
    ].join('\n');

    beforeEach(() => {
      spawnCli.mockReset();
      buildCliArgs.mockReturnValue([]);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('preserves review issue line numbers when the actual diff is threaded to parseAndProcessReview', async () => {
      const reviewWithIssue = JSON.stringify({
        summary: 'Found an issue',
        issues: [{ file: 'src/foo.ts', line: 2, message: 'Issue at line 2', severity: 'error' }],
        suggestions: [],
        approved: false,
      });

      spawnCli
        .mockImplementationOnce(async function* () {
          yield { type: 'result', subtype: 'success', result: reviewWithIssue, session_id: 'sess-s1' };
        })
        .mockImplementationOnce(async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Summary.' }] } };
        });

      const createClaudeCliReviewSvc = (): ConfigService =>
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

      const service = new StageAgentService(createClaudeCliReviewSvc());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await service.reviewCode(minimalDiff, []);

      expect(result.review.issues).toHaveLength(1);
      expect(result.review.issues[0].line).toBe(2);
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

  describe('reviewCode with screenshots', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('passes screenshots from opts into StagePromptParams', async () => {
      const service = new StageAgentService(createConfigService());
      const mockRunStagePrompt = jest.fn().mockResolvedValue({
        content: JSON.stringify({ summary: 'ok', issues: [], suggestions: [], approved: true }),
      });
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;
      const mockScreenshot = { path: '/p/a.png', mediaType: 'image/png' as const, base64: 'x' };

      await service.reviewCode('diff --git a/f b/f', [], undefined, undefined, undefined, undefined, {
        screenshots: [mockScreenshot],
      });

      const params = mockRunStagePrompt.mock.calls[0][0];
      expect(params.screenshots).toEqual([mockScreenshot]);
    });

    it('appends UI compliance section to systemPrompt when screenshots are present', async () => {
      const service = new StageAgentService(createConfigService());
      const mockRunStagePrompt = jest.fn().mockResolvedValue({
        content: JSON.stringify({ summary: 'ok', issues: [], suggestions: [], approved: true }),
      });
      (service as unknown as { runStagePrompt: jest.Mock }).runStagePrompt = mockRunStagePrompt;
      const mockScreenshot = { path: '/p/a.png', mediaType: 'image/png' as const, base64: 'x' };

      await service.reviewCode('diff --git a/f b/f', [], undefined, undefined, undefined, undefined, {
        screenshots: [mockScreenshot],
      });

      const params = mockRunStagePrompt.mock.calls[0][0];
      expect(params.systemPrompt).toContain('UI design compliance');
    });

    it('appends screenshot paths to prompt for agent-SDK dispatch', async () => {
      const service = new StageAgentService(createConfigService());
      const mockResponse = JSON.stringify({ summary: 'ok', issues: [], suggestions: [], approved: true });
      let capturedParams: unknown;
      jest.spyOn(service as any, 'runOpenAiStagePrompt').mockImplementation(async (p: unknown) => {
        capturedParams = p;
        return mockResponse;
      });
      const mockScreenshot = { path: '/p/design.png', mediaType: 'image/png' as const, base64: 'x' };

      await service.reviewCode('diff --git a/f b/f', [], undefined, undefined, undefined, undefined, {
        screenshots: [mockScreenshot],
      });

      expect((capturedParams as { prompt: string }).prompt).toContain('Design screenshots (accessible via filesystem)');
      expect((capturedParams as { prompt: string }).prompt).toContain('/p/design.png');
    });
  });

  describe('resolveTargetForStage', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns configured provider and model for a stage', () => {
      const svc = new StageAgentService(
        { get: (key: string) => {
          if (key === 'stages.implement.provider') return 'anthropic';
          if (key === 'stages.implement.model') return 'claude-sonnet-4-6';
          return undefined;
        } } as unknown as ConfigService,
      );
      expect(svc.resolveTargetForStage('implement')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    });

    it('uses the implement default model before the provider default', () => {
      const svc = new StageAgentService(
        { get: (key: string) => {
          if (key === 'stages.implement.provider') return 'openai';
          if (key === 'stages.implement.models') return { default: 'gpt-5.6-terra', mechanical: 'gpt-5.6-luna' };
          if (key === 'ai.providers') return [{ provider: 'openai', model: 'gpt-5.5' }];
          return undefined;
        } } as unknown as ConfigService,
      );

      expect(svc.resolveTargetForStage('implement')).toEqual({ provider: 'openai', model: 'gpt-5.6-terra' });
    });

    it('falls back to the provider default model when no stage model is configured', () => {
      const svc = new StageAgentService(
        { get: (key: string) => {
          if (key === 'stages.implement.provider') return 'anthropic';
          return undefined;
        } } as unknown as ConfigService,
      );
      const target = svc.resolveTargetForStage('implement');
      expect(target.provider).toBe('anthropic');
      expect(target.model.length).toBeGreaterThan(0);
    });
  });

  describe('anthropicChatTurn cost plumbing', () => {
    const createAnthropicAgentConfigService = (): ConfigService =>
      ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.review.backend': 'agent',
            'stages.review.provider': 'anthropic',
            'stages.review.model': 'claude-sonnet-4-6',
            'ai.provider': 'anthropic',
            'ai.model': 'claude-sonnet-4-6',
          };
          return key in values ? values[key] : defaultValue;
        }),
      }) as unknown as ConfigService;

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('exposes costUsd extracted from the Anthropic SDK result message', async () => {
      const service = new StageAgentService(createAnthropicAgentConfigService());
      const fakeSession = Object.assign(
        (async function* () {
          yield { type: 'result', subtype: 'success', is_error: false, result: 'hello world', total_cost_usd: 0.03 };
        })(),
        { close: jest.fn() }
      );

      const result = await (service as any).processAnthropicChatResult(fakeSession);
      expect(result.costUsd).toBe(0.03);
    });

    it('normalizes Anthropic structured_output into chat content', async () => {
      const service = new StageAgentService(createAnthropicAgentConfigService());
      const fakeSession = Object.assign(
        (async function* () {
          yield { type: 'result', subtype: 'success', is_error: false, structured_output: { findings: [] } };
        })(),
        { close: jest.fn() }
      );

      const result = await (service as any).processAnthropicChatResult(fakeSession);

      expect(result.content).toBe('{"findings":[]}');
    });
  });

  describe('openAiChatTurn cost plumbing', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('threads costUsd from processOpenAiStageResult through openAiChatTurn', async () => {
      const service = new StageAgentService(createConfigService());
      const mockAgent = {};
      const mockRunner = {};
      (service as any).requireOpenAiApiKey = jest.fn().mockReturnValue('sk-test');
      (service as any).resolveOpenAiChatAgent = jest.fn().mockResolvedValue({
        agent: mockAgent, runner: mockRunner, context: {},
      });
      (service as any).processOpenAiStageResult = jest.fn().mockResolvedValue({ content: 'ok', costUsd: 0.05 });

      const result = await (service as any).openAiChatTurn({
        stage: 'review', systemPrompt: 'sys', userMessage: 'msg',
      });
      expect(result.costUsd).toBe(0.05);
    });
  });

  describe('Codex CLI cost plumbing', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('accumulates costUsd from Codex CLI token usage', async () => {
      const service = new StageAgentService(createCodexConfigService());
      spawnCodex.mockImplementationOnce(async function* () {
        yield { type: 'thread.started', thread_id: 'thread-abc' };
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'step result' } };
        yield { type: 'turn.completed', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } };
      });

      const result = await (service as any).runCodexRetryLoop({
        stage: 'implement', model: 'gpt-4o', repoDir: '/tmp/repo', initialPrompt: 'do stuff',
      });
      expect(result.costUsd).toBeCloseTo(12.5, 4);
    });
  });

  describe('cliChatTurn cost plumbing', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('exposes costUsd from the CLI retry loop on the chatTurn result', async () => {
      const svc = new StageAgentService(createClaudeCliReviewConfigService());
      (svc as unknown as { runCliChatRetryLoop: jest.Mock }).runCliChatRetryLoop = jest
        .fn()
        .mockResolvedValue({ content: 'ok', sessionId: 'sess-1', costUsd: 0.0421 });

      const result = await svc.chatTurn({ stage: 'review', systemPrompt: 'sys', userMessage: 'msg' });

      expect(result.costUsd).toBe(0.0421);
    });

    it('sums costUsd across multiple retry passes', async () => {
      const svc = new StageAgentService(createClaudeCliReviewConfigService());
      let call = 0;
      (svc as unknown as { runCliChatPass: jest.Mock }).runCliChatPass = jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return Promise.resolve({
            result: '', source: undefined, hadContent: false, diagnostics: [],
            sessionId: 'sess-1', stopReason: undefined, costUsd: 0.01,
          });
        }
        return Promise.resolve({
          result: 'done', source: 'result' as const, hadContent: true, diagnostics: [],
          sessionId: 'sess-1', stopReason: undefined, costUsd: 0.02,
        });
      });

      const result = await svc.chatTurn({ stage: 'review', systemPrompt: 'sys', userMessage: 'msg' });

      expect(result.costUsd).toBeCloseTo(0.03, 5);
    });
  });

  describe('same-backend model fallback', () => {
    const mockModelUnavailableError = new AiProviderError('model gpt-4-turbo not found', undefined, true, 'api');

    const createFallbackConfigService = (): ConfigService =>
      ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.generate.backend': 'cli',
            'stages.generate.provider': 'openai',
            'stages.generate.model': 'gpt-4-turbo',
            'ai.provider': 'openai',
            'ai.model': 'gpt-5.4-mini',
            'ai.providers': [{ provider: 'openai', model: 'gpt-5.4-mini' }],
          };
          return key in values ? values[key] : defaultValue;
        }),
      }) as unknown as ConfigService;

    const createNoAlternativeConfigService = (): ConfigService =>
      ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const values: Record<string, unknown> = {
            'stages.generate.backend': 'cli',
            'stages.generate.provider': 'openai',
            'stages.generate.model': 'gpt-4-mini',
            'ai.provider': 'openai',
            'ai.model': 'gpt-4-mini',
            'ai.providers': [{ provider: 'openai', model: 'gpt-4-mini' }],
          };
          return key in values ? values[key] : defaultValue;
        }),
      }) as unknown as ConfigService;

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('retries generateFromPrompt with the fallback model when the configured model is unavailable', async () => {
      const svc = new StageAgentService(createFallbackConfigService());
      const runOnceSpy = jest.spyOn(svc as any, 'runStagePromptOnce')
        .mockRejectedValueOnce(mockModelUnavailableError)
        .mockResolvedValueOnce({ content: 'generated content' });

      const result = await svc.generateFromPrompt('Summarise this');

      expect(runOnceSpy).toHaveBeenCalledTimes(2);
      expect(runOnceSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ modelOverride: 'gpt-5.4-mini' }));
      expect(result.content).toBe('generated content');
    });

    it('re-throws when no same-backend alternative model is available', async () => {
      const svc = new StageAgentService(createNoAlternativeConfigService());
      const runOnceSpy = jest.spyOn(svc as any, 'runStagePromptOnce')
        .mockRejectedValue(new AiProviderError('model gpt-4-mini not found', undefined, true, 'api'));

      await expect(svc.generateFromPrompt('Summarise this')).rejects.toThrow('not found');
      expect(runOnceSpy).toHaveBeenCalledTimes(1);
    });

    it('surfaces the second-attempt error when the fallback model also fails', async () => {
      const svc = new StageAgentService(createFallbackConfigService());
      const fallbackError = new Error('fallback model also unavailable');
      jest.spyOn(svc as any, 'runStagePromptOnce')
        .mockRejectedValueOnce(mockModelUnavailableError)
        .mockRejectedValueOnce(fallbackError);

      await expect(svc.generateFromPrompt('Summarise this')).rejects.toThrow('fallback model also unavailable');
    });

    it('does not retry for an auth-category error', async () => {
      const svc = new StageAgentService(createFallbackConfigService());
      const runOnceSpy = jest.spyOn(svc as any, 'runStagePromptOnce')
        .mockRejectedValue(new AiProviderError('unauthorized', undefined, false, 'auth'));

      await expect(svc.generateFromPrompt('Summarise this')).rejects.toThrow('unauthorized');
      expect(runOnceSpy).toHaveBeenCalledTimes(1);
    });

    it('writes a WARN log entry with stage-agent.model.fallback and fallback-model on retry', async () => {
      const logFileWriter = require('../../shared/logger/log-file-writer');
      const appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      const svc = new StageAgentService(createFallbackConfigService());
      jest.spyOn(svc as any, 'runStagePromptOnce')
        .mockRejectedValueOnce(mockModelUnavailableError)
        .mockResolvedValueOnce({ content: 'ok' });

      await svc.generateFromPrompt('Summarise this');

      expect(appendSpy).toHaveBeenCalledWith(
        'WARN',
        expect.stringContaining('stage-agent.model.fallback'),
        'stage-agent',
      );
      expect(appendSpy).toHaveBeenCalledWith(
        'WARN',
        expect.stringContaining('fallback-model=gpt-5.4-mini'),
        'stage-agent',
      );
    });

    it('retries chatTurn with the fallback model when chatTurnOnce gets a model-unavailable error', async () => {
      const svc = new StageAgentService(createFallbackConfigService());
      const chatOnceSpy = jest.spyOn(svc as any, 'chatTurnOnce')
        .mockRejectedValueOnce(mockModelUnavailableError)
        .mockResolvedValueOnce({ content: 'chat response', session: {}, costUsd: 0.01 });

      const result = await svc.chatTurn({ stage: 'generate', systemPrompt: 'sys', userMessage: 'hi' });

      expect(chatOnceSpy).toHaveBeenCalledTimes(2);
      expect(chatOnceSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ modelOverride: 'gpt-5.4-mini', session: undefined }));
      expect(result.content).toBe('chat response');
    });

    it('chatTurn does not retry an auth-category error', async () => {
      const svc = new StageAgentService(createFallbackConfigService());
      jest.spyOn(svc as any, 'chatTurnOnce')
        .mockRejectedValue(new AiProviderError('unauthorized', undefined, false, 'auth'));

      await expect(svc.chatTurn({ stage: 'generate', systemPrompt: 'sys', userMessage: 'hi' })).rejects.toThrow('unauthorized');
    });

    describe('backend-runner-level fallback', () => {
      const VALID_GENERATE_JSON = '{"title":"t","type":"task","priority":"medium","description":"d"}';

      const createCodexCliGenerateFallbackConfig = (): ConfigService =>
        ({
          get: jest.fn((key: string, defaultValue?: unknown) => {
            const values: Record<string, unknown> = {
              'stages.generate.backend': 'cli',
              'stages.generate.provider': 'openai',
              'stages.generate.model': 'codex-v1',
              'ai.provider': 'openai',
              'ai.model': 'gpt-4o',
              'ai.providers': [{ provider: 'openai', model: 'gpt-4o' }],
            };
            return key in values ? values[key] : defaultValue;
          }),
        }) as unknown as ConfigService;

      const createCodexCliImplementFallbackConfig = (): ConfigService =>
        ({
          get: jest.fn((key: string, defaultValue?: unknown) => {
            const values: Record<string, unknown> = {
              'stages.implement.backend': 'cli',
              'stages.implement.provider': 'openai',
              'stages.implement.model': 'codex-v1',
              'ai.provider': 'openai',
              'ai.model': 'gpt-4o',
              'ai.providers': [{ provider: 'openai', model: 'gpt-4o' }],
            };
            return key in values ? values[key] : defaultValue;
          }),
        }) as unknown as ConfigService;

      const createClaudeCliGenerateFallbackConfig = (): ConfigService =>
        ({
          get: jest.fn((key: string, defaultValue?: unknown) => {
            const values: Record<string, unknown> = {
              'stages.generate.backend': 'cli',
              'stages.generate.provider': 'anthropic',
              'stages.generate.model': 'claude-haiku-4-5',
              'ai.provider': 'anthropic',
              'ai.model': 'claude-sonnet-4-6',
              'ai.providers': [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
            };
            return key in values ? values[key] : defaultValue;
          }),
        }) as unknown as ConfigService;

      const createClaudeCliReviewFallbackConfig = (): ConfigService =>
        ({
          get: jest.fn((key: string, defaultValue?: unknown) => {
            const values: Record<string, unknown> = {
              'stages.review.backend': 'cli',
              'stages.review.provider': 'anthropic',
              'stages.review.model': 'claude-haiku-4-5',
              'ai.provider': 'anthropic',
              'ai.model': 'claude-sonnet-4-6',
              'ai.providers': [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
            };
            return key in values ? values[key] : defaultValue;
          }),
        }) as unknown as ConfigService;

      beforeEach(() => {
        spawnCodex.mockReset();
        spawnCli.mockReset();
        buildCodexCliArgs.mockReset();
        buildCodexCliArgs.mockReturnValue([]);
        buildCliArgs.mockReset();
        buildCliArgs.mockReturnValue([]);
        mockLoadAnthropicAgentSdk.mockReset();
        const logFileWriter = require('../../shared/logger/log-file-writer');
        jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
      });

      const makeThrowingIterable = (error: Error) => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
      });

      it('retries Codex CLI generateFromPrompt with fallback model when spawnCodex throws model-unavailable', async () => {
        const svc = new StageAgentService(createCodexCliGenerateFallbackConfig());
        spawnCodex.mockReturnValueOnce(makeThrowingIterable(new AiProviderError('model codex-v1 not found', undefined, true, 'api')));
        spawnCodex.mockReturnValueOnce((async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: VALID_GENERATE_JSON } };
        })());

        const result = await svc.generateFromPrompt('generate a ticket');

        expect(spawnCodex).toHaveBeenCalledTimes(2);
        expect(buildCodexCliArgs).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'gpt-4o' }));
        expect(result.content).toBe(VALID_GENERATE_JSON);
      });

      it('retries Claude CLI generateFromPrompt with fallback model when spawnCli throws model-unavailable', async () => {
        const svc = new StageAgentService(createClaudeCliGenerateFallbackConfig());
        spawnCli.mockReturnValueOnce(makeThrowingIterable(new AiProviderError('model claude-haiku-4-5 not found', undefined, true, 'api')));
        spawnCli.mockReturnValueOnce((async function* () {
          yield { type: 'result', structured_output: { title: 't', type: 'task', priority: 'medium', description: 'd' }, is_error: false };
        })());

        const result = await svc.generateFromPrompt('generate a ticket');

        expect(spawnCli).toHaveBeenCalledTimes(2);
        expect(buildCliArgs).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'claude-sonnet-4-6' }));
        expect(result.content).toBe(VALID_GENERATE_JSON);
      });

      it('retries Codex CLI chatTurn with fallback model when spawnCodex throws model-unavailable', async () => {
        const svc = new StageAgentService(createCodexCliImplementFallbackConfig());
        spawnCodex.mockReturnValueOnce(makeThrowingIterable(new AiProviderError('model codex-v1 not found', undefined, true, 'api')));
        spawnCodex.mockReturnValueOnce((async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'chat response' } };
        })());

        const result = await svc.chatTurn({ stage: 'implement', systemPrompt: 'sys', userMessage: 'hi' });

        expect(spawnCodex).toHaveBeenCalledTimes(2);
        expect(buildCodexCliArgs).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'gpt-4o' }));
        expect(result.content).toBe('chat response');
      });

      it('retries Anthropic CLI chatTurn with fallback model when spawnCli throws model-unavailable', async () => {
        const svc = new StageAgentService(createClaudeCliReviewFallbackConfig());
        spawnCli.mockReturnValueOnce(makeThrowingIterable(new AiProviderError('model claude-haiku-4-5 not found', undefined, true, 'api')));
        spawnCli.mockReturnValueOnce((async function* () {
          yield { type: 'result', result: 'chat response', is_error: false };
        })());

        const result = await svc.chatTurn({ stage: 'review', systemPrompt: 'sys', userMessage: 'hi' });

        expect(spawnCli).toHaveBeenCalledTimes(2);
        expect(buildCliArgs).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'claude-sonnet-4-6' }));
        expect(result.content).toBe('chat response');
      });

      const createAnthropicAgentSdkGenerateFallbackConfig = (): ConfigService =>
        ({
          get: jest.fn((key: string, defaultValue?: unknown) => {
            const values: Record<string, unknown> = {
              'stages.generate.backend': 'agent',
              'stages.generate.provider': 'anthropic',
              'stages.generate.model': 'claude-haiku-4-5',
              'ai.provider': 'anthropic',
              'ai.model': 'claude-sonnet-4-6',
              'ai.anthropicApiKey': 'test-key',
              'ai.providers': [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
            };
            return key in values ? values[key] : defaultValue;
          }),
        }) as unknown as ConfigService;

      const createOpenAiAgentSdkGenerateFallbackConfig = (): ConfigService =>
        ({
          get: jest.fn((key: string, defaultValue?: unknown) => {
            const values: Record<string, unknown> = {
              'stages.generate.backend': 'agent',
              'stages.generate.provider': 'openai',
              'stages.generate.model': 'gpt-invalid',
              'ai.provider': 'openai',
              'ai.model': 'gpt-4o',
              'ai.openaiApiKey': 'test-key',
              'ai.providers': [{ provider: 'openai', model: 'gpt-4o' }],
            };
            return key in values ? values[key] : defaultValue;
          }),
        }) as unknown as ConfigService;

      it('retries Anthropic Agent SDK generateFromPrompt with fallback model when query throws model-unavailable', async () => {
        const svc = new StageAgentService(createAnthropicAgentSdkGenerateFallbackConfig());
        const mockQuery = jest.fn();
        mockLoadAnthropicAgentSdk.mockResolvedValue({ query: mockQuery });

        const throwingSession = {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new AiProviderError('model claude-haiku-4-5 not found', undefined, true, 'api')) }),
          close: jest.fn(),
        };
        const successSession = Object.assign(
          (async function* () { yield { type: 'result', subtype: 'success', result: VALID_GENERATE_JSON }; })(),
          { close: jest.fn() }
        );

        mockQuery.mockReturnValueOnce(throwingSession).mockReturnValueOnce(successSession);

        const result = await svc.generateFromPrompt('generate a ticket');

        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(mockQuery).toHaveBeenNthCalledWith(2, expect.objectContaining({
          options: expect.objectContaining({ model: 'claude-sonnet-4-6' }),
        }));
        expect(result.content).toBe(VALID_GENERATE_JSON);
      });

      it('retries OpenAI Agent SDK generateFromPrompt with fallback model when runner.run throws model-unavailable', async () => {
        const svc = new StageAgentService(createOpenAiAgentSdkGenerateFallbackConfig());
        const mockRunner = { run: jest.fn() };
        const buildOpenAiSpy = jest.spyOn(svc as any, 'buildOpenAiStageAgent').mockResolvedValue({
          agent: {}, runner: mockRunner, context: { repoDir: process.cwd() },
        });

        const mockStreamedRun = {
          [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true as const }) }),
          error: undefined,
          finalOutput: VALID_GENERATE_JSON,
        };

        mockRunner.run
          .mockRejectedValueOnce(new AiProviderError('model gpt-invalid not found', undefined, true, 'api'))
          .mockResolvedValueOnce(mockStreamedRun);

        const result = await svc.generateFromPrompt('generate a ticket');

        expect(buildOpenAiSpy).toHaveBeenCalledTimes(2);
        expect(buildOpenAiSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'gpt-4o' }));
        expect(result.content).toBe(VALID_GENERATE_JSON);
      });

      it('does not trigger model-unavailable fallback when spawnCodex throws a stale-session error', async () => {
        const svc = new StageAgentService(createCodexCliGenerateFallbackConfig());
        spawnCodex.mockReturnValueOnce(makeThrowingIterable(new Error('session_id not found')));

        await expect(svc.generateFromPrompt('generate a ticket')).rejects.toThrow('session_id not found');
        expect(spawnCodex).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('plan JSON schema example package manager interpolation', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('uses npm separator (--) in JSON schema example when conventions.packageManager is npm', async () => {
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
        issueContent: 'Fix a backend timeout',
        conventions: {
          language: 'typescript', namingPattern: 'kebab-case', importStyle: 'esm',
          folderStructure: [], keyDependencies: [], errorHandlingPaths: [], gitHooks: [],
          packageManager: 'npm',
        } as any,
      });

      expect(mockRunStagePrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('"run":"npm run test:manual -- test-auth-guard"'),
        }),
      );
    });

    it('omits -- in JSON schema example when conventions.packageManager is yarn', async () => {
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
        issueContent: 'Fix a backend timeout',
        conventions: {
          language: 'typescript', namingPattern: 'kebab-case', importStyle: 'esm',
          folderStructure: [], keyDependencies: [], errorHandlingPaths: [], gitHooks: [],
          packageManager: 'yarn',
        } as any,
      });

      expect(mockRunStagePrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('"run":"yarn test:manual test-auth-guard"'),
        }),
      );
    });
  });
});
