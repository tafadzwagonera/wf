// src/integrations/ai/adapters/anthropic-agent.adapter.spec.ts
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import * as path from 'path';
import { AnthropicAgentAdapter } from './anthropic-agent.adapter';
import type { VerificationScript } from '../../../agents/interfaces';

// ── Helpers ───────────────────────────────────────────────────────────────

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

const makeToolUseResponse = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolId = 'tool_1',
): Anthropic.Message =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    content: [
      { type: 'tool_use', id: toolId, name: toolName, input: toolInput },
    ],
  }) as unknown as Anthropic.Message;

const makeEndTurnResponse = (): Anthropic.Message =>
  ({
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'text', text: 'Done.' }],
  }) as unknown as Anthropic.Message;

/** Minimal params for generateAndVerify. repoDir defaults to /repo/primary. */
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
  options: { platformName: 'jira', repoDir },
  verificationScripts,
  sceneContext: 'implement it',
  repoFiles: [],
  repoName: 'primary',
  trackedFilePaths: [],
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('AnthropicAgentAdapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('sandbox enforcement (path resolver logic)', () => {
    it('allows read_file within repoDir', () => {
      const repoDir = '/tmp/repo-a';
      const allReadRoots = [repoDir];
      const validPath = '/tmp/repo-a/src/foo.ts';
      const inAnyRoot = allReadRoots.some(
        (root) => !path.relative(root, validPath).startsWith('..'),
      );
      expect(inAnyRoot).toBe(true);
    });

    it('throws on read_file path escape', () => {
      const repoDir = '/tmp/repo-a';
      const additionalRepoDirs: string[] = [];

      const resolveReadPath = (rawPath: string): string => {
        const abs = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(repoDir, rawPath);
        const allReadRoots = [repoDir, ...additionalRepoDirs];
        const inAnyRoot = allReadRoots.some(
          (root) => !path.relative(root, abs).startsWith('..'),
        );
        if (!inAnyRoot) {
          throw new Error(
            `read_file path-escape: "${rawPath}" is outside all known repo roots.`,
          );
        }
        return abs;
      };

      expect(() => resolveReadPath('/etc/passwd')).toThrow('path-escape');
      expect(() => resolveReadPath('../../../etc/shadow')).toThrow(
        'path-escape',
      );
    });

    it('throws on write_file path escape', () => {
      const repoDir = '/tmp/repo-a';

      const resolveWritePath = (rawPath: string): string => {
        const abs = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(repoDir, rawPath);
        if (path.relative(repoDir, abs).startsWith('..')) {
          throw new Error(
            `write_file write-boundary: "${rawPath}" is outside repoDir "${repoDir}".`,
          );
        }
        return abs;
      };

      expect(() => resolveWritePath('../other-repo/file.ts')).toThrow(
        'write-boundary',
      );
      expect(() => resolveWritePath('/etc/crontab')).toThrow('write-boundary');
    });

    it('does not throw for write within repoDir', () => {
      const repoDir = '/tmp/repo-a';

      const resolveWritePath = (rawPath: string): string => {
        const abs = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(repoDir, rawPath);
        if (path.relative(repoDir, abs).startsWith('..')) {
          throw new Error(
            `write_file write-boundary: "${rawPath}" is outside repoDir "${repoDir}".`,
          );
        }
        return abs;
      };

      expect(() => resolveWritePath('src/foo.ts')).not.toThrow();
      expect(resolveWritePath('src/foo.ts')).toBe('/tmp/repo-a/src/foo.ts');
    });

    it('allows read from additionalRepoDirs', () => {
      const repoDir = '/tmp/repo-a';
      const additionalRepoDirs = ['/tmp/repo-b'];

      const resolveReadPath = (rawPath: string): string => {
        const abs = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(repoDir, rawPath);
        const allReadRoots = [repoDir, ...additionalRepoDirs];
        const inAnyRoot = allReadRoots.some(
          (root) => !path.relative(root, abs).startsWith('..'),
        );
        if (!inAnyRoot) {
          throw new Error(
            `read_file path-escape: "${rawPath}" is outside all known repo roots.`,
          );
        }
        return abs;
      };

      expect(() => resolveReadPath('/tmp/repo-b/src/types.ts')).not.toThrow();
    });
  });

  describe('generateAndVerify', () => {
    it('delegates to anthropic client and completes when stop_reason is end_turn', async () => {
      const mockCreate = jest.fn().mockResolvedValue(makeEndTurnResponse());

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      (adapter as any).client = { messages: { create: mockCreate } };

      jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);

      const result = await adapter.generateAndVerify(makeParams());

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined();
    });

    it('stops after absoluteMaxAttempts turns', async () => {
      let callCount = 0;
      const mockCreate = jest.fn().mockImplementation(async () => {
        callCount++;
        return makeToolUseResponse(
          'read_file',
          { path: 'nonexistent.ts' },
          `tool-${callCount}`,
        );
      });

      const adapter = new AnthropicAgentAdapter(
        makeConfigService({
          'stages.implement.afterImplement.absoluteMaxAttempts': 3,
        }),
      );
      (adapter as any).client = { messages: { create: mockCreate } };

      jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);

      await adapter.generateAndVerify(makeParams());

      expect(mockCreate).toHaveBeenCalledTimes(3);
    });

    it('read_file outside sandbox returns path-escape error as tool result', async () => {
      const repoDir = '/repo/primary';
      const mockCreate = jest
        .fn()
        .mockResolvedValueOnce(
          makeToolUseResponse('read_file', { path: '../../../etc/passwd' }),
        )
        .mockResolvedValueOnce(makeEndTurnResponse());

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      (adapter as any).client = { messages: { create: mockCreate } };

      await adapter.generateAndVerify(makeParams(repoDir));

      // Second call carries the tool_result; find the last user message
      const secondCallMessages = mockCreate.mock.calls[1][0].messages;
      const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
      const toolResults: Array<{ content: string }> = lastUserMsg.content;

      expect(toolResults[0].content).toMatch(/path-escape/);
    });

    it('write_file outside repoDir returns write-boundary error as tool result', async () => {
      const repoDir = '/repo/primary';
      const mockCreate = jest
        .fn()
        .mockResolvedValueOnce(
          makeToolUseResponse('write_file', {
            path: '/other-repo/src/file.ts',
            content: 'x',
          }),
        )
        .mockResolvedValueOnce(makeEndTurnResponse());

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      (adapter as any).client = { messages: { create: mockCreate } };

      await adapter.generateAndVerify(makeParams(repoDir));

      const secondCallMessages = mockCreate.mock.calls[1][0].messages;
      const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
      const toolResults: Array<{ content: string }> = lastUserMsg.content;

      expect(toolResults[0].content).toMatch(/write-boundary/);
    });

    it('run_command blocked when not in whitelist returns blocked error as tool result', async () => {
      const repoDir = '/repo/primary';
      const mockCreate = jest
        .fn()
        .mockResolvedValueOnce(
          makeToolUseResponse('run_command', { command: 'rm -rf /' }),
        )
        .mockResolvedValueOnce(makeEndTurnResponse());

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      (adapter as any).client = { messages: { create: mockCreate } };

      await adapter.generateAndVerify(makeParams(repoDir));

      const secondCallMessages = mockCreate.mock.calls[1][0].messages;
      const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
      const toolResults: Array<{ content: string }> = lastUserMsg.content;

      expect(toolResults[0].content).toMatch(/blocked/);
    });

    it('run_command allowed when in whitelist does not return a blocked error', async () => {
      const repoDir = '/repo/primary';
      const verificationScripts: VerificationScript[] = [
        {
          id: 'v1',
          name: 'build',
          command: 'echo ok',
          policy: 'enforced',
          aliases: [],
        },
      ];

      const mockCreate = jest
        .fn()
        .mockResolvedValueOnce(
          makeToolUseResponse('run_command', { command: 'echo ok' }),
        )
        .mockResolvedValueOnce(makeEndTurnResponse());

      const adapter = new AnthropicAgentAdapter(makeConfigService());
      (adapter as any).client = { messages: { create: mockCreate } };

      await adapter.generateAndVerify(makeParams(repoDir, verificationScripts));

      const secondCallMessages = mockCreate.mock.calls[1][0].messages;
      const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
      const toolResults: Array<{ content: string }> = lastUserMsg.content;

      expect(toolResults[0].content).not.toMatch(/blocked/);
    });
  });
});
