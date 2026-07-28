import { ClaudeCliAdapter } from './claude-cli.adapter';
import * as cliRunner from './claude-cli-runner';

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
    jest.clearAllMocks();
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
    });

    expect(mockAssert).toHaveBeenCalled();
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
