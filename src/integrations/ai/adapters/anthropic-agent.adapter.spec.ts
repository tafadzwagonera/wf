// src/integrations/ai/adapters/anthropic-agent.adapter.spec.ts
import { ConfigService } from '@nestjs/config';
import {
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AnthropicAgentAdapter,
  formatActivityMessages,
  formatProgressMessage,
} from './anthropic-agent.adapter';
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

const mockLoadAnthropicAgentSdk = loadAnthropicAgentSdk as jest.MockedFunction<
  typeof loadAnthropicAgentSdk
>;
const mockHomedir = os.homedir as jest.MockedFunction<typeof os.homedir>;

const makeConfigService = (
  overrides: Record<string, unknown> = {},
): ConfigService => {
  const values: Record<string, unknown> = {
    'ai.anthropicApiKey': 'test-key',
    'ai.model': 'claude-sonnet-4-6',
    'stages.implement.afterImplement.absoluteMaxAttempts': 3,
    ...overrides,
  };

  return {
    get: jest.fn((key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
    ),
  } as unknown as ConfigService;
};

const makeResultSuccess = (
  overrides: Partial<SDKResultMessage> = {},
): SDKResultMessage =>
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

const makeResultError = (
  overrides: Partial<SDKResultMessage> = {},
): SDKResultMessage =>
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
  } = {},
): SDKMessage =>
  ({
    type: 'system',
    subtype: 'api_retry',
    attempt: overrides.attempt ?? 1,
    max_retries: overrides.max_retries ?? 3,
    error_status: 'error_status' in overrides ? overrides.error_status : 529,
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
    uuid: '11111111-1111-1111-1111-11111111111a',
    session_id: 'session-10',
  }) as SDKMessage;

const makeSdkSession = (messages: SDKMessage[]) => {
  let messageIndex = 0;

  return {
    async *[Symbol.asyncIterator]() {
      while (messageIndex < messages.length) {
        yield messages[messageIndex++];
      }
    },
    close: jest.fn(),
  };
};

const makeParams = (
  repoDir = '/repo/primary',
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

describe('AnthropicAgentAdapter', () => {
  beforeEach(() => {
    mockHomedir.mockReturnValue(path.join(os.tmpdir(), 'wf-home-default'));
    mockLoadAnthropicAgentSdk.mockResolvedValue({
      query: jest.fn(),
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
        '  [claude-agent-sdk] Task progress: Inspecting verification output · last tool: Bash',
      );
    });

    it('formats tool progress with elapsed time and task id', () => {
      const message = {
        type: 'tool_progress',
        tool_name: 'Write',
        elapsed_time_seconds: 2.4,
        task_id: 'task-1',
      } as SDKMessage;

      expect(formatProgressMessage(message)).toBe(
        '  [claude-agent-sdk] Tool progress: Write (2.4s) · task: task-1',
      );
    });

    it('formats api_retry with HTTP status and backoff delay', () => {
      expect(formatProgressMessage(makeApiRetryMessage())).toBe(
        '  [claude-agent-sdk] API retry: attempt 1/3 after HTTP 529 (2000ms backoff)',
      );
    });

    it('formats api_retry with null error_status as connection error', () => {
      expect(
        formatProgressMessage(makeApiRetryMessage({ error_status: null })),
      ).toBe(
        '  [claude-agent-sdk] API retry: attempt 1/3 after connection error (2000ms backoff)',
      );
    });

    it('formats status with a non-null status string', () => {
      expect(formatProgressMessage(makeStatusMessage('compacting'))).toBe(
        '  [claude-agent-sdk] Status: compacting',
      );
    });

    it('returns null for status with null status value', () => {
      expect(formatProgressMessage(makeStatusMessage(null))).toBeNull();
    });

    it('formats rate_limit_event', () => {
      expect(formatProgressMessage(makeRateLimitEventMessage())).toBe(
        '  [claude-agent-sdk] Rate limit: updated',
      );
    });
  });

  describe('formatActivityMessages', () => {
    it('formats file persistence and verification events into explicit logs', () => {
      const state = {};

      expect(
        formatActivityMessages(
          makeFilesPersistedMessage(),
          '/repo/primary',
          state,
        ),
      ).toEqual(['  [claude-agent-sdk] File updated: src/foo.ts']);

      expect(
        formatActivityMessages(
          makeToolUseSummaryMessage('Ran `npm test` successfully.'),
          '/repo/primary',
          state,
        ),
      ).toEqual(['  [claude-agent-sdk] Verification passed: npm test']);
    });

    it('formats failed verification summaries', () => {
      const state = {};

      expect(
        formatActivityMessages(
          makeToolUseSummaryMessage(
            'Ran `npm test` and it failed with exit code 1.',
          ),
          '/repo/primary',
          state,
        ),
      ).toEqual(['  [claude-agent-sdk] Verification failed: npm test']);
    });
  });

  describe('generateAndVerify', () => {
    it('invokes the Claude Agent SDK with repo-scoped access and the verification whitelist', async () => {
      const mockSession = makeSdkSession([makeResultSuccess()]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      await adapter.generateAndVerify(
        makeParams('/repo/primary', [
          {
            id: 'v1',
            name: 'build',
            command: 'npm test',
            policy: 'enforced',
            aliases: [],
          },
        ]),
      );

      expect(mockQuery).toHaveBeenCalledTimes(1);

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
        context: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});

      expect(options.cwd).toBe('/repo/primary');
      expect(options.model).toBe('claude-sonnet-4-6');
      expect(options.permissionMode).toBe('acceptEdits');
      expect(options.agentProgressSummaries).toBe(true);
      expect(options.tools).toEqual(
        expect.arrayContaining([
          'Read',
          'Write',
          'Edit',
          'Bash',
          'Glob',
          'Grep',
          'TodoWrite',
          'Task',
          'Agent',
        ]),
      );
      expect(systemPrompt).toMatchObject({
        type: 'preset',
        preset: 'claude_code',
      });
      expect(systemPrompt.append).toContain(
        'Repository directory: /repo/primary',
      );
      expect(systemPrompt.append).toContain('npm test');
      expect(systemPrompt.append).toContain('src/foo.ts');
      expect(settings.claudeMdExcludes).toEqual([
        '/repo/primary/CLAUDE.md',
        '/repo/primary/.claude/CLAUDE.md',
      ]);
      expect(sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
      });
      expect(sandbox.filesystem.allowRead).toEqual([
        '/repo/primary',
        '/repo/shared',
      ]);
      expect(sandbox.filesystem.allowWrite).toEqual(['/repo/primary']);

      try {
        await expect(
          canUseTool(
            'Bash',
            { command: 'npm test' },
            { signal: new AbortController().signal, toolUseID: 'tool-1' },
          ),
        ).resolves.toMatchObject({ behavior: 'allow' });

        await expect(
          canUseTool(
            'Bash',
            { command: 'rm -rf /' },
            { signal: new AbortController().signal, toolUseID: 'tool-2' },
          ),
        ).resolves.toMatchObject({
          behavior: 'deny',
          interrupt: true,
        });
      } finally {
        expect(
          mockLog.mock.calls.some(([message]) =>
            String(message).includes('Verification running: npm test'),
          ),
        ).toBe(true);
        expect(
          mockLog.mock.calls.some(([message]) =>
            String(message).includes('Verification denied: rm -rf /'),
          ),
        ).toBe(true);
        mockLog.mockRestore();
      }

      expect(mockSession.close).toHaveBeenCalledTimes(1);
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
          mockLog.mock.calls.some(([message]) =>
            String(message).includes('Task progress: Checking file boundaries'),
          ),
        ).toBe(true);
        expect(
          mockLog.mock.calls.some(([message]) =>
            String(message).includes(
              'Tool progress: Write (2.4s) · task: task-1',
            ),
          ),
        ).toBe(true);
        expect(
          mockLog.mock.calls.some(([message]) =>
            String(message).includes('File updated: src/foo.ts'),
          ),
        ).toBe(true);
        expect(
          mockLog.mock.calls.some(([message]) =>
            String(message).includes('Verification passed: npm test'),
          ),
        ).toBe(true);
      } finally {
        mockLog.mockRestore();
      }
    });

    it('streams api_retry, status, and rate_limit_event diagnostic messages', async () => {
      const mockSession = makeSdkSession([
        makeTaskProgressMessage(),
        makeApiRetryMessage(),
        makeStatusMessage('compacting'),
        makeRateLimitEventMessage(),
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
          mockLog.mock.calls.some(([message]) =>
            String(message).includes('API retry: attempt 1/3 after HTTP 529'),
          ),
        ).toBe(true);
        expect(
          mockLog.mock.calls.some(([message]) =>
            String(message).includes('Status: compacting'),
          ),
        ).toBe(true);
        expect(
          mockLog.mock.calls.some(([message]) =>
            String(message).includes('Rate limit: updated'),
          ),
        ).toBe(true);
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

      await expect(adapter.generateAndVerify(makeParams())).rejects.toThrow(
        'verification failed',
      );

      expect(mockSession.close).toHaveBeenCalledTimes(1);
    });

    it('fails fast when the Anthropic API key is missing', async () => {
      const mockSession = makeSdkSession([makeResultSuccess()]);
      const mockQuery = jest.fn().mockReturnValue(mockSession);
      mockLoadAnthropicAgentSdk.mockResolvedValue({
        query: mockQuery,
      } as never);

      const adapter = new AnthropicAgentAdapter(
        makeConfigService({ 'ai.anthropicApiKey': '' }),
      );

      await expect(adapter.generateAndVerify(makeParams())).rejects.toThrow(
        /requires `ai\.anthropicApiKey`/,
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('includes global and repo CLAUDE.md content in the system prompt', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claude-'));
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-'));
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, '.claude', 'CLAUDE.md'),
        'global context line',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(repoDir, 'CLAUDE.md'),
        'repo context line',
        'utf-8',
      );

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

        const queryArgs = mockQuery.mock.calls[0][0];
        const options = queryArgs.options as Record<string, unknown>;
        const systemPrompt = options.systemPrompt as { append: string };

        expect(systemPrompt.append).toContain('Repo AI context:');
        expect(systemPrompt.append).toContain('## ~/.claude/CLAUDE.md');
        expect(systemPrompt.append).toContain('global context line');
        expect(systemPrompt.append).toContain('## CLAUDE.md');
        expect(systemPrompt.append).toContain('repo context line');
        expect(mockLog).not.toHaveBeenCalledWith(expect.stringContaining('⚠️'));
      } finally {
        mockLog.mockRestore();
        fs.rmSync(repoDir, { recursive: true, force: true });
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it('warns when the global CLAUDE.md is missing', async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-claude-'));
      fs.writeFileSync(
        path.join(repoDir, 'CLAUDE.md'),
        'repo context line',
        'utf-8',
      );

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

        expect(mockLog).toHaveBeenCalledWith(
          expect.stringContaining('⚠️ Missing CLAUDE.md file at'),
        );
      } finally {
        mockLog.mockRestore();
        fs.rmSync(repoDir, { recursive: true, force: true });
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });
});
