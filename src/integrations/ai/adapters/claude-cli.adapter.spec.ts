import { ClaudeCliAdapter } from './claude-cli.adapter';
import * as cliRunner from './claude-cli-runner';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ __esModule: true }));
jest.mock('./claude-cli-runner');

const mockAssert = cliRunner.assertClaudeCliAvailable as jest.MockedFunction<typeof cliRunner.assertClaudeCliAvailable>;
const mockBuildCliArgs = cliRunner.buildCliArgs as jest.MockedFunction<typeof cliRunner.buildCliArgs>;
const mockSpawnCli = cliRunner.spawnCli as jest.MockedFunction<typeof cliRunner.spawnCli>;

const createMockConfigService = (overrides: Record<string, unknown> = {}) => ({
  get: jest.fn((key: string, fallback?: unknown) => {
    if (key in overrides) return overrides[key];
    if (key === 'ai.model') return 'claude-sonnet-4-6';
    return fallback;
  }),
});

describe('ClaudeCliAdapter', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockAssert.mockImplementation(() => undefined);
    mockBuildCliArgs.mockReturnValue(['-p', '--output-format', 'stream-json']);
  });

  it('asserts CLI availability before generating', async () => {
    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          result: 'done',
          session_id: 's1',
          num_turns: 1,
          total_cost_usd: 0.01,
        };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
      conventionsSection: 'Repository conventions (repo):\n- Formatter: prettier (semi: false)',
    });

    expect(mockAssert).toHaveBeenCalled();
    expect(mockBuildCliArgs.mock.calls[0][0].appendSystemPrompt).toContain('Repository conventions (repo):');
  });

  describe('errored result reporting', () => {
    const runWith = async (
      resultMessage: Record<string, unknown>,
      configOverrides: Record<string, unknown> = {}
    ) => {
      mockSpawnCli.mockReturnValue((async function* () {
        yield resultMessage as never;
      })());
      const adapter = new ClaudeCliAdapter(createMockConfigService(configOverrides) as any);
      return adapter.generateAndVerify({
        ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
        planArtifact: {
          plan: {
            action: 'feature', summary: 'test', steps: ['step 1'], estimatedComplexity: 'low',
            affectedFiles: [], affectedRepositories: [], risks: [],
          },
          action: 'feature',
          path: '/tmp/p.json',
        },
        options: { trackerName: 'jira', repoDir: '/repo' },
        verificationScripts: [],
        repoFiles: [],
        repoName: 'repo',
        trackedFilePaths: [],
        conventionsSection: 'conventions',
      } as never);
    };

    it('surfaces errors[] and terminal_reason instead of "unknown error"', async () => {
      await expect(runWith({
        type: 'result',
        is_error: true,
        subtype: 'error_during_execution',
        terminal_reason: 'aborted_tools',
        errors: ['tool execution aborted'],
        num_turns: 12,
      })).rejects.toThrow(/tool execution aborted.*terminal_reason=aborted_tools.*subtype=error_during_execution/);
    });

    it('names a max-turns failure that carries no result text', async () => {
      await expect(runWith({
        type: 'result', is_error: true, subtype: 'error_max_turns', num_turns: 40,
      })).rejects.toThrow(/subtype=error_max_turns \| turns=40/);
    });

    it('still falls back to "unknown error" when the CLI reports nothing at all', async () => {
      await expect(runWith({ type: 'result', is_error: true }))
        .rejects.toThrow('Claude CLI failed: unknown error');
    });

    it('prefers the result string when the CLI provides one', async () => {
      await expect(runWith({ type: 'result', is_error: true, result: 'explicit reason' }))
        .rejects.toThrow(/Claude CLI failed: explicit reason/);
    });
  });

  describe('implement stage timeouts', () => {
    const yieldOk = () => (async function* () {
      yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1 } as never;
    })();

    const generate = async (configOverrides: Record<string, unknown>) => {
      mockSpawnCli.mockImplementation(() => yieldOk());
      const adapter = new ClaudeCliAdapter(createMockConfigService(configOverrides) as any);
      await adapter.generateAndVerify({
        ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
        planArtifact: {
          plan: {
            action: 'feature', summary: 'test', steps: ['step 1'], estimatedComplexity: 'low',
            affectedFiles: [], affectedRepositories: [], risks: [],
          },
          action: 'feature',
          path: '/tmp/p.json',
        },
        options: { trackerName: 'jira', repoDir: '/repo' },
        verificationScripts: [],
        repoFiles: [],
        repoName: 'repo',
        trackedFilePaths: [],
        conventionsSection: 'conventions',
      } as never);
    };

    it('forwards configured implement timeouts to spawnCli', async () => {
      await generate({ 'stages.implement.timeoutMs': 1800000, 'stages.implement.inactivityTimeoutMs': 600000 });
      expect(mockSpawnCli.mock.calls[0][4]).toBe(1800000);
      expect(mockSpawnCli.mock.calls[0][5]).toBe(600000);
    });

    it('falls back to runner defaults when implement timeouts are unset', async () => {
      await generate({});
      expect(mockSpawnCli.mock.calls[0][4]).toBe(cliRunner.CLI_TIMEOUT_MS);
      expect(mockSpawnCli.mock.calls[0][5]).toBe(cliRunner.CLI_INACTIVITY_TIMEOUT_MS);
    });
  });

  it('includes task brief in continuation prompts', async () => {
    const mockStream = (sid?: string) =>
      (async function* () {
        yield { type: 'result', result: 'done', session_id: sid, num_turns: 1, total_cost_usd: 0.01 };
      })();

    mockSpawnCli
      .mockReturnValueOnce(mockStream('s1'))
      .mockReturnValueOnce(mockStream('s1'))
      .mockImplementation(() => mockStream(undefined));

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: ['repo/src/app.ts'],
      repoName: 'repo',
      trackedFilePaths: ['repo/src/app.ts'],
      conventionsSection: 'Repository conventions (repo):\n- Formatter: prettier (semi: false)',
    });

    const continuationPrompt = mockBuildCliArgs.mock.calls[1][0].prompt;
    expect(continuationPrompt).toContain('Ticket key: TEST-1');
    expect(continuationPrompt).toContain('Plan summary:');
    expect(continuationPrompt).not.toContain('Repository conventions (repo):');
  });

  it('includes progress, goal, plan steps, and verification in continuation prompts', async () => {
    const mockStream = (sid?: string) =>
      (async function* () {
        yield { type: 'result', result: 'done', session_id: sid, num_turns: 1, total_cost_usd: 0.01 };
      })();

    mockSpawnCli
      .mockReturnValueOnce(mockStream('s1'))
      .mockReturnValueOnce(mockStream('s1'))
      .mockImplementation(() => mockStream(undefined));

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'Add caching layer',
          steps: ['Create cache service', 'Wire into controller'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [{ id: 'build', name: 'build', command: 'yarn build', policy: 'enforced', aliases: [] }],
      repoFiles: ['repo/src/cache.ts'],
      repoName: 'repo',
      trackedFilePaths: ['repo/src/cache.ts'],
    });

    const prompt = mockBuildCliArgs.mock.calls[1][0].prompt;
    expect(prompt).toContain('Progress: 0/1 files modified (pass 1)');
    expect(prompt).toContain('Plan summary:');
    expect(prompt).toContain('Add caching layer');
    expect(prompt).toContain('1. Create cache service');
    expect(prompt).toContain('2. Wire into controller');
    expect(prompt).toContain('Verification commands:');
    expect(prompt).toContain('yarn build');
  });

  it('logs file activity from CLI assistant messages', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Edit',
                input: { file_path: '/repo/src/app.ts' },
              },
            ],
          },
        };
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'npm test' },
              },
            ],
          },
        };
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                content: 'Tests passed successfully',
                is_error: false,
              },
            ],
          },
        };
        yield {
          type: 'result',
          result: 'done',
          session_id: 's1',
          num_turns: 3,
          total_cost_usd: 0.05,
        };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
    });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(l => /File updated.*src\/app\.ts/.test(l))).toBe(true);
    expect(logCalls.some(l => /Verification running.*npm test/.test(l))).toBe(true);
    // npm test does not match any configured verificationScript, so no pass/fail is logged

    consoleSpy.mockRestore();
  });

  it('logs session ID when present in result', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          result: 'done',
          session_id: 'abc-123-session',
          num_turns: 1,
          total_cost_usd: 0.01,
        };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
    });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(l => /Provider session:.*abc-123-session/.test(l))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('does not log session ID when absent from result', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          result: 'done',
          num_turns: 1,
          total_cost_usd: 0.01,
        };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
    });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(l => /Session:/.test(l))).toBe(false);

    consoleSpy.mockRestore();
  });

  it('throws when CLI reports an error result', async () => {
    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          result: 'something failed',
          is_error: true,
        };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await expect(
      adapter.generateAndVerify({
        ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
        planArtifact: {
          plan: {
            action: 'feature',
            summary: 'test',
            steps: [],
            estimatedComplexity: 'low',
            affectedFiles: [],
            affectedRepositories: [],
            risks: [],
          },
          action: 'feature',
          path: '/tmp/p.json',
        },
        options: { trackerName: 'jira', repoDir: '/repo' },
        verificationScripts: [],
        repoFiles: [],
        repoName: 'repo',
        trackedFilePaths: [],
      })
    ).rejects.toThrow(/Claude CLI failed/);
  });

  it('logs Skill tool usage from task_progress events', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield {
          type: 'system',
          subtype: 'task_progress',
          summary: 'Invoking plan-quality skill',
          description: 'Invoking plan-quality skill',
          last_tool_name: 'Skill',
        };
        yield {
          type: 'result',
          result: 'done',
          session_id: 's1',
          num_turns: 1,
          total_cost_usd: 0.01,
        };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
    });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(l => /Skill:.*plan-quality/.test(l))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('logs Skill from assistant tool_use blocks', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Skill',
                input: { skill: 'plan-quality' },
              },
            ],
          },
        };
        yield {
          type: 'result',
          result: 'done',
          session_id: 's1',
          num_turns: 1,
          total_cost_usd: 0.01,
        };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
    });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(l => /Skill:.*plan-quality/.test(l))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('does not log Skill from assistant tool_use when skill name is missing', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Skill',
                input: {},
              },
            ],
          },
        };
        yield {
          type: 'result',
          result: 'done',
          session_id: 's1',
          num_turns: 1,
          total_cost_usd: 0.01,
        };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
    });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(l => /Skill:/.test(l))).toBe(false);

    consoleSpy.mockRestore();
  });

  it('does not log Skill when summary is empty', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield {
          type: 'system',
          subtype: 'task_progress',
          summary: '',
          description: '',
          last_tool_name: 'Skill',
        };
        yield {
          type: 'result',
          result: 'done',
          session_id: 's1',
          num_turns: 1,
          total_cost_usd: 0.01,
        };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
    });

    const logCalls = consoleSpy.mock.calls.map(c => String(c[0]));
    expect(logCalls.some(l => /Skill:/.test(l))).toBe(false);

    consoleSpy.mockRestore();
  });
});
