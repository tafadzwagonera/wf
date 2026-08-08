// src/integrations/ai/adapters/anthropic-agent.adapter.spec.ts
import { ConfigService } from '@nestjs/config';
import { type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AnthropicAgentAdapter,
  buildSystemPrompt,
  formatActivityMessages,
  formatProgressMessage,
} from './anthropic-agent.adapter';
import { detectMechanicalTask } from './shared-routing';
import { loadAnthropicAgentSdk } from './load-anthropic-agent-sdk';
import type { VerificationScript } from '../../../agents/interfaces';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  __esModule: true,
}));
jest.mock('./load-anthropic-agent-sdk', () => ({
  loadAnthropicAgentSdk: jest.fn(),
}));
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: jest.fn(),
}));

const mockLoadAnthropicAgentSdk = loadAnthropicAgentSdk as jest.MockedFunction<typeof loadAnthropicAgentSdk>;
const mockHomedir = os.homedir as jest.MockedFunction<typeof os.homedir>;

const makeConfigService = (overrides: Record<string, unknown> = {}): ConfigService => {
  const values: Record<string, unknown> = {
    'ai.anthropicApiKey': 'test-key',
    'ai.model': 'claude-sonnet-4-6',
    ...overrides,
  };

  return {
    get: jest.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
  } as unknown as ConfigService;
};

const makeResultSuccess = (overrides: Partial<SDKResultMessage> = {}): SDKResultMessage =>
  ({
    type: 'result',
    subtype: 'success',
    duration_ms: 100,
    duration_api_ms: 100,
    is_error: false,
    num_turns: 2,
    result: 'Done.',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '11111111-1111-1111-1111-111111111111',
    session_id: 'session-1',
    ...overrides,
  }) as SDKResultMessage;

const makeResultError = (overrides: Partial<SDKResultMessage> = {}): SDKResultMessage =>
  ({
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 100,
    duration_api_ms: 100,
    is_error: true,
    num_turns: 2,
    stop_reason: 'error',
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
    modelUsage: {},
    permission_denials: [],
    errors: ['verification failed'],
    uuid: '11111111-1111-1111-1111-111111111112',
    session_id: 'session-2',
    ...overrides,
  }) as SDKResultMessage;

const makeTaskProgressMessage = (): SDKMessage =>
  ({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task-1',
    description: 'Working on progress',
    summary: 'Checking file boundaries',
    last_tool_name: 'Edit',
    usage: {
      total_tokens: 120,
      tool_uses: 3,
      duration_ms: 1500,
    },
    uuid: '11111111-1111-1111-1111-111111111113',
    session_id: 'session-3',
  }) as SDKMessage;

const makeToolProgressMessage = (): SDKMessage =>
  ({
    type: 'tool_progress',
    tool_use_id: 'tool-use-1',
    tool_name: 'Write',
    parent_tool_use_id: null,
    elapsed_time_seconds: 2.4,
    task_id: 'task-1',
    uuid: '11111111-1111-1111-1111-111111111114',
    session_id: 'session-4',
  }) as SDKMessage;

const makeFilesPersistedMessage = (): SDKMessage =>
  ({
    type: 'system',
    subtype: 'files_persisted',
    files: [
      {
        filename: '/repo/primary/src/foo.ts',
        file_id: 'file-1',
      },
    ],
    failed: [],
    processed_at: '2026-05-21T10:00:00.000Z',
    uuid: '11111111-1111-1111-1111-111111111115',
    session_id: 'session-5',
  }) as SDKMessage;

const makeBashToolProgressMessage = (): SDKMessage =>
  ({
    type: 'tool_progress',
    tool_use_id: 'tool-use-2',
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: 1.2,
    task_id: 'task-2',
    uuid: '11111111-1111-1111-1111-111111111116',
    session_id: 'session-6',
  }) as SDKMessage;

const makeToolUseSummaryMessage = (summary: string): SDKMessage =>
  ({
    type: 'tool_use_summary',
    summary,
    preceding_tool_use_ids: ['tool-use-2'],
    uuid: '11111111-1111-1111-1111-111111111117',
    session_id: 'session-7',
  }) as SDKMessage;

const makeApiRetryMessage = (
  overrides: {
    attempt?: number;
    max_retries?: number;
    error_status?: number | null;
    retry_delay_ms?: number;
  } = {}
): SDKMessage =>
  ({
    type: 'system',
    subtype: 'api_retry',
    attempt: overrides.attempt ?? 1,
    max_retries: overrides.max_retries ?? 3,
    error_status: 'error_status' in overrides ? overrides.error_status : 529,
    error: 'server_error' as const,
    retry_delay_ms: overrides.retry_delay_ms ?? 2000,
    uuid: '11111111-1111-1111-1111-111111111118',
    session_id: 'session-8',
  }) as SDKMessage;

const makeStatusMessage = (status: string | null): SDKMessage =>
  ({
    type: 'system',
    subtype: 'status',
    status,
    uuid: '11111111-1111-1111-1111-111111111119',
    session_id: 'session-9',
  }) as SDKMessage;

const makeRateLimitEventMessage = (): SDKMessage =>
  ({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed' as const },
    uuid: '11111111-1111-1111-1111-11111111111a',
    session_id: 'session-10',
  }) as SDKMessage;

const makeCompactBoundaryMessage = (): SDKMessage =>
  ({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger: 'auto',
      pre_tokens: 45000,
    },
    uuid: '11111111-1111-1111-1111-11111111111b',
    session_id: 'session-11',
  }) as SDKMessage;

const makeSessionStateChangedMessage = (state: 'idle' | 'running' | 'requires_action'): SDKMessage =>
  ({
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: '11111111-1111-1111-1111-11111111111c',
    session_id: 'session-12',
  }) as SDKMessage;

const makeSdkSession = (messages: SDKMessage[]) => {
  let messageIndex = 0;

  return {
    async* [Symbol.asyncIterator]() {
      while (messageIndex < messages.length) {
        yield messages[messageIndex++];
      }
    },
    close: jest.fn(),
  };
};

const makeParams = (repoDir = '/repo/primary', verificationScripts: VerificationScript[] = []) => ({
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
  repoFiles: [] as string[],
  repoName: 'primary',
  trackedFilePaths: [],
});

describe('AnthropicAgentAdapter', () => {
  beforeEach(() => {
    mockHomedir.mockReturnValue(path.join(os.tmpdir(), 'wf-home-default'));
    mockLoadAnthropicAgentSdk.mockResolvedValue({
      query: jest.fn().mockImplementation(() => makeSdkSession([makeResultSuccess()])),
    } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockLoadAnthropicAgentSdk.mockReset();
    mockHomedir.mockReset();
  });

  describe('formatProgressMessage', () => {
    it('formats task progress with the last tool label when present', () => {
      const message = {
        type: 'system',
        subtype: 'task_progress',
        summary: 'Inspecting verification output',
        description: 'Inspecting verification output',
        last_tool_name: 'Bash',
      } as SDKMessage;

      expect(formatProgressMessage(message)).toBe(
        '  [claude-agent-sdk] Task progress: Inspecting verification output · last tool: Bash'
      );
    });

    it('formats tool progress with elapsed time and task id', () => {
      const message = {
        type: 'tool_progress',
        tool_name: 'Write',
        elapsed_time_seconds: 2.4,
        task_id: 'task-1',
      } as SDKMessage;

      expect(formatProgressMessage(message)).toBe('  [claude-agent-sdk] Tool progress: Write (2.4s) · task: task-1');
    });

    it('formats api_retry with HTTP status and backoff delay', () => {
      expect(formatProgressMessage(makeApiRetryMessage())).toBe(
        '  [claude-agent-sdk] API retry: attempt 1/3 after HTTP 529 (2000ms backoff)'
      );
    });

    it('formats api_retry with null error_status as connection error', () => {
      expect(formatProgressMessage(makeApiRetryMessage({ error_status: null }))).toBe(
        '  [claude-agent-sdk] API retry: attempt 1/3 after connection error (2000ms backoff)'
      );
    });

    it('formats status with a non-null status string', () => {
      expect(formatProgressMessage(makeStatusMessage('compacting'))).toBe('  [claude-agent-sdk] Status: compacting');
    });

    it('returns null for status with null status value', () => {
      expect(formatProgressMessage(makeStatusMessage(null))).toBeNull();
    });

    it('formats rate_limit_event', () => {
      expect(formatProgressMessage(makeRateLimitEventMessage())).toBe('  [claude-agent-sdk] Rate limit: updated');
    });

    it('formats compact_boundary with trigger and token count', () => {
      expect(formatProgressMessage(makeCompactBoundaryMessage())).toBe(
        '  [claude-agent-sdk] Context compacted (auto, 45000 tokens before)'
      );
    });

    it('formats session_state_changed', () => {
      expect(formatProgressMessage(makeSessionStateChangedMessage('idle'))).toBe(
        '  [claude-agent-sdk] Session state: idle'
      );
      expect(formatProgressMessage(makeSessionStateChangedMessage('running'))).toBe(
        '  [claude-agent-sdk] Session state: running'
      );
    });
  });

  describe('formatActivityMessages', () => {
    it('formats file persistence and verification events into explicit logs', () => {
      const state = {};

      expect(formatActivityMessages(makeFilesPersistedMessage(), '/repo/primary', state)).toEqual([
        '  [claude-agent-sdk] File updated: src/foo.ts',
      ]);

      expect(
        formatActivityMessages(makeToolUseSummaryMessage('Ran `npm test` successfully.'), '/repo/primary', state)
      ).toEqual(['  [claude-agent-sdk] Verification passed: npm test']);
    });

    it('formats failed verification summaries', () => {
      const state = {};

      expect(
        formatActivityMessages(
          makeToolUseSummaryMessage('Ran `npm test` and it failed with exit code 1.'),
          '/repo/primary',
          state
        )
      ).toEqual(['  [claude-agent-sdk] Verification failed: npm test']);
    });
  });

  describe('detectMechanicalTask', () => {
    it('detects mechanical task from step language patterns', () => {
      const result = detectMechanicalTask({
        action: 'fix',
        summary: 'Migrate all loggers',
        steps: ['Replace every Logger with PinoLogger'],
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

    it('returns creative for small focused plans', () => {
      const result = detectMechanicalTask({
        action: 'feature',
        summary: 'Add auth module',
        steps: ['Design schema', 'Implement middleware', 'Add tests'],
        estimatedComplexity: 'high',
        affectedFiles: ['src/auth.ts', 'src/auth.spec.ts'],
      });
      expect(result.isMechanical).toBe(false);
    });
  });

  describe('model routing in generateAndVerify', () => {
    it('uses mechanical model when --model-routing=mechanical', async () => {
      const mockQuery = jest.fn().mockImplementation(() => makeSdkSession([makeResultSuccess()]));
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = {
        ...makeParams(),
        options: {
          ...makeParams().options,
          modelRouting: 'mechanical' as const,
        },
      };
      await adapter.generateAndVerify(params);

      const queryArgs = mockQuery.mock.calls[0][0];
      const options = queryArgs.options as { model: string };
      expect(options.model).toBe('claude-haiku-4-5-20251001');
    });

    it('uses default model when --model-routing=default', async () => {
      const mockSession = makeSdkSession([makeResultSuccess()]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = {
        ...makeParams(),
        options: {
          ...makeParams().options,
          modelRouting: 'default' as const,
        },
      };
      await adapter.generateAndVerify(params);

      const queryArgs = mockQuery.mock.calls[0][0];
      const options = queryArgs.options as { model: string };
      expect(options.model).toBe('claude-sonnet-4-6');
    });

    it('logs usage and cost from final result', async () => {
      const resultWithCost = makeResultSuccess();
      (resultWithCost as any).usage = {
        input_tokens: 5000,
        output_tokens: 2000,
        cache_read_input_tokens: 1500,
        cache_creation_input_tokens: null,
        server_tool_use: null,
        service_tier: null,
        cache_creation: null,
      };
      (resultWithCost as any).total_cost_usd = 0.0234;
      const mockSession = makeSdkSession([resultWithCost]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      await adapter.generateAndVerify(makeParams());

      const logCalls = consoleSpy.mock.calls.map(call => String(call[0]));
      expect(
        logCalls.some(
          message =>
            message.includes('Usage: 5000 input') && message.includes('1500 cached') && message.includes('2000 output')
        )
      ).toBe(true);
      expect(logCalls.some(message => message.includes('Cost:') && message.includes('$0.0234'))).toBe(true);
    });

    it('reads mechanical model from stages.implement.models.mechanical config', async () => {
      const mockQuery = jest.fn().mockImplementation(() => makeSdkSession([makeResultSuccess()]));
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const adapter = new AnthropicAgentAdapter(
        makeConfigService({
          'stages.implement.models': { mechanical: 'claude-haiku-custom' },
        })
      );
      const params = {
        ...makeParams(),
        options: {
          ...makeParams().options,
          modelRouting: 'mechanical' as const,
        },
      };
      await adapter.generateAndVerify(params);

      const queryArgs = mockQuery.mock.calls[0][0];
      const options = queryArgs.options as { model: string };
      expect(options.model).toBe('claude-haiku-custom');
    });

    it('throws when both model and models are configured', async () => {
      const mockSession = makeSdkSession([makeResultSuccess()]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      const adapter = new AnthropicAgentAdapter(
        makeConfigService({
          'stages.implement.model': 'claude-sonnet-4-6',
          'stages.implement.models': { mechanical: 'claude-haiku-custom' },
        })
      );

      await expect(adapter.generateAndVerify(makeParams())).rejects.toThrow(
        'stages.implement.model and stages.implement.models are mutually exclusive.'
      );
    });
  });

  describe('generateAndVerify', () => {
    it('invokes the Claude Agent SDK with repo-scoped access and the verification whitelist', async () => {
      const mockQuery = jest.fn().mockImplementation(() => makeSdkSession([makeResultSuccess()]));
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      await adapter.generateAndVerify({
        ...makeParams('/repo/primary', [
          {
            id: 'v1',
            name: 'build',
            command: 'npm test',
            policy: 'enforced',
            aliases: [],
          },
        ]),
        repoFiles: ['primary/src/foo.ts'],
        trackedFilePaths: ['primary/src/foo.ts'],
      });

      // Phase 1 call + incomplete-work loop iterations (mock sessions
      // never emit files_persisted so unvisited files trigger retries).
      expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(1);

      const queryArgs = mockQuery.mock.calls[0][0];
      const options = queryArgs.options as Record<string, unknown>;
      const systemPrompt = options.systemPrompt as {
        type: string;
        preset: string;
        append: string;
      };
      const sandbox = options.sandbox as {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        autoAllowBashIfSandboxed: boolean;
        filesystem: {
          allowRead: string[];
          allowWrite: string[];
        };
      };
      const settings = options.settings as { claudeMdExcludes: string[] };
      const canUseTool = options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        context: Record<string, unknown>
      ) => Promise<Record<string, unknown>>;
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});

      expect(options.cwd).toBe('/repo/primary');
      expect(options.model).toBe('claude-sonnet-4-6');
      expect(options.permissionMode).toBe('acceptEdits');
      expect(options.agentProgressSummaries).toBe(true);
      expect(options.tools).toEqual(
        expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'Task', 'Agent'])
      );
      expect(systemPrompt).toMatchObject({
        type: 'preset',
        preset: 'claude_code',
      });
      expect(systemPrompt.append).toContain('Repository directory: /repo/primary');
      expect(systemPrompt.append).not.toContain('npm test');
      expect(systemPrompt.append).not.toContain('src/foo.ts');
      const initialPrompt = (mockQuery.mock.calls[0][0] as { prompt: string }).prompt;
      expect(initialPrompt).toContain('npm test');
      expect(initialPrompt).toContain('src/foo.ts');
      expect(settings.claudeMdExcludes).toEqual(['/repo/primary/CLAUDE.md', '/repo/primary/.claude/CLAUDE.md']);
      expect(sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
      });
      expect(sandbox.filesystem.allowRead).toEqual(['/repo/primary', '/repo/shared']);
      expect(sandbox.filesystem.allowWrite).toEqual(['/repo/primary']);

      try {
        await expect(
          canUseTool('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 'tool-1' })
        ).resolves.toMatchObject({ behavior: 'allow' });

        await expect(
          canUseTool('Bash', { command: 'rm -rf /' }, { signal: new AbortController().signal, toolUseID: 'tool-2' })
        ).resolves.toMatchObject({
          behavior: 'deny',
          interrupt: true,
        });
      } finally {
        expect(mockLog.mock.calls.some(([message]) => String(message).includes('Verification running: npm test'))).toBe(
          true
        );
        expect(mockLog.mock.calls.some(([message]) => String(message).includes('Verification denied: rm -rf /'))).toBe(
          true
        );
        mockLog.mockRestore();
      }

      // Each query() call returns a fresh session; verify at least the
      // first one was closed.
      const firstSession = mockQuery.mock.results[0]?.value as {
        close: jest.Mock;
      };
      expect(firstSession.close).toHaveBeenCalledTimes(1);
    });

    it('sets autoCompactWindow in SDK settings', async () => {
      const mockSession = makeSdkSession([makeResultSuccess()]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      await adapter.generateAndVerify(makeParams());

      const queryArgs = mockQuery.mock.calls[0][0];
      const options = queryArgs.options as Record<string, unknown>;
      const settings = options.settings as {
        claudeMdExcludes: string[];
        autoCompactWindow: number;
      };
      expect(settings.autoCompactWindow).toBe(20000);
    });

    it('streams task and tool progress messages before the final result', async () => {
      const mockSession = makeSdkSession([
        makeTaskProgressMessage(),
        makeToolProgressMessage(),
        makeFilesPersistedMessage(),
        makeToolUseSummaryMessage('Ran `npm test` successfully.'),
        makeResultSuccess(),
      ]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        const adapter = new AnthropicAgentAdapter(makeConfigService());
        await adapter.generateAndVerify(makeParams());

        expect(
          mockLog.mock.calls.some(([message]) => String(message).includes('Task progress: Checking file boundaries'))
        ).toBe(true);
        expect(
          mockLog.mock.calls.some(([message]) => String(message).includes('Tool progress: Write (2.4s) · task: task-1'))
        ).toBe(true);
        expect(mockLog.mock.calls.some(([message]) => String(message).includes('File updated: src/foo.ts'))).toBe(true);
        expect(mockLog.mock.calls.some(([message]) => String(message).includes('Verification passed: npm test'))).toBe(
          true
        );
      } finally {
        mockLog.mockRestore();
      }
    });

    it('streams api_retry, status, rate_limit, compact, and session_state diagnostic messages', async () => {
      const mockSession = makeSdkSession([
        makeTaskProgressMessage(),
        makeApiRetryMessage(),
        makeStatusMessage('compacting'),
        makeRateLimitEventMessage(),
        makeCompactBoundaryMessage(),
        makeSessionStateChangedMessage('idle'),
        makeResultSuccess(),
      ]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        const adapter = new AnthropicAgentAdapter(makeConfigService());
        await adapter.generateAndVerify(makeParams());

        expect(
          mockLog.mock.calls.some(([message]) => String(message).includes('API retry: attempt 1/3 after HTTP 529'))
        ).toBe(true);
        expect(mockLog.mock.calls.some(([message]) => String(message).includes('Status: compacting'))).toBe(true);
        expect(mockLog.mock.calls.some(([message]) => String(message).includes('Rate limit: updated'))).toBe(true);
        expect(
          mockLog.mock.calls.some(([message]) =>
            String(message).includes('Context compacted (auto, 45000 tokens before)')
          )
        ).toBe(true);
        expect(mockLog.mock.calls.some(([message]) => String(message).includes('Session state: idle'))).toBe(true);
      } finally {
        mockLog.mockRestore();
      }
    });

    it('throws when the SDK returns an execution error', async () => {
      const mockSession = makeSdkSession([makeResultError()]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());

      await expect(adapter.generateAndVerify(makeParams())).rejects.toThrow('verification failed');

      expect(mockSession.close).toHaveBeenCalledTimes(1);
    });

    it('fails fast when the Anthropic API key is missing', async () => {
      const mockSession = makeSdkSession([makeResultSuccess()]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService({ 'ai.anthropicApiKey': '' }));

      await expect(adapter.generateAndVerify(makeParams())).rejects.toThrow(/requires `ai\.anthropicApiKey`/);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('includes global and repo CLAUDE.md content in the system prompt', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claude-'));
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-'));
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'global context line', 'utf-8');
      fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'repo context line', 'utf-8');

      mockHomedir.mockReturnValue(homeDir);
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});

      const mockSession = makeSdkSession([makeResultSuccess()]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      try {
        const adapter = new AnthropicAgentAdapter(makeConfigService());
        await adapter.generateAndVerify({
          ...makeParams(repoDir),
          conventionsSection: 'Repository conventions (primary):\n- Formatter: prettier (semi: false)',
        });

        const queryArgs = mockQuery.mock.calls[0][0];
        const options = queryArgs.options as Record<string, unknown>;
        const systemPrompt = options.systemPrompt as { append: string };

        expect(systemPrompt.append).toContain('Repo AI context:');
        expect(systemPrompt.append).toContain('Repository conventions (primary):');
        expect(systemPrompt.append).toContain('## ~/.claude/CLAUDE.md');
        expect(systemPrompt.append).toContain('global context line');
        expect(systemPrompt.append).toContain('## CLAUDE.md');
        expect(systemPrompt.append).toContain('repo context line');
        expect(mockLog).not.toHaveBeenCalledWith(expect.stringContaining('⚠'));
      } finally {
        mockLog.mockRestore();
        fs.rmSync(repoDir, { recursive: true, force: true });
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it('includes repo conventions in continuation prompts', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claude-continuation-'));
      const mockQuery = jest.fn().mockImplementation(() => makeSdkSession([makeResultSuccess()]));
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      await adapter.generateAndVerify({
        ...makeParams(repoDir),
        repoFiles: ['primary/src/foo.ts'],
        trackedFilePaths: ['primary/src/foo.ts'],
        conventionsSection: 'Repository conventions (primary):\n- Formatter: prettier (semi: false)',
      });

      expect(mockQuery.mock.calls[1][0].prompt).toContain('Repository conventions (primary):');
      expect(mockQuery.mock.calls[1][0].prompt).toContain('Formatter: prettier');
    });

    it('warns when the global CLAUDE.md is missing', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claude-'));
      fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'repo context line', 'utf-8');

      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-'));
      mockHomedir.mockReturnValue(homeDir);
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});
      const mockSession = makeSdkSession([makeResultSuccess()]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      try {
        const adapter = new AnthropicAgentAdapter(makeConfigService());
        await adapter.generateAndVerify(makeParams(repoDir));

        expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('⚠ Missing CLAUDE.md file at'));
      } finally {
        mockLog.mockRestore();
        fs.rmSync(repoDir, { recursive: true, force: true });
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });

  describe('incomplete-work loop stall detection', () => {
    const makeFilesPersistedFor = (filenames: string[]): SDKMessage =>
      ({
        type: 'system',
        subtype: 'files_persisted',
        files: filenames.map((f, i) => ({ filename: f, file_id: `file-${i}` })),
        failed: [],
        processed_at: '2026-06-09T10:00:00.000Z',
        uuid: '22222222-2222-2222-2222-222222222222',
        session_id: 'session-loop',
      }) as SDKMessage;

    it('skips loop when all planned files touched in initial pass', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const initialSession = makeSdkSession([
        makeFilesPersistedFor(['/repo/primary/src/foo.ts', '/repo/primary/src/bar.ts']),
        makeResultSuccess({ session_id: 'session-loop' }),
      ]);
      const mockQuery = jest.fn().mockReturnValueOnce(initialSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams();
      params.repoFiles = ['primary/src/foo.ts', 'primary/src/bar.ts'];

      await adapter.generateAndVerify(params);

      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('continues when workload decreases and completes', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const initialSession = makeSdkSession([
        makeFilesPersistedFor(['/repo/primary/src/foo.ts']),
        makeResultSuccess({ session_id: 'session-loop' }),
      ]);
      const pass1Session = makeSdkSession([
        makeFilesPersistedFor(['/repo/primary/src/bar.ts']),
        makeResultSuccess({ session_id: 'session-loop-2' }),
      ]);
      const mockQuery = jest.fn().mockReturnValueOnce(initialSession).mockReturnValueOnce(pass1Session);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams();
      params.repoFiles = ['primary/src/foo.ts', 'primary/src/bar.ts'];

      await adapter.generateAndVerify(params);

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('breaks after 2 non-improving passes', async () => {
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});

      const initialSession = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass1Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass2Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const mockQuery = jest
        .fn()
        .mockReturnValueOnce(initialSession)
        .mockReturnValueOnce(pass1Session)
        .mockReturnValueOnce(pass2Session);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams();
      params.repoFiles = ['primary/src/foo.ts'];

      await adapter.generateAndVerify(params);

      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Workload not decreasing'));
    });

    it('does not count idle pass toward stall budget', async () => {
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});

      const initialSession = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      // idle pass: num_turns = 1
      const idleSession = makeSdkSession([makeResultSuccess({ session_id: 'session-loop', num_turns: 1 })]);
      // two non-improving passes that exhaust the stall budget (threshold = 2 for 1-file plan)
      const pass2Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass3Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const mockQuery = jest
        .fn()
        .mockReturnValueOnce(initialSession)
        .mockReturnValueOnce(idleSession)
        .mockReturnValueOnce(pass2Session)
        .mockReturnValueOnce(pass3Session);
      mockLoadAnthropicAgentSdk.mockResolvedValue({ query: mockQuery } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams();
      params.repoFiles = ['primary/src/foo.ts'];

      await adapter.generateAndVerify(params);

      // initial + idle + 2 stall passes = 4 total (idle was skipped from stall budget)
      expect(mockQuery).toHaveBeenCalledTimes(4);
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Workload not decreasing'));
    });

    it('stops after 3 consecutive idle passes', async () => {
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});

      const initialSession = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const idle1 = makeSdkSession([makeResultSuccess({ session_id: 'session-loop', num_turns: 1 })]);
      const idle2 = makeSdkSession([makeResultSuccess({ session_id: 'session-loop', num_turns: 1 })]);
      const idle3 = makeSdkSession([makeResultSuccess({ session_id: 'session-loop', num_turns: 1 })]);
      const mockQuery = jest
        .fn()
        .mockReturnValueOnce(initialSession)
        .mockReturnValueOnce(idle1)
        .mockReturnValueOnce(idle2)
        .mockReturnValueOnce(idle3);
      mockLoadAnthropicAgentSdk.mockResolvedValue({ query: mockQuery } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams();
      params.repoFiles = ['primary/src/foo.ts'];

      await adapter.generateAndVerify(params);

      // initial + 3 idle passes = 4 total, then stopped by idle cap
      expect(mockQuery).toHaveBeenCalledTimes(4);
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('consecutive idle passes'));
    });

    it('logs diagnostic when pass produces no tool calls', async () => {
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});

      const initialSession = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const idleSession = makeSdkSession([makeResultSuccess({ session_id: 'session-loop', num_turns: 1, result: 'I could not find any files to edit.' })]);
      const pass2Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass3Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const mockQuery = jest
        .fn()
        .mockReturnValueOnce(initialSession)
        .mockReturnValueOnce(idleSession)
        .mockReturnValueOnce(pass2Session)
        .mockReturnValueOnce(pass3Session);
      mockLoadAnthropicAgentSdk.mockResolvedValue({ query: mockQuery } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams();
      params.repoFiles = ['primary/src/foo.ts'];

      await adapter.generateAndVerify(params);

      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('produced no tool calls (idle)'));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('I could not find any files to edit.'));
    });

    it('scales stall threshold with file count', async () => {
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});

      // 15 concrete files → threshold = Math.max(2, ceil(15/5)) = 3
      const repoFiles = Array.from({ length: 15 }, (_, i) => `primary/src/file${i}.ts`);
      const sessions = Array.from({ length: 5 }, () =>
        makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]),
      );
      const mockQuery = jest.fn();
      for (const session of sessions) mockQuery.mockReturnValueOnce(session);
      mockLoadAnthropicAgentSdk.mockResolvedValue({ query: mockQuery } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams();
      params.repoFiles = repoFiles;

      await adapter.generateAndVerify(params);

      // initial + 3 stall passes = 4 total (threshold = 3)
      expect(mockQuery).toHaveBeenCalledTimes(4);
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Workload not decreasing'));
    });

    it('includes progress summary in continuation prompt', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const initialSession = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass1Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass2Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const mockQuery = jest
        .fn()
        .mockReturnValueOnce(initialSession)
        .mockReturnValueOnce(pass1Session)
        .mockReturnValueOnce(pass2Session);
      mockLoadAnthropicAgentSdk.mockResolvedValue({ query: mockQuery } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams();
      params.repoFiles = ['primary/src/foo.ts'];

      await adapter.generateAndVerify(params);

      const secondCallPrompt = (mockQuery.mock.calls[1][0] as { prompt: string }).prompt;
      expect(secondCallPrompt).toContain('Progress: 0/1 files modified');
    });

    it('includes plan summary in continuation prompt', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const initialSession = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass1Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass2Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const mockQuery = jest
        .fn()
        .mockReturnValueOnce(initialSession)
        .mockReturnValueOnce(pass1Session)
        .mockReturnValueOnce(pass2Session);
      mockLoadAnthropicAgentSdk.mockResolvedValue({ query: mockQuery } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams();
      params.repoFiles = ['primary/src/foo.ts'];

      await adapter.generateAndVerify(params);

      const secondCallPrompt = (mockQuery.mock.calls[1][0] as { prompt: string }).prompt;
      expect(secondCallPrompt).toContain('Plan summary:');
    });

    it('includes verification commands in continuation prompt', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const initialSession = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass1Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass2Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const mockQuery = jest
        .fn()
        .mockReturnValueOnce(initialSession)
        .mockReturnValueOnce(pass1Session)
        .mockReturnValueOnce(pass2Session);
      mockLoadAnthropicAgentSdk.mockResolvedValue({ query: mockQuery } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams('/repo/primary', [
        { id: 'build', name: 'Build', command: 'yarn build', policy: 'enforced' as const, aliases: [] },
      ]);
      params.repoFiles = ['primary/src/foo.ts'];

      await adapter.generateAndVerify(params);

      const secondCallPrompt = (mockQuery.mock.calls[1][0] as { prompt: string }).prompt;
      expect(secondCallPrompt).toContain('yarn build');
    });

    it('resets stall counter on resumed improvement', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const initialSession = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass1Session = makeSdkSession([
        makeFilesPersistedFor(['/repo/primary/src/a.ts']),
        makeResultSuccess({ session_id: 'session-loop' }),
      ]);
      const pass2Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const pass3Session = makeSdkSession([makeResultSuccess({ session_id: 'session-loop' })]);
      const mockQuery = jest
        .fn()
        .mockReturnValueOnce(initialSession)
        .mockReturnValueOnce(pass1Session)
        .mockReturnValueOnce(pass2Session)
        .mockReturnValueOnce(pass3Session);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      const params = makeParams();
      params.repoFiles = ['primary/src/a.ts', 'primary/src/b.ts'];

      await adapter.generateAndVerify(params);

      expect(mockQuery).toHaveBeenCalledTimes(4);
    });
  });

  describe('buildSystemPrompt', () => {
    const baseArgs = {
      repoDir: '/tmp/repo-a',
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('contains role identity and repository directory', () => {
      const result = buildSystemPrompt(baseArgs);
      expect(result).toContain('You are an expert software engineer');
      expect(result).toContain('Repository directory: /tmp/repo-a');
    });

    it('contains implementer rules and summary template', () => {
      const result = buildSystemPrompt(baseArgs);
      expect(result).toContain('Writes must stay scoped to the primary repository');
      expect(result).toContain('### What I changed');
    });

    it('lists the Skill tool in the Available tools section', () => {
      const result = buildSystemPrompt(baseArgs);
      expect(result).toContain('- Skill(skill, args?): invoke a specialized skill');
    });

    it('does not contain ticket key', () => {
      const result = buildSystemPrompt(baseArgs);
      expect(result).not.toContain('Ticket key:');
    });

    it('does not contain plan summary', () => {
      const result = buildSystemPrompt(baseArgs);
      expect(result).not.toContain('Plan summary:');
    });

    it('does not contain "Files for context" when no contextFiles are passed', () => {
      const result = buildSystemPrompt(baseArgs);
      expect(result).not.toContain('Files for context');
    });

    it('does not contain "Files to implement"', () => {
      const result = buildSystemPrompt(baseArgs);
      expect(result).not.toContain('Files to implement:');
    });
  });
});
