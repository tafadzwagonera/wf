import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyAgentError,
  extractUsageFromEvent,
  formatProgressMessage,
  parseRetryDelayMs,
  estimateOpenAiCostUsd,
  validateTypeScriptEdit,
  OpenAIAgentAdapter,
} from './openai-agent.adapter';
import { detectMechanicalTask } from './shared-routing';
import { loadAiContextConfig } from './load-ai-context-config';
import type { VerificationScript } from '../../../agents/interfaces';

jest.mock('@openai/agents-openai', () => ({
  OpenAIResponsesCompactionSession: jest.fn(),
}));

jest.mock('openai', () => jest.fn());

jest.mock('@openai/agents', () => ({
  Agent: jest.fn(),
  MaxTurnsExceededError: class MaxTurnsExceededError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MaxTurnsExceededError';
    }
  },
  ModelBehaviorError: class ModelBehaviorError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ModelBehaviorError';
    }
  },
  OpenAIProvider: jest.fn(),
  Runner: jest.fn(),
  setTracingExportApiKey: jest.fn(),
  SystemError: class SystemError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SystemError';
    }
  },
  ToolCallError: class ToolCallError extends Error {
    error: Error;
    constructor(message: string, error: Error) {
      super(message);
      this.name = 'ToolCallError';
      this.error = error;
    }
  },
  ToolTimeoutError: class ToolTimeoutError extends Error {
    toolName: string;
    timeoutMs: number;
    constructor({ toolName, timeoutMs }: { toolName: string; timeoutMs: number }) {
      super(`Tool ${toolName} timed out after ${timeoutMs}ms`);
      this.name = 'ToolTimeoutError';
      this.toolName = toolName;
      this.timeoutMs = timeoutMs;
    }
  },
  UserError: class UserError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'UserError';
    }
  },
  tool: jest.fn((config: Record<string, unknown>) => config),
}));

jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

jest.mock('./load-ai-context-config', () => ({
  loadAiContextConfig: jest.fn(),
}));

jest.mock('glob', () => ({
  glob: jest.fn(async (pattern: string, options: { cwd: string }) => {
    const actualFs = jest.requireActual<typeof import('fs')>('fs');
    const actualPath = jest.requireActual<typeof import('path')>('path');
    const results: string[] = [];
    const walkDir = (dir: string, rel: string): void => {
      try {
        const entries = actualFs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walkDir(actualPath.join(dir, entry.name), entryRel);
          } else if (entry.isFile()) {
            results.push(entryRel);
          }
        }
      } catch {
        // ignore
      }
    };
    walkDir(options.cwd, '');
    return results;
  }),
}));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: jest.fn(),
}));

const mockLoadAiContextConfig = loadAiContextConfig as jest.MockedFunction<typeof loadAiContextConfig>;
const {
  Agent: mockAgent,
  OpenAIProvider: mockOpenAIProvider,
  Runner: mockRunner,
  tool: mockTool,
} = jest.requireMock('@openai/agents');
const { OpenAIResponsesCompactionSession: mockCompactionSession } = jest.requireMock('@openai/agents-openai');
const mockOpenAIClient = jest.requireMock('openai');
const { exec: mockExec } = jest.requireMock('child_process');
const mockHomedir = os.homedir as jest.MockedFunction<typeof os.homedir>;

const makeConfigService = (overrides: Record<string, unknown> = {}): ConfigService => {
  const values: Record<string, unknown> = {
    'ai.openaiApiKey': 'test-openai-key',
    'stages.implement.model': 'gpt-5.4-mini',
    ...overrides,
  };

  return {
    get: jest.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
  } as unknown as ConfigService;
};

const makeStreamedRun = (
  events: Array<Record<string, unknown>>,
  finalOutput: string,
  error?: unknown,
  currentTurn = 2
) => ({
  error,
  finalOutput,
  currentTurn,
  async* [Symbol.asyncIterator]() {
    for (const event of events) {
      yield event;
    }
  },
});

const makeRawModelEvent = (data: Record<string, unknown>, source?: string) => ({
  type: 'raw_model_stream_event' as const,
  data,
  source,
});

const makeAgentUpdatedEvent = (agentName: string) => ({
  type: 'agent_updated_stream_event' as const,
  agent: { name: agentName },
});

const makeRunItemEvent = (name: string, item: Record<string, unknown>) => ({
  type: 'run_item_stream_event' as const,
  name,
  item,
});

const makeParams = (repoDir: string, verificationScripts: VerificationScript[] = []) => ({
  ticket: {
    ticketKey: 'T-1',
    content: 'ticket',
    path: '/tmp/ticket.md',
  },
  planArtifact: {
    action: 'fix' as const,
    path: '/tmp/plan.json',
    plan: {
      action: 'fix' as const,
      summary: 'test',
      steps: [],
      estimatedComplexity: 'medium' as const,
    },
  },
  options: {
    trackerName: 'jira',
    repoDir,
    additionalRepoDirs: ['/repo/shared'],
  },
  verificationScripts,
  repoFiles: [],
  repoName: 'primary',
  trackedFilePaths: [],
});

const getTool = (agent: Record<string, unknown>, name: string) => {
  const tools = agent.tools as Array<{
    name: string;
    execute: (input: Record<string, unknown>, runContext: { context: Record<string, unknown> }) => Promise<string>;
  }>;

  const tool = tools.find(entry => entry.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }

  return tool;
};

describe('OpenAIAgentAdapter', () => {
  beforeEach(() => {
    mockHomedir.mockReturnValue(path.join(os.tmpdir(), 'wf-home-default'));
    mockLoadAiContextConfig.mockResolvedValue('');
    mockAgent.mockImplementation((config: Record<string, unknown>) => config);
    mockOpenAIProvider.mockImplementation((config: Record<string, unknown>) => config);
    mockTool.mockImplementation((config: Record<string, unknown>) => config);
    mockCompactionSession.mockImplementation((config: Record<string, unknown>) => config);
    mockOpenAIClient.mockImplementation((config: Record<string, unknown>) => config);
    mockExec.mockImplementation(
      (
        command: string,
        optionsOrCallback: unknown,
        callbackMaybe?: (error: Error | null, result?: { stdout: string; stderr: string }) => void
      ) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackMaybe;
        callback?.(null, { stdout: 'ok', stderr: '' });
        return {} as never;
      }
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockLoadAiContextConfig.mockReset();
    mockHomedir.mockReset();
    mockAgent.mockReset();
    mockOpenAIProvider.mockReset();
    mockRunner.mockReset();
    mockTool.mockReset();
    mockCompactionSession.mockReset();
    mockOpenAIClient.mockReset();
    mockExec.mockReset();
  });

  describe('formatProgressMessage', () => {
    it('formats requested and completed tool events', () => {
      expect(
        formatProgressMessage({
          type: 'run_item_stream_event',
          name: 'tool_called',
          item: { type: 'function_call', name: 'write_file' },
        })
      ).toEqual({
        message: '  [openai-agent] Tool requested: write_file',
      });

      expect(
        formatProgressMessage({
          type: 'run_item_stream_event',
          name: 'tool_output',
          item: { type: 'function_call_result', name: 'write_file' },
        })
      ).toEqual({
        message: '  [openai-agent] Tool completed: write_file',
      });
    });

    it('formats reasoning events without heuristic suffixes', () => {
      expect(
        formatProgressMessage({
          type: 'run_item_stream_event',
          item: {
            type: 'reasoning',
            content: [{ text: 'Investigating verification output' }],
          },
        })
      ).toEqual({
        message: '  [openai-agent] Reasoning: Investigating verification output',
      });
    });

    it('formats response_done with token usage', () => {
      const event = makeRawModelEvent({
        type: 'response_done',
        response: {
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
          },
        },
      });
      expect(formatProgressMessage(event)).toEqual({
        message: '  [openai-agent] Response: 1000 in / 500 out tokens',
      });
    });

    it('formats response_done with compaction as a warning', () => {
      const event = makeRawModelEvent({
        type: 'response_done',
        response: {
          usage: {
            inputTokens: 2000,
            outputTokens: 100,
            totalTokens: 2100,
            requestUsageEntries: [{ endpoint: 'responses.compact' }],
          },
        },
      });
      const result = formatProgressMessage(event);
      expect(result).toEqual({
        message: '  [openai-agent] Context compacted',
        isWarning: true,
      });
    });

    it('formats agent_updated_stream_event', () => {
      expect(formatProgressMessage(makeAgentUpdatedEvent('test-agent'))).toEqual({
        message: '  [openai-agent] Agent updated: test-agent',
      });
    });

    it('formats message_output_created event', () => {
      expect(formatProgressMessage(makeRunItemEvent('message_output_created', {}))).toEqual({
        message: '  [openai-agent] Message output started',
      });
    });

    it('formats handoff events', () => {
      expect(formatProgressMessage(makeRunItemEvent('handoff_requested', {}))).toEqual({
        message: '  [openai-agent] Handoff requested',
      });
      expect(formatProgressMessage(makeRunItemEvent('handoff_occurred', {}))).toEqual({
        message: '  [openai-agent] Handoff occurred',
      });
    });

    it('formats tool search events', () => {
      expect(formatProgressMessage(makeRunItemEvent('tool_search_called', {}))).toEqual({
        message: '  [openai-agent] Tool search called',
      });
      expect(formatProgressMessage(makeRunItemEvent('tool_search_output_created', {}))).toEqual({
        message: '  [openai-agent] Tool search completed',
      });
    });

    it('formats tool_approval_requested event', () => {
      expect(
        formatProgressMessage(
          makeRunItemEvent('tool_approval_requested', {
            name: 'dangerous_tool',
          })
        )
      ).toEqual({
        message: '  [openai-agent] Tool approval requested: dangerous_tool',
      });
    });

    it('returns null for output_text_delta', () => {
      expect(formatProgressMessage(makeRawModelEvent({ type: 'output_text_delta', delta: 'hello' }))).toBeNull();
    });
  });

  describe('extractUsageFromEvent', () => {
    it('extracts usage from response_done', () => {
      const event = makeRawModelEvent({
        type: 'response_done',
        response: {
          usage: {
            inputTokens: 500,
            outputTokens: 200,
            totalTokens: 700,
          },
        },
      });
      expect(extractUsageFromEvent(event)).toEqual({
        inputTokens: 500,
        outputTokens: 200,
        totalTokens: 700,
        cachedInputTokens: 0,
        compacted: false,
      });
    });

    it('detects compaction from requestUsageEntries', () => {
      const event = makeRawModelEvent({
        type: 'response_done',
        response: {
          usage: {
            inputTokens: 1000,
            outputTokens: 50,
            totalTokens: 1050,
            requestUsageEntries: [{ endpoint: 'responses.compact' }],
          },
        },
      });
      expect(extractUsageFromEvent(event)).toEqual({
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
        cachedInputTokens: 0,
        compacted: true,
      });
    });

    it('extracts cachedInputTokens from inputTokensDetails', () => {
      const event = makeRawModelEvent({
        type: 'response_done',
        response: {
          usage: {
            inputTokens: 31376,
            outputTokens: 1063,
            totalTokens: 32439,
            inputTokensDetails: { cachedTokens: 12000 },
          },
        },
      });
      expect(extractUsageFromEvent(event)).toEqual({
        inputTokens: 31376,
        outputTokens: 1063,
        totalTokens: 32439,
        cachedInputTokens: 12000,
        compacted: false,
      });
    });

    it('returns null for non-usage events', () => {
      expect(extractUsageFromEvent({ type: 'run_item_stream_event' })).toBeNull();
      expect(extractUsageFromEvent(makeRawModelEvent({ type: 'output_text_delta' }))).toBeNull();
    });
  });

  describe('classifyAgentError', () => {
    const { MaxTurnsExceededError, ToolTimeoutError, ToolCallError, ModelBehaviorError, UserError, SystemError }
      = jest.requireMock('@openai/agents');

    it('classifies MaxTurnsExceededError', () => {
      const error = new MaxTurnsExceededError('exceeded 20 turns');
      const result = classifyAgentError(error);
      expect(result.label).toBe('Max turns exceeded');
      expect(result.recoverable).toBe(false);
    });

    it('classifies ToolTimeoutError as recoverable', () => {
      const error = new ToolTimeoutError({
        toolName: 'read_file',
        timeoutMs: 30000,
      });
      const result = classifyAgentError(error);
      expect(result.label).toBe('Tool timeout');
      expect(result.recoverable).toBe(true);
    });

    it('classifies rate limit (429)', () => {
      const error = Object.assign(new Error('rate limited'), { status: 429 });
      const result = classifyAgentError(error);
      expect(result.label).toBe('Rate limited');
      expect(result.recoverable).toBe(true);
    });

    it('classifies auth error (401)', () => {
      const error = Object.assign(new Error('unauthorized'), { status: 401 });
      const result = classifyAgentError(error);
      expect(result.label).toBe('Authentication error');
      expect(result.recoverable).toBe(false);
    });

    it('falls back to unknown for unrecognized errors', () => {
      const error = new Error('something unexpected');
      const result = classifyAgentError(error);
      expect(result.label).toBe('Unknown error');
      expect(result.detail).toBe('something unexpected');
    });
  });

  describe('parseRetryDelayMs', () => {
    it('extracts seconds from "Please try again in 1.229s"', () => {
      const err = new Error('Rate limit reached. Please try again in 1.229s.');
      expect(parseRetryDelayMs(err)).toBe(1229);
    });

    it('extracts milliseconds from "try again in 830ms"', () => {
      const err = new Error('Rate limit reached. Please try again in 830ms.');
      expect(parseRetryDelayMs(err)).toBe(830);
    });

    it('returns default for non-Error values', () => {
      expect(parseRetryDelayMs('string')).toBe(30_000);
    });

    it('returns default when no delay pattern is found', () => {
      expect(parseRetryDelayMs(new Error('Rate limited'))).toBe(30_000);
    });
  });

  describe('estimateOpenAiCostUsd', () => {
    it('estimates cost for gpt-4.1-mini', () => {
      // 100K input (no cache), 10K output
      // input: 100K/1M * $0.40 = $0.04, output: 10K/1M * $1.60 = $0.016
      const cost = estimateOpenAiCostUsd('gpt-4.1-mini', 100_000, 10_000, 0);
      expect(cost).toBeCloseTo(0.056, 4);
    });

    it('discounts cached input tokens', () => {
      // 100K input total, 60K cached, 40K uncached, 10K output
      // uncached: 40K/1M * $0.40 = $0.016, cached: 60K/1M * $0.10 = $0.006, output: $0.016
      const cost = estimateOpenAiCostUsd('gpt-4.1-mini', 100_000, 10_000, 60_000);
      expect(cost).toBeCloseTo(0.038, 4);
    });

    it('estimates cost for gpt-4.1', () => {
      // 50K input, 5K output
      // input: 50K/1M * $2.00 = $0.10, output: 5K/1M * $8.00 = $0.04
      const cost = estimateOpenAiCostUsd('gpt-4.1', 50_000, 5_000, 0);
      expect(cost).toBeCloseTo(0.14, 4);
    });

    it('returns null for unknown models', () => {
      expect(estimateOpenAiCostUsd('gpt-99', 100_000, 10_000, 0)).toBeNull();
    });
  });

  describe('detectMechanicalTask', () => {
    it('detects mechanical task from step language patterns', () => {
      const result = detectMechanicalTask({
        action: 'fix',
        summary: 'Migrate all loggers',
        steps: ['Migrate all Logger instances to PinoLogger'],
        estimatedComplexity: 'medium',
        affectedFiles: ['src/a.ts', 'src/b.ts'],
      });
      expect(result.isMechanical).toBe(true);
      expect(result.reason).toContain('pattern');
    });

    it('detects mechanical task from high file-to-step ratio', () => {
      const result = detectMechanicalTask({
        action: 'fix',
        summary: 'Update imports',
        steps: ['Update imports'],
        estimatedComplexity: 'medium',
        affectedFiles: Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`),
      });
      expect(result.isMechanical).toBe(true);
      expect(result.reason).toContain('file-to-step ratio');
    });

    it('detects mechanical task from low complexity with many files', () => {
      const result = detectMechanicalTask({
        action: 'fix',
        summary: 'Rename function',
        steps: ['Rename foo to bar in each file'],
        estimatedComplexity: 'low',
        affectedFiles: Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`),
      });
      expect(result.isMechanical).toBe(true);
    });

    it('returns creative for small focused plans', () => {
      const result = detectMechanicalTask({
        action: 'feature',
        summary: 'Add auth module',
        steps: ['Design auth schema', 'Implement middleware', 'Add tests'],
        estimatedComplexity: 'high',
        affectedFiles: ['src/auth.ts', 'src/auth.spec.ts'],
      });
      expect(result.isMechanical).toBe(false);
      expect(result.reason).toBe('high complexity task');
    });

    it('detects mechanical from low estimated complexity alone', () => {
      const result = detectMechanicalTask({
        action: 'fix',
        summary: 'Update config',
        steps: ['Update value', 'Update another value', 'Update third value'],
        estimatedComplexity: 'low',
        affectedFiles: Array.from({ length: 5 }, (_, i) => `src/f${i}.ts`),
      });
      expect(result.isMechanical).toBe(true);
      expect(result.reason).toContain('low complexity');
    });

    it('returns creative for high complexity even with mechanical keywords', () => {
      const result = detectMechanicalTask({
        action: 'feature',
        summary: 'Migrate all services',
        steps: ['Migrate all services to new architecture'],
        estimatedComplexity: 'high',
        affectedFiles: ['src/service1.ts', 'src/service2.ts'],
      });
      expect(result.isMechanical).toBe(false);
      expect(result.reason).toBe('high complexity task');
    });

    it('detects mechanical from semantic signals in medium complexity plan', () => {
      const result = detectMechanicalTask({
        action: 'fix',
        summary: 'Standardize code',
        steps: ['Standardize naming convention', 'Apply same approach in every module'],
        estimatedComplexity: 'medium',
        affectedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      });
      expect(result.isMechanical).toBe(true);
      expect(result.reason).toContain('semantic');
    });

    it('returns creative when semantic signals tie', () => {
      const result = detectMechanicalTask({
        action: 'feature',
        summary: 'Normalize and refactor',
        steps: ['Normalize the config format', 'Refactor the parser module'],
        estimatedComplexity: 'medium',
        affectedFiles: ['src/config.ts', 'src/parser.ts'],
      });
      expect(result.isMechanical).toBe(false);
      expect(result.reason).toBe('creative task');
    });

    it('does not false-positive on incidental "repeat" without directional context', () => {
      const result = detectMechanicalTask({
        action: 'fix',
        summary: 'Prevent repeat failures',
        steps: ['Do not repeat this mistake in production'],
        estimatedComplexity: 'medium',
        affectedFiles: ['src/handler.ts'],
      });
      expect(result.isMechanical).toBe(false);
      expect(result.reason).toBe('creative task');
    });
  });

  describe('model routing in generateAndVerify', () => {
    it('uses mechanical model when --model-routing=mechanical', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-routing-mech-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(
        makeConfigService({
          'stages.implement.model': undefined,
          'stages.implement.models': { mechanical: 'gpt-5.1-codex-mini' },
        })
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const params = {
        ...makeParams(repoDir),
        options: {
          ...makeParams(repoDir).options,
          modelRouting: 'mechanical' as const,
        },
      };
      await adapter.generateAndVerify(params);

      const agentConfig = mockAgent.mock.calls[0]?.[0] as { model: string };
      expect(agentConfig.model).toBe('gpt-5.1-codex-mini');

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(
        logCalls.some(
          message =>
            message.includes('Model routing:') && message.includes('mechanical') && message.includes('user override')
        )
      ).toBe(true);
    });

    it('uses default model when --model-routing=default', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-routing-default-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const params = {
        ...makeParams(repoDir),
        options: {
          ...makeParams(repoDir).options,
          modelRouting: 'default' as const,
        },
      };
      await adapter.generateAndVerify(params);

      const agentConfig = mockAgent.mock.calls[0]?.[0] as { model: string };
      expect(agentConfig.model).toBe('gpt-5.4-mini');
    });

    it('auto-detects mechanical task and selects cheaper model', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-routing-auto-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(
        makeConfigService({
          'stages.implement.model': undefined,
          'stages.implement.models': { mechanical: 'gpt-5.1-codex-mini' },
        })
      );
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const params = {
        ...makeParams(repoDir),
        planArtifact: {
          action: 'fix' as const,
          path: '/tmp/plan.json',
          plan: {
            action: 'fix' as const,
            summary: 'Migrate all loggers',
            steps: ['Migrate all Logger instances to PinoLogger'],
            estimatedComplexity: 'low' as const,
          },
        },
        options: {
          ...makeParams(repoDir).options,
          modelRouting: 'auto' as const,
        },
      };
      await adapter.generateAndVerify(params);

      const agentConfig = mockAgent.mock.calls[0]?.[0] as { model: string };
      expect(agentConfig.model).toBe('gpt-5.1-codex-mini');

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(
        logCalls.some(
          message => message.includes('Model routing:') && message.includes('auto') && message.includes('mechanical')
        )
      ).toBe(true);
    });

    it('reads mechanical model from stages.implement.models.mechanical config', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-routing-config-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(
        makeConfigService({
          'stages.implement.model': undefined,
          'stages.implement.models': { mechanical: 'gpt-4.1-nano' },
        })
      );
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const params = {
        ...makeParams(repoDir),
        options: {
          ...makeParams(repoDir).options,
          modelRouting: 'mechanical' as const,
        },
      };
      await adapter.generateAndVerify(params);

      const agentConfig = mockAgent.mock.calls[0]?.[0] as { model: string };
      expect(agentConfig.model).toBe('gpt-4.1-nano');
    });

    it('throws when both model and models are configured', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-routing-warn-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const adapter = new OpenAIAgentAdapter(
        makeConfigService({
          'stages.implement.model': 'gpt-5.4-mini',
          'stages.implement.models': { mechanical: 'gpt-4.1-nano' },
        })
      );

      await expect(adapter.generateAndVerify(makeParams(repoDir))).rejects.toThrow(
        'stages.implement.model and stages.implement.models are mutually exclusive.'
      );
    });
  });

  describe('generateAndVerify', () => {
    it('allows only whitelisted verification commands and prints a file summary', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-agent-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun(
        [
          {
            type: 'run_item_stream_event',
            name: 'tool_called',
            item: { type: 'function_call', name: 'write_file' },
          },
          {
            type: 'run_item_stream_event',
            name: 'tool_output',
            item: { type: 'function_call_result', name: 'write_file' },
          },
        ],
        'Implemented the change and verified it.'
      );

      mockRunner.mockImplementation((config: Record<string, unknown>) => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const writeTool = getTool(agent, 'write_file');
          const verifyTool = getTool(agent, 'verify_command');
          const workspaceContext = {
            repoDir,
            readRoots: [{ name: path.basename(repoDir), root: repoDir }],
          };

          const writeResult = await writeTool.execute(
            { path: 'src/foo.ts', content: 'updated\n' },
            { context: workspaceContext }
          );
          const writeParsed = JSON.parse(writeResult) as {
            path: string;
            status: string;
          };
          expect(writeParsed.status).toBe('updated');

          const verificationResult = await verifyTool.execute(
            { command: 'npm test' },
            {
              context: {
                repoDir,
                allowedVerificationCommands: new Set(['npm test']),
              },
            }
          );
          const verificationParsed = JSON.parse(verificationResult) as {
            exitCode: number;
            progress: { verdict: string };
          };
          expect(verificationParsed.exitCode).toBe(0);
          expect(verificationParsed.progress.verdict).toBe('complete');

          return mockRunResult;
        }),
        config,
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await adapter.generateAndVerify(
        makeParams(repoDir, [
          {
            id: 'verify',
            name: 'test',
            command: 'npm test',
            policy: 'enforced',
            aliases: [],
          },
        ])
      );

      expect(mockLoadAiContextConfig).toHaveBeenCalledWith(
        path.join(os.homedir(), '.openai', 'AGENTS.md'),
        'AGENTS.md',
        'openai',
        true
      );
      expect(mockAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'wf issue:implement openai backend',
          model: 'gpt-5.4-mini',
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'read_file' }),
            expect.objectContaining({ name: 'write_file' }),
            expect.objectContaining({ name: 'edit_file' }),
            expect.objectContaining({ name: 'delete_file' }),
            expect.objectContaining({ name: 'search_files' }),
            expect.objectContaining({ name: 'find_files' }),
            expect.objectContaining({ name: 'verify_command' }),
          ]),
        })
      );
      expect(mockOpenAIProvider).toHaveBeenCalledWith({
        openAIClient: expect.objectContaining({
          apiKey: 'test-openai-key',
        }),
      });
      expect(mockRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: expect.objectContaining({
            openAIClient: expect.objectContaining({
              apiKey: 'test-openai-key',
            }),
          }),
        })
      );
      const mockRunnerInstance = mockRunner.mock.results[0]?.value as Record<string, unknown> & { run?: jest.Mock };
      expect(mockRunnerInstance.run).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          stream: true,
          maxTurns: 500,
          session: expect.anything(),
        })
      );
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec.mock.calls[0][0]).toBe('npm test');

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(message => message.includes('[openai-agent] File updated: src/foo.ts'))).toBe(true);
      expect(logCalls.some(message => message.includes('[openai-agent] Verification running: npm test'))).toBe(true);
      expect(logCalls.some(message => message.includes('[openai-agent] Verification passed: npm test'))).toBe(true);
      expect(logCalls.every(message => !message.includes('progress:'))).toBe(true);
      expect(logCalls.some(message => message.includes('OpenAI agent implementation complete'))).toBe(true);
      expect(logCalls.some(message => message.includes('Updated files:'))).toBe(true);
      expect(logCalls.some(message => message.includes('updated: src/foo.ts'))).toBe(true);
    });

    it('rejects a verification command that is not on the whitelist before execution', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-agent-denied-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');

      mockRunner.mockImplementation(() => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const verifyTool = getTool(agent, 'verify_command');
          const result = await verifyTool.execute(
            { command: 'yarn lint' },
            {
              context: {
                repoDir,
                allowedVerificationCommands: new Set(['npm test']),
              },
            }
          );

          expect(result).toContain('is not in the verification whitelist');
          return mockRunResult;
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await adapter.generateAndVerify(
        makeParams(repoDir, [
          {
            id: 'verify',
            name: 'test',
            command: 'npm test',
            policy: 'enforced',
            aliases: [],
          },
        ])
      );

      expect(mockExec).not.toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(message => message.includes('[openai-agent] Verification denied: yarn lint'))).toBe(true);
    });

    it('prints an explicit failed verification log when a command exits non-zero', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-agent-failed-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      mockExec.mockImplementation(
        (
          command: string,
          optionsOrCallback: unknown,
          callbackMaybe?: (error: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => {
          const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackMaybe;
          const error = Object.assign(new Error('tests failed'), {
            code: 1,
            stdout: 'stdout',
            stderr: 'stderr',
          });
          callback?.(error, { stdout: 'stdout', stderr: 'stderr' });
          return {} as never;
        }
      );

      mockRunner.mockImplementation(() => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const verifyTool = getTool(agent, 'verify_command');

          await verifyTool.execute(
            { command: 'npm test' },
            {
              context: {
                repoDir,
                allowedVerificationCommands: new Set(['npm test']),
              },
            }
          );

          return makeStreamedRun([], 'Done.');
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await adapter.generateAndVerify(
        makeParams(repoDir, [
          {
            id: 'verify',
            name: 'test',
            command: 'npm test',
            policy: 'enforced',
            aliases: [],
          },
        ])
      );

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(message => message.includes('[openai-agent] Verification failed: npm test'))).toBe(true);
      expect(logCalls.every(message => !message.includes('progress:'))).toBe(true);
    });

    it('edit_file performs surgical replacement', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-edit-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'const x = 1;\nconst y = 2;\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const editTool = getTool(agent, 'edit_file');
          const result = await editTool.execute(
            {
              path: 'src/foo.ts',
              old_string: 'const x = 1;',
              new_string: 'const x = 42;',
            },
            {
              context: {
                repoDir,
                readRoots: [{ name: path.basename(repoDir), root: repoDir }],
              },
            }
          );
          const parsed = JSON.parse(result) as { status: string };
          expect(parsed.status).toBe('updated');
          return mockRunResult;
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      await adapter.generateAndVerify(makeParams(repoDir));

      const content = fs.readFileSync(path.join(repoDir, 'src', 'foo.ts'), 'utf-8');
      expect(content).toBe('const x = 42;\nconst y = 2;\n');
    });

    it('edit_file rejects ambiguous matches (2+ occurrences)', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-edit-ambig-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'hello\nhello\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const editTool = getTool(agent, 'edit_file');
          const result = await editTool.execute(
            {
              path: 'src/foo.ts',
              old_string: 'hello',
              new_string: 'world',
            },
            {
              context: {
                repoDir,
                readRoots: [{ name: path.basename(repoDir), root: repoDir }],
              },
            }
          );
          const parsed = JSON.parse(result) as { error: string };
          expect(parsed.error).toContain('ambiguous');
          return mockRunResult;
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      await adapter.generateAndVerify(makeParams(repoDir));
    });

    it('edit_file rejects missing old_string', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-edit-missing-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const editTool = getTool(agent, 'edit_file');
          const result = await editTool.execute(
            {
              path: 'src/foo.ts',
              old_string: 'nonexistent string',
              new_string: 'replacement',
            },
            {
              context: {
                repoDir,
                readRoots: [{ name: path.basename(repoDir), root: repoDir }],
              },
            }
          );
          const parsed = JSON.parse(result) as { error: string };
          expect(parsed.error).toContain('not found');
          return mockRunResult;
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      await adapter.generateAndVerify(makeParams(repoDir));
    });

    it('search_files returns matches within workspace', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-search-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'const logger = new Logger();\n');

      mockExec.mockImplementation(
        (
          command: string,
          optionsOrCallback: unknown,
          callbackMaybe?: (error: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => {
          const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackMaybe;
          if (typeof command === 'string' && command.includes('grep')) {
            callback?.(null, {
              stdout: `${path.join(repoDir, 'src', 'foo.ts')}:1:const logger = new Logger();\n`,
              stderr: '',
            });
          } else {
            callback?.(null, { stdout: 'ok', stderr: '' });
          }
          return {} as never;
        }
      );

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const searchTool = getTool(agent, 'search_files');
          const result = await searchTool.execute(
            { pattern: 'Logger', max_results: 50 },
            {
              context: {
                repoDir,
                readRoots: [{ name: path.basename(repoDir), root: repoDir }],
              },
            }
          );
          const parsed = JSON.parse(result) as {
            matches: Array<{ file: string; line: number }>;
          };
          expect(parsed.matches.length).toBeGreaterThan(0);
          expect(parsed.matches[0].file).toBe('src/foo.ts');
          return mockRunResult;
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      await adapter.generateAndVerify(makeParams(repoDir));
    });

    it('search_files rejects paths outside readable roots', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-search-denied-'));

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const searchTool = getTool(agent, 'search_files');
          await expect(
            searchTool.execute(
              { pattern: 'secret', path: '/etc', max_results: 50 },
              {
                context: {
                  repoDir,
                  readRoots: [{ name: path.basename(repoDir), root: repoDir }],
                },
              }
            )
          ).rejects.toThrow('outside the allowed workspace roots');
          return mockRunResult;
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      await adapter.generateAndVerify(makeParams(repoDir));
    });

    it('find_files returns matching paths', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-find-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'bar.ts'), 'export {};\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const findTool = getTool(agent, 'find_files');
          const result = await findTool.execute(
            { pattern: '**/*.ts', max_results: 200 },
            {
              context: {
                repoDir,
                readRoots: [{ name: path.basename(repoDir), root: repoDir }],
              },
            }
          );
          const parsed = JSON.parse(result) as { files: string[] };
          expect(parsed.files).toContain('src/bar.ts');
          return mockRunResult;
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      await adapter.generateAndVerify(makeParams(repoDir));
    });

    it('logs turn count and usage after successful run', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-completion-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun(
        [
          makeRawModelEvent({
            type: 'response_done',
            response: {
              usage: {
                inputTokens: 1000,
                outputTokens: 500,
                totalTokens: 1500,
              },
            },
          }),
        ],
        'Done.',
        undefined,
        3
      );

      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await adapter.generateAndVerify(makeParams(repoDir));

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(message => message.includes('Agent completed in 3 turn(s)'))).toBe(true);
      expect(logCalls.some(message => message.includes('Usage: 1000 input / 500 output tokens'))).toBe(true);
    });

    it('passes a compaction session to Runner.run()', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-compaction-session-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await adapter.generateAndVerify(makeParams(repoDir));

      expect(mockOpenAIClient).toHaveBeenCalledWith({
        apiKey: 'test-openai-key',
      });
      expect(mockCompactionSession).toHaveBeenCalledWith(
        expect.objectContaining({
          compactionMode: 'auto',
          shouldTriggerCompaction: expect.any(Function),
        })
      );
      const mockRunnerInstance = mockRunner.mock.results[0]?.value as Record<string, unknown> & { run?: jest.Mock };
      const runOptions = mockRunnerInstance.run?.mock.calls[0]?.[2] as {
        session: unknown;
      };
      expect(runOptions.session).toBeDefined();
    });

    it('shouldTriggerCompaction fires on item count or observed input tokens', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-compaction-hook-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      await adapter.generateAndVerify(makeParams(repoDir));

      const hookArg = mockCompactionSession.mock.calls[0]?.[0] as Record<string, unknown>;
      const shouldTrigger = hookArg.shouldTriggerCompaction as (arg: {
        compactionCandidateItems: unknown[];
      }) => boolean;

      // ≥10 candidate items → true
      expect(
        shouldTrigger({
          compactionCandidateItems: Array.from({ length: 10 }),
        })
      ).toBe(true);

      // Few candidates and no observed tokens yet → false
      expect(
        shouldTrigger({
          compactionCandidateItems: Array.from({ length: 3 }),
        })
      ).toBe(false);
    });

    it('logs cached token count when present', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-cached-log-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun(
        [
          makeRawModelEvent({
            type: 'response_done',
            response: {
              usage: {
                inputTokens: 31376,
                outputTokens: 1063,
                totalTokens: 32439,
                inputTokensDetails: { cachedTokens: 12000 },
              },
            },
          }),
        ],
        'Done.',
        undefined,
        5
      );

      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await adapter.generateAndVerify(makeParams(repoDir));

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(
        logCalls.some(
          message =>
            message.includes('Usage: 31376 input')
            && message.includes('(12000 cached)')
            && message.includes('1063 output tokens')
        )
      ).toBe(true);
    });

    it('logs compaction triggered message when compaction occurred', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-compaction-log-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun(
        [
          makeRawModelEvent({
            type: 'response_done',
            response: {
              usage: {
                inputTokens: 2000,
                outputTokens: 100,
                totalTokens: 2100,
                requestUsageEntries: [{ endpoint: 'responses.compact' }],
              },
            },
          }),
        ],
        'Done.'
      );

      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await adapter.generateAndVerify(makeParams(repoDir));

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(message => message.includes('Context compaction triggered during run'))).toBe(true);
    });

    it('uses a fixed maxTurns ceiling with progress-based stall detection', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-maxturns-ceiling-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const largeParams = {
        ...makeParams(repoDir),
        planArtifact: {
          action: 'feature' as const,
          path: '/tmp/plan.json',
          plan: {
            action: 'feature' as const,
            summary: 'large migration',
            steps: Array.from({ length: 17 }, (_, i) => `Step ${i + 1}`),
            estimatedComplexity: 'high' as const,
          },
        },
      };
      await adapter.generateAndVerify(largeParams);

      const mockRunnerInstance = mockRunner.mock.results[0]?.value as Record<string, unknown> & { run?: jest.Mock };
      const runCall = mockRunnerInstance.run?.mock.calls[0];
      const runOptions = runCall?.[2] as { maxTurns: number } | undefined;
      expect(runOptions?.maxTurns).toBe(500);
    });

    it('includes plan steps in system prompt', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-prompt-steps-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const params = {
        ...makeParams(repoDir),
        planArtifact: {
          action: 'fix' as const,
          path: '/tmp/plan.json',
          plan: {
            action: 'fix' as const,
            summary: 'test',
            steps: ['Migrate Logger to PinoLogger', 'Update unit tests'],
            estimatedComplexity: 'low' as const,
          },
        },
        conventionsSection: 'Repository conventions (primary):\n- Formatter: prettier (semi: false)',
      };
      await adapter.generateAndVerify(params);

      const agentConfig = mockAgent.mock.calls[0]?.[0] as {
        instructions: string;
      };
      expect(agentConfig.instructions).toContain('Plan steps:');
      expect(agentConfig.instructions).toContain('1. Migrate Logger to PinoLogger');
      expect(agentConfig.instructions).toContain('2. Update unit tests');
      expect(agentConfig.instructions).toContain('You MUST implement ALL plan steps');
      expect(agentConfig.instructions).toContain('Repository conventions (primary):');
      expect(agentConfig.instructions).toContain('Formatter: prettier');
    });

    it('includes repo conventions in continuation prompts', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-prompt-continuation-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');
      const runMock = jest.fn(async () => mockRunResult);
      mockRunner.mockImplementation(() => ({
        run: runMock,
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await adapter.generateAndVerify({
        ...makeParams(repoDir),
        repoFiles: ['primary/src/foo.ts'],
        trackedFilePaths: ['primary/src/foo.ts'],
        conventionsSection: 'Repository conventions (primary):\n- Formatter: prettier (semi: false)',
      });

      const continuationPrompt = ((runMock.mock.calls[1] as unknown) as [unknown, string])[1];
      expect(continuationPrompt).toContain('Repository conventions (primary):');
      expect(continuationPrompt).toContain('Formatter: prettier');
    });

    it('edit_file rejects edits that create duplicate constructors', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-edit-dup-ctor-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      const originalContent = [
        'class Foo {',
        '  constructor(private logger: Logger) {}',
        '  run() { this.logger.log("hi"); }',
        '}',
      ].join('\n');
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), originalContent);

      const mockRunResult = makeStreamedRun([], 'Done.');
      mockRunner.mockImplementation(() => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const editTool = getTool(agent, 'edit_file');
          const result = await editTool.execute(
            {
              path: 'src/foo.ts',
              old_string: 'class Foo {',
              new_string: 'class Foo {\n  constructor(private pino: PinoLogger) {}',
            },
            {
              context: {
                repoDir,
                readRoots: [{ name: path.basename(repoDir), root: repoDir }],
              },
            }
          );
          const parsed = JSON.parse(result) as { error: string };
          expect(parsed.error).toContain('Foo');
          expect(parsed.error).toContain('constructor declarations');
          return mockRunResult;
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});
      await adapter.generateAndVerify(makeParams(repoDir));

      // File on disk must be unchanged (rollback)
      const diskContent = fs.readFileSync(path.join(repoDir, 'src', 'foo.ts'), 'utf-8');
      expect(diskContent).toBe(originalContent);
    });

    it('classifies MaxTurnsExceededError in catch block', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-maxturns-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const { MaxTurnsExceededError } = jest.requireMock('@openai/agents');
      const maxTurnsError = new MaxTurnsExceededError('exceeded 20 turns');

      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => {
          return {
            error: maxTurnsError,
            finalOutput: '',
            currentTurn: 20,
            async* [Symbol.asyncIterator]() {
              // no events
            },
          };
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(adapter.generateAndVerify(makeParams(repoDir))).rejects.toThrow('Max turns exceeded');

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(logCalls.some(message => message.includes('Max turns exceeded'))).toBe(true);
    });

    it('resets rate-limit retry counter when progress is made between errors', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-rate-reset-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const rateLimitError = Object.assign(new Error('Rate limit reached. Please try again in 1ms.'), { status: 429 });

      // Simulate: rate limit → progress → rate limit → progress → ... (>5 total rate limits)
      // Should survive because the counter resets after each progress segment.
      let callCount = 0;
      const mockRun = jest.fn(async () => {
        callCount++;
        if (callCount <= 6) {
          return {
            error: undefined,
            finalOutput: '',
            currentTurn: callCount,
            state: {},
            async* [Symbol.asyncIterator]() {
              yield makeRawModelEvent({
                type: 'response_done',
                response: {
                  usage: {
                    inputTokens: 100,
                    outputTokens: 50,
                    totalTokens: 150,
                  },
                },
              });
              throw rateLimitError;
            },
          };
        }
        return makeStreamedRun([], 'Done.');
      });
      mockRunner.mockImplementation(() => ({ run: mockRun, config: {} }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      // Should NOT throw — 6 total rate limits but never >5 consecutive
      await adapter.generateAndVerify(makeParams(repoDir));
      expect(mockRun).toHaveBeenCalledTimes(7);
    }, 15_000);

    it('fails after consecutive rate limits without progress', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-rate-fail-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const rateLimitError = Object.assign(new Error('Rate limit reached. Please try again in 1ms.'), { status: 429 });

      const mockRun = jest.fn(async () => ({
        error: undefined,
        finalOutput: '',
        currentTurn: 1,
        state: {},
        // eslint-disable-next-line require-yield
        async* [Symbol.asyncIterator]() {
          throw rateLimitError;
        },
      }));
      mockRunner.mockImplementation(() => ({ run: mockRun, config: {} }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      jest.spyOn(console, 'log').mockImplementation(() => {});

      await expect(adapter.generateAndVerify(makeParams(repoDir))).rejects.toThrow('Rate limited');
      // Initial call + 5 retries = 6 total
      expect(mockRun).toHaveBeenCalledTimes(6);
    }, 15_000);

    describe('adaptive compaction thresholds', () => {
      it('uses 20 items for plans with 8 steps', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-compact-mid-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

        const mockRunResult = makeStreamedRun([], 'Done.');
        mockRunner.mockImplementation(() => ({
          run: jest.fn(async () => mockRunResult),
          config: {},
        }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = {
          ...makeParams(repoDir),
          planArtifact: {
            action: 'fix' as const,
            path: '/tmp/plan.json',
            plan: {
              action: 'fix' as const,
              summary: 'mid-size plan',
              steps: Array.from({ length: 8 }, (_, i) => `Step ${i + 1}`),
              estimatedComplexity: 'medium' as const,
            },
          },
        };
        await adapter.generateAndVerify(params);

        const hookArg = mockCompactionSession.mock.calls[0]?.[0] as Record<string, unknown>;
        const shouldTrigger = hookArg.shouldTriggerCompaction as (arg: {
          compactionCandidateItems: unknown[];
        }) => boolean;

        // 20 candidate items → true (threshold is 20)
        expect(
          shouldTrigger({
            compactionCandidateItems: Array.from({ length: 20 }),
          })
        ).toBe(true);

        // 19 candidates, no observed tokens → false
        expect(
          shouldTrigger({
            compactionCandidateItems: Array.from({ length: 19 }),
          })
        ).toBe(false);
      });

      it('uses 30 items for plans with 15 steps', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-compact-large-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

        const mockRunResult = makeStreamedRun([], 'Done.');
        mockRunner.mockImplementation(() => ({
          run: jest.fn(async () => mockRunResult),
          config: {},
        }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = {
          ...makeParams(repoDir),
          planArtifact: {
            action: 'fix' as const,
            path: '/tmp/plan.json',
            plan: {
              action: 'fix' as const,
              summary: 'large plan',
              steps: Array.from({ length: 15 }, (_, i) => `Step ${i + 1}`),
              estimatedComplexity: 'high' as const,
            },
          },
        };
        await adapter.generateAndVerify(params);

        const hookArg = mockCompactionSession.mock.calls[0]?.[0] as Record<string, unknown>;
        const shouldTrigger = hookArg.shouldTriggerCompaction as (arg: {
          compactionCandidateItems: unknown[];
        }) => boolean;

        // 30 candidate items → true (threshold is 30)
        expect(
          shouldTrigger({
            compactionCandidateItems: Array.from({ length: 30 }),
          })
        ).toBe(true);

        // 29 candidates, no observed tokens → false
        expect(
          shouldTrigger({
            compactionCandidateItems: Array.from({ length: 29 }),
          })
        ).toBe(false);
      });
    });

    describe('incomplete-work loop stall detection', () => {
      it('skips loop when all planned files touched in initial run', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-stall-skip-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');
        fs.writeFileSync(path.join(repoDir, 'src', 'bar.ts'), 'original\n');

        const mockRun = jest.fn(async (agent: Record<string, unknown>) => {
          const writeTool = getTool(agent, 'write_file');
          const workspaceContext = {
            repoDir,
            readRoots: [{ name: path.basename(repoDir), root: repoDir }],
          };

          await writeTool.execute({ path: 'src/foo.ts', content: 'updated foo\n' }, { context: workspaceContext });
          await writeTool.execute({ path: 'src/bar.ts', content: 'updated bar\n' }, { context: workspaceContext });

          return makeStreamedRun([], 'Done.');
        });

        mockRunner.mockImplementation(() => ({
          run: mockRun,
          config: {},
        }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = {
          ...makeParams(repoDir),
          repoFiles: ['primary/src/foo.ts', 'primary/src/bar.ts'],
        };
        await adapter.generateAndVerify(params);

        // Only the initial pass — no continuation passes needed
        expect(mockRun).toHaveBeenCalledTimes(1);
      });

      it('breaks after 2 non-improving passes', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-stall-break-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

        const mockRun = jest.fn(async () => makeStreamedRun([], 'Done.'));

        mockRunner.mockImplementation(() => ({
          run: mockRun,
          config: {},
        }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = {
          ...makeParams(repoDir),
          repoFiles: ['primary/src/foo.ts'],
        };
        await adapter.generateAndVerify(params);

        // 1 initial + 2 continuation passes (stall detected at stalledPasses=2)
        expect(mockRun).toHaveBeenCalledTimes(3);

        const logMessages = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
        expect(logMessages).toContain('Workload not decreasing');
      });

      it('continues when workload decreases and completes', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-stall-progress-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');
        fs.writeFileSync(path.join(repoDir, 'src', 'bar.ts'), 'original\n');

        const mockRun = jest.fn(async (agent: Record<string, unknown>) => {
          const callIndex = mockRun.mock.calls.length;
          const writeTool = getTool(agent, 'write_file');
          const workspaceContext = {
            repoDir,
            readRoots: [{ name: path.basename(repoDir), root: repoDir }],
          };

          if (callIndex === 1) {
            // First call: write only foo.ts
            await writeTool.execute({ path: 'src/foo.ts', content: 'updated foo\n' }, { context: workspaceContext });
          }
          if (callIndex === 2) {
            // Second call (continuation): write bar.ts
            await writeTool.execute({ path: 'src/bar.ts', content: 'updated bar\n' }, { context: workspaceContext });
          }

          return makeStreamedRun([], 'Done.');
        });

        mockRunner.mockImplementation(() => ({
          run: mockRun,
          config: {},
        }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = {
          ...makeParams(repoDir),
          repoFiles: ['primary/src/foo.ts', 'primary/src/bar.ts'],
        };
        await adapter.generateAndVerify(params);

        // Initial pass writes foo.ts, continuation pass writes bar.ts → done
        expect(mockRun).toHaveBeenCalledTimes(2);
      });

      it('counts validation failures in workload', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-stall-validation-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(repoDir, 'src', 'foo.ts'),
          [
            'class Foo {',
            '  constructor(private logger: Logger) {}',
            '  run() { this.logger.log("hi"); }',
            '}',
            '',
          ].join('\n')
        );

        const mockRun = jest.fn(async (agent: Record<string, unknown>) => {
          const callIndex = mockRun.mock.calls.length;
          const workspaceContext = {
            repoDir,
            readRoots: [{ name: path.basename(repoDir), root: repoDir }],
          };

          if (callIndex === 1) {
            // Write foo.ts to mark it as touched (removes it from unvisited)
            const writeTool = getTool(agent, 'write_file');
            await writeTool.execute(
              {
                path: 'src/foo.ts',
                content: [
                  'class Foo {',
                  '  constructor(private logger: Logger) {}',
                  '  run() { this.logger.log("hi"); }',
                  '}',
                  '',
                ].join('\n'),
              },
              { context: workspaceContext }
            );

            // Now apply a bad edit that creates a duplicate constructor
            const editTool = getTool(agent, 'edit_file');
            await editTool.execute(
              {
                path: 'src/foo.ts',
                old_string: 'class Foo {',
                new_string: 'class Foo {\n  constructor(private pino: PinoLogger) {}',
              },
              { context: workspaceContext }
            );
          }
          // Calls 2 and 3: do nothing — workload stays at 1 (uniqueFailureCount)

          return makeStreamedRun([], 'Done.');
        });

        mockRunner.mockImplementation(() => ({
          run: mockRun,
          config: {},
        }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = {
          ...makeParams(repoDir),
          repoFiles: ['primary/src/foo.ts'],
        };
        await adapter.generateAndVerify(params);

        // 1 initial + 2 continuations (stalls on uniqueFailureCount not decreasing)
        expect(mockRun).toHaveBeenCalledTimes(3);

        const logMessages = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
        expect(logMessages).toContain('Workload not decreasing');
      });

      it('clears validation failures when a corrective edit lands', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-stall-clear-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(repoDir, 'src', 'foo.ts'),
          [
            'class Foo {',
            '  constructor(private logger: Logger) {}',
            '  run() { this.logger.log("hi"); }',
            '}',
            '',
          ].join('\n')
        );

        const mockRun = jest.fn(async (agent: Record<string, unknown>) => {
          const callIndex = mockRun.mock.calls.length;
          const workspaceContext = {
            repoDir,
            readRoots: [{ name: path.basename(repoDir), root: repoDir }],
          };

          if (callIndex === 1) {
            const editTool = getTool(agent, 'edit_file');

            // Bad edit: duplicate constructor
            await editTool.execute(
              {
                path: 'src/foo.ts',
                old_string: 'class Foo {',
                new_string: 'class Foo {\n  constructor(private pino: PinoLogger) {}',
              },
              { context: workspaceContext }
            );

            // Corrective edit: merge into single constructor
            await editTool.execute(
              {
                path: 'src/foo.ts',
                old_string: '  constructor(private logger: Logger) {}',
                new_string: '  constructor(private logger: PinoLogger) {}',
              },
              { context: workspaceContext }
            );
          }

          return makeStreamedRun([], 'Done.');
        });

        mockRunner.mockImplementation(() => ({
          run: mockRun,
          config: {},
        }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = {
          ...makeParams(repoDir),
          repoFiles: ['primary/src/foo.ts'],
        };
        await adapter.generateAndVerify(params);

        // Only the initial pass — corrective edit cleared the failure,
        // so workload is 0 and the loop does not run
        expect(mockRun).toHaveBeenCalledTimes(1);
      });

      it('does not count idle pass toward stall budget', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-idle-exempt-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

        // call index: 1=initial, 2=idle continuation, 3+4=non-improving (exhaust stall budget)
        const mockRun = jest.fn(async () => {
          const callIndex = mockRun.mock.calls.length;
          return callIndex === 2
            ? makeStreamedRun([], 'Done.', undefined, 1)
            : makeStreamedRun([], 'Done.');
        });

        mockRunner.mockImplementation(() => ({ run: mockRun, config: {} }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = { ...makeParams(repoDir), repoFiles: ['primary/src/foo.ts'] };
        await adapter.generateAndVerify(params);

        // initial + idle + 2 non-improving stall passes = 4 total
        expect(mockRun).toHaveBeenCalledTimes(4);
        const logMessages = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
        expect(logMessages).toContain('Workload not decreasing');
      });

      it('stops after 3 consecutive idle passes', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-idle-cap-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

        const mockRun = jest.fn(async () => {
          const callIndex = mockRun.mock.calls.length;
          // initial pass is non-idle; all continuation passes are idle
          return callIndex === 1
            ? makeStreamedRun([], 'Done.')
            : makeStreamedRun([], 'Done.', undefined, 1);
        });

        mockRunner.mockImplementation(() => ({ run: mockRun, config: {} }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = { ...makeParams(repoDir), repoFiles: ['primary/src/foo.ts'] };
        await adapter.generateAndVerify(params);

        // initial + 3 idle continuation passes = 4 total, then idle cap fires
        expect(mockRun).toHaveBeenCalledTimes(4);
        const logMessages = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
        expect(logMessages).toContain('consecutive idle passes');
      });

      it('logs diagnostic when pass produces no tool calls', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-idle-diag-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

        const mockRun = jest.fn(async () => {
          const callIndex = mockRun.mock.calls.length;
          return callIndex === 2
            ? makeStreamedRun([], 'I could not find any files to edit.', undefined, 1)
            : makeStreamedRun([], 'Done.');
        });

        mockRunner.mockImplementation(() => ({ run: mockRun, config: {} }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = { ...makeParams(repoDir), repoFiles: ['primary/src/foo.ts'] };
        await adapter.generateAndVerify(params);

        const logMessages = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
        expect(logMessages).toContain('produced no tool calls (idle)');
        expect(logMessages).toContain('I could not find any files to edit.');
      });

      it('scales stall threshold with file count', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-threshold-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        // 15 concrete files → threshold = Math.max(2, ceil(15/5)) = 3
        const repoFiles = Array.from({ length: 15 }, (_, i) => `primary/src/file${i}.ts`);
        for (let i = 0; i < 15; i++) {
          fs.writeFileSync(path.join(repoDir, 'src', `file${i}.ts`), 'original\n');
        }

        const mockRun = jest.fn(async () => makeStreamedRun([], 'Done.'));
        mockRunner.mockImplementation(() => ({ run: mockRun, config: {} }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = { ...makeParams(repoDir), repoFiles };
        await adapter.generateAndVerify(params);

        // initial + 3 non-improving continuation passes = 4 total (threshold = 3)
        expect(mockRun).toHaveBeenCalledTimes(4);
        const logMessages = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
        expect(logMessages).toContain('Workload not decreasing');
      });

      it('includes progress summary in continuation prompt', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-prompt-progress-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

        const mockRun = jest.fn(async () => makeStreamedRun([], 'Done.'));
        mockRunner.mockImplementation(() => ({ run: mockRun, config: {} }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = { ...makeParams(repoDir), repoFiles: ['primary/src/foo.ts'] };
        await adapter.generateAndVerify(params);

        // second call (first continuation): second arg is the prompt string (state is undefined)
        const promptArg = (mockRun.mock.calls as unknown[][])[1]?.[1] as string | undefined;
        expect(typeof promptArg === 'string' && promptArg.includes('Progress: 0/1 files modified')).toBe(true);
      });

      it('includes plan summary in continuation prompt', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-prompt-summary-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

        const mockRun = jest.fn(async () => makeStreamedRun([], 'Done.'));
        mockRunner.mockImplementation(() => ({ run: mockRun, config: {} }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = { ...makeParams(repoDir), repoFiles: ['primary/src/foo.ts'] };
        await adapter.generateAndVerify(params);

        const promptArg = (mockRun.mock.calls as unknown[][])[1]?.[1] as string | undefined;
        expect(typeof promptArg === 'string' && promptArg.includes('Goal: test')).toBe(true);
      });

      it('includes verification commands in continuation prompt', async () => {
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-prompt-verify-'));
        fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

        const mockRun = jest.fn(async () => makeStreamedRun([], 'Done.'));
        mockRunner.mockImplementation(() => ({ run: mockRun, config: {} }));

        const adapter = new OpenAIAgentAdapter(makeConfigService());
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const params = {
          ...makeParams(repoDir, [
            { id: 'build', name: 'Build', command: 'yarn build', policy: 'enforced' as const, aliases: [] },
          ]),
          repoFiles: ['primary/src/foo.ts'],
        };
        await adapter.generateAndVerify(params);

        const promptArg = (mockRun.mock.calls as unknown[][])[1]?.[1] as string | undefined;
        expect(typeof promptArg === 'string' && promptArg.includes('yarn build')).toBe(true);
      });
    });
  });

  describe('validateTypeScriptEdit', () => {
    it('returns null for valid TypeScript', () => {
      const content = `
import { Logger } from './logger';

class Foo {
  constructor(private logger: Logger) {}
  run() { this.logger.log("hi"); }
}
`;
      expect(validateTypeScriptEdit('src/foo.ts', content)).toBeNull();
    });

    it('returns error containing "syntax error" for malformed TypeScript', () => {
      const content = `
class Foo {
  constructor( {}
}
`;
      const result = validateTypeScriptEdit('src/foo.ts', content);
      expect(result).not.toBeNull();
      expect(result).toContain('syntax error');
    });

    it('returns error for duplicate constructors with bodies', () => {
      const content = `
class MyService {
  constructor(private pino: PinoLogger) {}
  constructor(private logger: Logger) {}
  run() {}
}
`;
      const result = validateTypeScriptEdit('src/my-service.ts', content);
      expect(result).not.toBeNull();
      expect(result).toContain('MyService');
      expect(result).toContain('constructor declarations');
    });

    it('returns error for duplicate named imports from the same module', () => {
      const content = `
import { Logger, Logger } from '@nestjs/common';

class Foo {}
`;
      const result = validateTypeScriptEdit('src/foo.ts', content);
      expect(result).not.toBeNull();
      expect(result).toContain('Logger');
    });

    it('returns null for non-TS files (.js, .json)', () => {
      expect(validateTypeScriptEdit('src/foo.js', 'class Foo { constructor() {} constructor() {} }')).toBeNull();
      expect(validateTypeScriptEdit('data.json', '{ "key": "value" }')).toBeNull();
    });
  });
});
