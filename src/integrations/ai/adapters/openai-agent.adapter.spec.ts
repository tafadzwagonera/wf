import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatProgressMessage,
  OpenAIAgentAdapter,
} from './openai-agent.adapter';
import { loadAiContextConfig } from './load-ai-context-config';
import type { VerificationScript } from '../../../agents/interfaces';

jest.mock('@openai/agents', () => ({
  Agent: jest.fn(),
  OpenAIProvider: jest.fn(),
  Runner: jest.fn(),
  tool: jest.fn((config: Record<string, unknown>) => config),
}));

jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

jest.mock('./load-ai-context-config', () => ({
  loadAiContextConfig: jest.fn(),
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
) => ({
  error,
  finalOutput,
  async *[Symbol.asyncIterator]() {
    for (const event of events) {
      yield event;
    }
  },
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
      ).toBe('  [openai-agent] Tool requested: write_file');

      expect(
        formatProgressMessage({
          type: 'run_item_stream_event',
          name: 'tool_output',
          item: { type: 'function_call_result', name: 'write_file' },
        }),
      ).toBe('  [openai-agent] Tool completed: write_file');
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
      ).toBe('  [openai-agent] Reasoning: Investigating verification output');
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
            expect.objectContaining({ name: 'delete_file' }),
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
  });
});
