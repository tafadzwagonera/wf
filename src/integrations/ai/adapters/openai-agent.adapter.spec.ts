import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyAgentError,
  extractUsageFromEvent,
  formatProgressMessage,
  OpenAIAgentAdapter,
} from './openai-agent.adapter';
import { loadAiContextConfig } from './load-ai-context-config';
import type { VerificationScript } from '../../../agents/interfaces';

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
    constructor({
      toolName,
      timeoutMs,
    }: {
      toolName: string;
      timeoutMs: number;
    }) {
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

const mockLoadAiContextConfig = loadAiContextConfig as jest.MockedFunction<
  typeof loadAiContextConfig
>;
const {
  Agent: mockAgent,
  OpenAIProvider: mockOpenAIProvider,
  Runner: mockRunner,
  tool: mockTool,
} = jest.requireMock('@openai/agents');
const { exec: mockExec } = jest.requireMock('child_process');
const mockHomedir = os.homedir as jest.MockedFunction<typeof os.homedir>;

const makeConfigService = (
  overrides: Record<string, unknown> = {},
): ConfigService => {
  const values: Record<string, unknown> = {
    'ai.openaiApiKey': 'test-openai-key',
    'stages.implement.model': 'gpt-5.4-mini',
    ...overrides,
  };

  return {
    get: jest.fn((key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
    ),
  } as unknown as ConfigService;
};

const makeStreamedRun = (
  events: Array<Record<string, unknown>>,
  finalOutput: string,
  error?: unknown,
  currentTurn = 1,
) => ({
  error,
  finalOutput,
  currentTurn,
  async *[Symbol.asyncIterator]() {
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

const makeParams = (
  repoDir: string,
  verificationScripts: VerificationScript[] = [],
) => ({
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
      estimatedComplexity: 'low' as const,
    },
  },
  options: {
    platformName: 'jira',
    repoDir,
    additionalRepoDirs: ['/repo/shared'],
  },
  verificationScripts,
  sceneContext: 'implement it',
  repoFiles: ['primary/src/foo.ts'],
  repoName: 'primary',
  trackedFilePaths: ['primary/src/foo.ts'],
});

const getTool = (agent: Record<string, unknown>, name: string) => {
  const tools = agent.tools as Array<{
    name: string;
    execute: (
      input: Record<string, unknown>,
      runContext: { context: Record<string, unknown> },
    ) => Promise<string>;
  }>;

  const tool = tools.find((entry) => entry.name === name);
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
    mockOpenAIProvider.mockImplementation(
      (config: Record<string, unknown>) => config,
    );
    mockTool.mockImplementation((config: Record<string, unknown>) => config);
    mockExec.mockImplementation(
      (
        command: string,
        optionsOrCallback: unknown,
        callbackMaybe?: (
          error: Error | null,
          result?: { stdout: string; stderr: string },
        ) => void,
      ) => {
        const callback =
          typeof optionsOrCallback === 'function'
            ? optionsOrCallback
            : callbackMaybe;
        callback?.(null, { stdout: 'ok', stderr: '' });
        return {} as never;
      },
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
    mockExec.mockReset();
  });

  describe('formatProgressMessage', () => {
    it('formats requested and completed tool events', () => {
      expect(
        formatProgressMessage({
          type: 'run_item_stream_event',
          name: 'tool_called',
          item: { type: 'function_call', name: 'write_file' },
        }),
      ).toEqual({
        message: '  [openai-agent] Tool requested: write_file',
      });

      expect(
        formatProgressMessage({
          type: 'run_item_stream_event',
          name: 'tool_output',
          item: { type: 'function_call_result', name: 'write_file' },
        }),
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
        }),
      ).toEqual({
        message:
          '  [openai-agent] Reasoning: Investigating verification output',
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
      expect(
        formatProgressMessage(makeAgentUpdatedEvent('test-agent')),
      ).toEqual({
        message: '  [openai-agent] Agent updated: test-agent',
      });
    });

    it('formats message_output_created event', () => {
      expect(
        formatProgressMessage(makeRunItemEvent('message_output_created', {})),
      ).toEqual({
        message: '  [openai-agent] Message output started',
      });
    });

    it('formats handoff events', () => {
      expect(
        formatProgressMessage(makeRunItemEvent('handoff_requested', {})),
      ).toEqual({ message: '  [openai-agent] Handoff requested' });
      expect(
        formatProgressMessage(makeRunItemEvent('handoff_occurred', {})),
      ).toEqual({ message: '  [openai-agent] Handoff occurred' });
    });

    it('formats tool search events', () => {
      expect(
        formatProgressMessage(makeRunItemEvent('tool_search_called', {})),
      ).toEqual({ message: '  [openai-agent] Tool search called' });
      expect(
        formatProgressMessage(
          makeRunItemEvent('tool_search_output_created', {}),
        ),
      ).toEqual({ message: '  [openai-agent] Tool search completed' });
    });

    it('formats tool_approval_requested event', () => {
      expect(
        formatProgressMessage(
          makeRunItemEvent('tool_approval_requested', {
            name: 'dangerous_tool',
          }),
        ),
      ).toEqual({
        message: '  [openai-agent] Tool approval requested: dangerous_tool',
      });
    });

    it('returns null for output_text_delta', () => {
      expect(
        formatProgressMessage(
          makeRawModelEvent({ type: 'output_text_delta', delta: 'hello' }),
        ),
      ).toBeNull();
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
        compacted: true,
      });
    });

    it('returns null for non-usage events', () => {
      expect(
        extractUsageFromEvent({ type: 'run_item_stream_event' }),
      ).toBeNull();
      expect(
        extractUsageFromEvent(makeRawModelEvent({ type: 'output_text_delta' })),
      ).toBeNull();
    });
  });

  describe('classifyAgentError', () => {
    const {
      MaxTurnsExceededError,
      ToolTimeoutError,
      ToolCallError,
      ModelBehaviorError,
      UserError,
      SystemError,
    } = jest.requireMock('@openai/agents');

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

  describe('generateAndVerify', () => {
    it('allows only whitelisted verification commands and prints a file summary', async () => {
      const repoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wf-openai-agent-'),
      );
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
        'Implemented the change and verified it.',
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
            { context: workspaceContext },
          );
          const writeProgress = JSON.parse(writeResult) as {
            progress: { verdict: string };
          };
          expect(writeProgress.progress.verdict).toBe('continue');

          const verificationResult = await verifyTool.execute(
            { command: 'npm test' },
            {
              context: {
                repoDir,
                allowedVerificationCommands: new Set(['npm test']),
              },
            },
          );
          const verificationProgress = JSON.parse(verificationResult) as {
            progress: { verdict: string };
          };
          expect(verificationProgress.progress.verdict).toBe('complete');

          return mockRunResult;
        }),
        config,
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      await adapter.generateAndVerify(
        makeParams(repoDir, [
          {
            id: 'verify',
            name: 'test',
            command: 'npm test',
            policy: 'enforced',
            aliases: [],
          },
        ]),
      );

      expect(mockLoadAiContextConfig).toHaveBeenCalledWith(
        path.join(os.homedir(), '.openai', 'OPENAI.md'),
        '.openai/OPENAI.md',
        'openai',
        true,
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
        }),
      );
      expect(mockOpenAIProvider).toHaveBeenCalledWith({
        apiKey: 'test-openai-key',
      });
      expect(mockRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: expect.objectContaining({
            apiKey: 'test-openai-key',
          }),
        }),
      );
      const mockRunnerInstance = mockRunner.mock.results[0]?.value as Record<
        string,
        unknown
      > & { run?: jest.Mock };
      expect(mockRunnerInstance.run).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          stream: true,
          maxTurns: 20,
        }),
      );
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec.mock.calls[0][0]).toBe('npm test');

      const logCalls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(
        logCalls.some((message) =>
          message.includes('[openai-agent] File updated: src/foo.ts'),
        ),
      ).toBe(true);
      expect(
        logCalls.some((message) =>
          message.includes('[openai-agent] Verification running: npm test'),
        ),
      ).toBe(true);
      expect(
        logCalls.some((message) =>
          message.includes('[openai-agent] Verification passed: npm test'),
        ),
      ).toBe(true);
      expect(logCalls.every((message) => !message.includes('progress:'))).toBe(
        true,
      );
      expect(
        logCalls.some((message) =>
          message.includes('OpenAI agent implementation complete'),
        ),
      ).toBe(true);
      expect(
        logCalls.some((message) => message.includes('Updated files:')),
      ).toBe(true);
      expect(
        logCalls.some((message) => message.includes('updated: src/foo.ts')),
      ).toBe(true);
    });

    it('rejects a verification command that is not on the whitelist before execution', async () => {
      const repoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wf-openai-agent-denied-'),
      );
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      const mockRunResult = makeStreamedRun([], 'Done.');

      mockRunner.mockImplementation(() => ({
        run: jest.fn(async (agent: Record<string, unknown>) => {
          const verifyTool = getTool(agent, 'verify_command');
          const result = await verifyTool.execute(
            { command: 'npm run lint' },
            {
              context: {
                repoDir,
                allowedVerificationCommands: new Set(['npm test']),
              },
            },
          );

          expect(result).toContain('is not in the verification whitelist');
          return mockRunResult;
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      await adapter.generateAndVerify(
        makeParams(repoDir, [
          {
            id: 'verify',
            name: 'test',
            command: 'npm test',
            policy: 'enforced',
            aliases: [],
          },
        ]),
      );

      expect(mockExec).not.toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(
        logCalls.some((message) =>
          message.includes('[openai-agent] Verification denied: npm run lint'),
        ),
      ).toBe(true);
    });

    it('prints an explicit failed verification log when a command exits non-zero', async () => {
      const repoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wf-openai-agent-failed-'),
      );
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src', 'foo.ts'), 'original\n');

      mockExec.mockImplementation(
        (
          command: string,
          optionsOrCallback: unknown,
          callbackMaybe?: (
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          const callback =
            typeof optionsOrCallback === 'function'
              ? optionsOrCallback
              : callbackMaybe;
          const error = Object.assign(new Error('tests failed'), {
            code: 1,
            stdout: 'stdout',
            stderr: 'stderr',
          });
          callback?.(error, { stdout: 'stdout', stderr: 'stderr' });
          return {} as never;
        },
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
            },
          );

          return makeStreamedRun([], 'Done.');
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      await adapter.generateAndVerify(
        makeParams(repoDir, [
          {
            id: 'verify',
            name: 'test',
            command: 'npm test',
            policy: 'enforced',
            aliases: [],
          },
        ]),
      );

      const logCalls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(
        logCalls.some((message) =>
          message.includes('[openai-agent] Verification failed: npm test'),
        ),
      ).toBe(true);
      expect(logCalls.every((message) => !message.includes('progress:'))).toBe(
        true,
      );
    });

    it('edit_file performs surgical replacement', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-openai-edit-'));
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, 'src', 'foo.ts'),
        'const x = 1;\nconst y = 2;\n',
      );

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
            },
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

      const content = fs.readFileSync(
        path.join(repoDir, 'src', 'foo.ts'),
        'utf-8',
      );
      expect(content).toBe('const x = 42;\nconst y = 2;\n');
    });

    it('edit_file rejects ambiguous matches (2+ occurrences)', async () => {
      const repoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wf-openai-edit-ambig-'),
      );
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
            },
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
      const repoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wf-openai-edit-missing-'),
      );
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
            },
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
      const repoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wf-openai-search-'),
      );
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, 'src', 'foo.ts'),
        'const logger = new Logger();\n',
      );

      mockExec.mockImplementation(
        (
          command: string,
          optionsOrCallback: unknown,
          callbackMaybe?: (
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          const callback =
            typeof optionsOrCallback === 'function'
              ? optionsOrCallback
              : callbackMaybe;
          if (typeof command === 'string' && command.includes('grep')) {
            callback?.(null, {
              stdout: `${path.join(repoDir, 'src', 'foo.ts')}:1:const logger = new Logger();\n`,
              stderr: '',
            });
          } else {
            callback?.(null, { stdout: 'ok', stderr: '' });
          }
          return {} as never;
        },
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
            },
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
      const repoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wf-openai-search-denied-'),
      );

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
              },
            ),
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
            },
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
      const repoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wf-openai-completion-'),
      );
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
        3,
      );

      mockRunner.mockImplementation(() => ({
        run: jest.fn(async () => mockRunResult),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      await adapter.generateAndVerify(makeParams(repoDir));

      const logCalls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(
        logCalls.some((message) =>
          message.includes('Agent completed in 3 turn(s)'),
        ),
      ).toBe(true);
      expect(
        logCalls.some((message) =>
          message.includes('Usage: 1000 input / 500 output tokens'),
        ),
      ).toBe(true);
    });

    it('classifies MaxTurnsExceededError in catch block', async () => {
      const repoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wf-openai-maxturns-'),
      );
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
            async *[Symbol.asyncIterator]() {
              // no events
            },
          };
        }),
        config: {},
      }));

      const adapter = new OpenAIAgentAdapter(makeConfigService());
      const consoleSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      await expect(
        adapter.generateAndVerify(makeParams(repoDir)),
      ).rejects.toThrow('Max turns exceeded');

      const logCalls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(
        logCalls.some((message) => message.includes('Max turns exceeded')),
      ).toBe(true);
    });
  });
});
