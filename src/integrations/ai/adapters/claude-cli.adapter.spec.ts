import { ClaudeCliAdapter } from './claude-cli.adapter';
import * as cliRunner from './claude-cli-runner';
import * as skillContent from '../../../skills/skill-content';
import { STALL_THRESHOLD, runProgrammaticVerification } from './verification-report';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ __esModule: true }));
jest.mock('./claude-cli-runner');
jest.mock('./verification-report', () => ({
  ...jest.requireActual<typeof import('./verification-report')>('./verification-report'),
  runProgrammaticVerification: jest.fn(),
}));

const mockAssert = cliRunner.assertClaudeCliAvailable as jest.MockedFunction<typeof cliRunner.assertClaudeCliAvailable>;
const mockBuildCliArgs = cliRunner.buildCliArgs as jest.MockedFunction<typeof cliRunner.buildCliArgs>;
const mockBuildClaudeStdinPrompt
  = cliRunner.buildClaudeStdinPrompt as jest.MockedFunction<typeof cliRunner.buildClaudeStdinPrompt>;
const mockRunProgrammaticVerification = runProgrammaticVerification as jest.MockedFunction<
  typeof runProgrammaticVerification
>;
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
    mockRunProgrammaticVerification.mockImplementation(
      jest.requireActual<typeof import('./verification-report')>('./verification-report').runProgrammaticVerification,
    );
    mockAssert.mockImplementation(() => undefined);
    mockBuildCliArgs.mockReturnValue(['-p', '--output-format', 'stream-json']);
    mockBuildClaudeStdinPrompt.mockImplementation(
      jest.requireActual<typeof import('./claude-cli-runner')>('./claude-cli-runner').buildClaudeStdinPrompt,
    );
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
          steps: [{ description: 'step 1' }],
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

  it('logs completion with the Agent completed wording shared by the agent adapters', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1, total_cost_usd: 0.01 };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: [{ description: 'step 1' }],
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

    const lines = logSpy.mock.calls.map(([message]) => String(message));
    expect(lines).toContain('  [claude-cli] Agent completed in 1 turn(s).');
    logSpy.mockRestore();
  });

  it('renders object plan risks with severity prefixes in the task brief', async () => {
    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1, total_cost_usd: 0.01 };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: [{ description: 'step 1' }],
          estimatedComplexity: 'high',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [{ description: 'Shared module change', severity: 'high' }],
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

    expect(mockSpawnCli.mock.calls[0][2]).toContain('[high] Shared module change');
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
            action: 'feature', summary: 'test', steps: [{ description: 'step 1' }], estimatedComplexity: 'low',
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
            action: 'feature', summary: 'test', steps: [{ description: 'step 1' }], estimatedComplexity: 'low',
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

  describe('implement stage stall threshold', () => {
    const makeState = (readOnly: number) => ({
      outcomes: [], codeFailures: [{}], sessionId: 's1',
      prevFails: Infinity, stalled: 0, readOnly, passNumber: 1, exhausted: false,
    });

    it('resolves stages.implement.stallThresholdForVerificationFix from config', () => {
      const adapter = new ClaudeCliAdapter(createMockConfigService({ 'stages.implement.stallThresholdForVerificationFix': 5 }) as any);
      expect((adapter as any).resolveStallThreshold()).toBe(5);
    });

    it('falls back to STALL_THRESHOLD when stallThresholdForVerificationFix is unset', () => {
      const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
      expect((adapter as any).resolveStallThreshold()).toBe(STALL_THRESHOLD);
    });

    it('gates fix iterations on the configured cap instead of the hardcoded default', () => {
      const adapter = new ClaudeCliAdapter(createMockConfigService({ 'stages.implement.stallThresholdForVerificationFix': 4 }) as any);
      expect((adapter as any).shouldRunFixIteration(makeState(3))).toBe(true);
      expect((adapter as any).shouldRunFixIteration(makeState(4))).toBe(false);
    });

    it('scales the continuation stall threshold with the planned file count', async () => {
      const mockStream = () =>
        (async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/repo/src/extra.ts' } }] },
          };
          yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1, total_cost_usd: 0.01 };
        })();
      mockSpawnCli.mockImplementation(() => mockStream());

      const repoFiles = Array.from({ length: 20 }, (_, i) => `repo/src/file-${i}.ts`);
      const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
      await adapter.generateAndVerify({
        ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
        planArtifact: {
          plan: {
            action: 'feature',
            summary: 'test',
            steps: [{ description: 'step 1' }],
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
        repoFiles,
        repoName: 'repo',
        trackedFilePaths: repoFiles,
      });

      expect(mockSpawnCli).toHaveBeenCalledTimes(5);
    });
  });

  describe('implement continuation no-op cutoff', () => {
    const resultOnly = (result = 'done') => (async function* () {
      yield { type: 'result', result, session_id: 's1', num_turns: 1 } as never;
    })();

    const writeThenResult = (file: string) => (async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `/repo/${file}` } }] },
      } as never;
      yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1 } as never;
    })();

    const run = async (fileCount: number) => {
      const repoFiles = Array.from({ length: fileCount }, (_, i) => i === 0 ? 'repo/src/app.ts' : `repo/src/file-${i}.ts`);
      const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
      await adapter.generateAndVerify({
        ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
        planArtifact: {
          plan: {
            action: 'feature', summary: 'test', steps: [{ description: 'step 1' }], estimatedComplexity: 'low',
            affectedFiles: [], affectedRepositories: [], risks: [],
          },
          action: 'feature',
          path: '/tmp/p.json',
        },
        options: { trackerName: 'jira', repoDir: '/repo' },
        verificationScripts: [],
        repoFiles,
        repoName: 'repo',
        trackedFilePaths: repoFiles,
      } as never);
    };

    const loggedLines = (spy: jest.SpyInstance): string[] => spy.mock.calls.map(([line]) => String(line));

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('stops after two consecutive passes with no file changes', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockSpawnCli.mockImplementation(() => resultOnly());

      await run(40);

      expect(mockSpawnCli).toHaveBeenCalledTimes(3);
      expect(loggedLines(logSpy).some(line => line.includes('No file changes across 2 passes — stopping'))).toBe(true);
    });

    it('resets the no-op counter when a pass writes a file', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
      mockSpawnCli
        .mockImplementationOnce(() => resultOnly())
        .mockImplementationOnce(() => resultOnly())
        .mockImplementationOnce(() => writeThenResult('src/extra.ts'))
        .mockImplementation(() => resultOnly());

      await run(40);

      expect(mockSpawnCli).toHaveBeenCalledTimes(5);
    });

    it('accepts a NO-CHANGE declaration as progress and reports it in the summary', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockSpawnCli
        .mockImplementationOnce(() => resultOnly())
        .mockImplementationOnce(() => resultOnly('All good.\nNO-CHANGE: src/app.ts'))
        .mockImplementation(() => resultOnly());

      await run(1);

      expect(mockSpawnCli).toHaveBeenCalledTimes(2);
      expect(loggedLines(logSpy)).toContain('    - no change required (agent-declared): src/app.ts');
    });

    it('reports a declared-and-edited file as updated only', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockSpawnCli
        .mockImplementationOnce(() => resultOnly())
        .mockImplementationOnce(() => (async function* () {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/app.ts' } }] },
          } as never;
          yield { type: 'result', result: 'NO-CHANGE: src/app.ts', session_id: 's1', num_turns: 1 } as never;
        })())
        .mockImplementation(() => resultOnly());

      await run(1);

      const lines = loggedLines(logSpy);
      expect(lines).toContain('    - updated: src/app.ts');
      expect(lines).not.toContain('    - no change required (agent-declared): src/app.ts');
    });

    it('tells the agent it may declare NO-CHANGE in continuation prompts', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
      mockSpawnCli.mockImplementation(() => resultOnly());

      await run(1);

      expect(mockBuildCliArgs.mock.calls[1][0].prompt).toContain('NO-CHANGE: <path>');
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
          steps: [{ description: 'step 1' }],
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
          steps: [{ description: 'Create cache service' }, { description: 'Wire into controller' }],
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
          steps: [{ description: 'step 1' }],
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
          steps: [{ description: 'step 1' }],
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
          steps: [{ description: 'step 1' }],
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
    expect(logCalls.filter(l => /Session:/.test(l))).toEqual([]);

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
          steps: [{ description: 'step 1' }],
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
          steps: [{ description: 'step 1' }],
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
          steps: [{ description: 'step 1' }],
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
    expect(logCalls.filter(l => /Skill:/.test(l))).toEqual([]);

    consoleSpy.mockRestore();
  });

  it('uses initialPromptOverride as the prompt when set', async () => {
    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1 } as never;
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature', summary: 'test', steps: [{ description: 'step 1' }], estimatedComplexity: 'low',
          affectedFiles: [], affectedRepositories: [], risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo', initialPromptOverride: 'custom override' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
      conventionsSection: 'conventions',
    } as never);

    expect(mockBuildCliArgs.mock.calls[0][0].prompt).toBe('custom override');
  });

  it('keeps the skill fragment on the initialPromptOverride turn', async () => {
    const fragment = '\n\n## Skill: test-driven-development\nContent';
    jest.spyOn(skillContent, 'buildSkillPromptFragment').mockResolvedValue(fragment);
    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1 } as never;
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature', summary: 'test', steps: [{ description: 'step 1' }], estimatedComplexity: 'low',
          affectedFiles: [], affectedRepositories: [], risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo', initialPromptOverride: 'custom override' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
      conventionsSection: 'conventions',
      skillNames: ['test-driven-development'],
    } as never);

    expect(mockBuildCliArgs.mock.calls[0][0].prompt).toBe(`custom override${fragment}`);
  });

  it('includes the skill fragment in the verification fix-pass prompt', async () => {
    const fragment = '\n\n## Skill: test-driven-development\nContent';
    jest.spyOn(skillContent, 'buildSkillPromptFragment').mockResolvedValue(fragment);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockRunProgrammaticVerification
      .mockResolvedValueOnce([{ id: 'lint', command: 'yarn lint', policy: 'enforced', status: 'failed', output: 'lint error' }] as never)
      .mockResolvedValueOnce([{ id: 'lint', command: 'yarn lint', policy: 'enforced', status: 'passed' }] as never);
    let streamCount = 0;
    mockSpawnCli.mockImplementation(() => {
      const filename = `file-${streamCount++}.ts`;
      return (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `/repo/${filename}` } }] },
        } as never;
        yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1 } as never;
      })();
    });

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature', summary: 'test', steps: [{ description: 'step 1' }], estimatedComplexity: 'low',
          affectedFiles: [], affectedRepositories: [], risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [{ id: 'lint', command: 'yarn lint', policy: 'enforced' }],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
      conventionsSection: 'conventions',
      skillNames: ['test-driven-development'],
    } as never);

    const prompts = mockBuildCliArgs.mock.calls.map(([args]) => args.prompt);
    const fixPrompt = prompts.find(prompt => prompt?.includes('enforced verification commands failed'));
    expect(fixPrompt).toContain('## Skill: test-driven-development');
    expect(mockRunProgrammaticVerification).toHaveBeenCalledTimes(2);
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
          steps: [{ description: 'step 1' }],
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
    expect(logCalls.filter(l => /Skill:/.test(l))).toEqual([]);

    consoleSpy.mockRestore();
  });

  it('appends screenshot paths to the implement prompt when uiDesignScreenshotPaths provided', async () => {
    mockSpawnCli.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1, total_cost_usd: 0 };
      })()
    );

    const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: { action: 'fix', summary: 'test', steps: [{ description: 'step 1' }], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] },
        action: 'fix', path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
      uiDesignScreenshotPaths: ['/tmp/design.png'],
    });

    expect(mockBuildCliArgs.mock.calls[0][0].screenshots).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/tmp/design.png' })])
    );
    expect(mockSpawnCli.mock.calls[0][2]).toContain('Design screenshots (accessible via filesystem):');
    expect(mockSpawnCli.mock.calls[0][2]).toContain('- /tmp/design.png');
  });

  describe('continuation pass design screenshots', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const runWithScreenshots = async (uiDesignScreenshotPaths?: string[]) => {
      const mockStream = (sid?: string) =>
        (async function* () {
          yield { type: 'result', result: 'done', session_id: sid, num_turns: 1, total_cost_usd: 0.01 };
        })();
      mockSpawnCli
        .mockReturnValueOnce(mockStream('s1'))
        .mockReturnValueOnce(mockStream('s1'))
        .mockImplementation(() => mockStream(undefined));
      jest.spyOn(console, 'log').mockImplementation(() => {});

      const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
      await adapter.generateAndVerify({
        ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
        planArtifact: {
          plan: {
            action: 'feature', summary: 'test', steps: [{ description: 'step 1' }], estimatedComplexity: 'low',
            affectedFiles: [], affectedRepositories: [], risks: [],
          },
          action: 'feature', path: '/tmp/p.json',
        },
        options: { trackerName: 'jira', repoDir: '/repo' },
        verificationScripts: [],
        repoFiles: ['repo/src/app.ts'],
        repoName: 'repo',
        trackedFilePaths: ['repo/src/app.ts'],
        uiDesignScreenshotPaths,
      });
    };

    it('keeps screenshot directories and adds a one-line reminder on continuation passes', async () => {
      await runWithScreenshots(['/designs/a.png', '/designs/b.png']);

      expect(mockBuildCliArgs.mock.calls.length).toBeGreaterThanOrEqual(2);
      const firstPass = mockBuildCliArgs.mock.calls[0][0];
      const continuation = mockBuildCliArgs.mock.calls[1][0];
      expect(firstPass.screenshots?.map((s: { path: string }) => s.path)).toEqual(['/designs/a.png', '/designs/b.png']);
      expect(continuation.screenshots?.map((s: { path: string }) => s.path)).toEqual([
        '/designs/a.png', '/designs/b.png',
      ]);
      const { buildCliArgs } = jest.requireActual<typeof cliRunner>('./claude-cli-runner');
      expect(buildCliArgs(continuation)).toEqual(expect.arrayContaining(['--add-dir', '/designs']));
      expect(continuation.prompt).toContain('Design screenshots are still available');
      expect(continuation.prompt).not.toContain('Design screenshots (accessible via filesystem)');
      expect(firstPass.prompt).not.toContain('Design screenshots are still available');
    });

    it('leaves continuation passes unchanged when there are no screenshots', async () => {
      await runWithScreenshots(undefined);

      expect(mockBuildCliArgs.mock.calls.length).toBeGreaterThanOrEqual(2);
      const continuation = mockBuildCliArgs.mock.calls[1][0];
      expect(continuation.screenshots).toBeUndefined();
      expect(continuation.prompt).not.toContain('Design screenshots');
    });
  });

  describe('modelsUsed', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('resolves with modelsUsed containing the configured model', async () => {
      mockSpawnCli.mockReturnValue(
        (async function* () {
          yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1 };
        })()
      );

      const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
      const result = await adapter.generateAndVerify({
        ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
        planArtifact: {
          plan: {
            action: 'feature', summary: 'test', steps: [{ description: 'step 1' }], estimatedComplexity: 'low',
            affectedFiles: [], affectedRepositories: [], risks: [],
          },
          action: 'feature', path: '/tmp/p.json',
        },
        options: { trackerName: 'jira', repoDir: '/repo' },
        verificationScripts: [],
        repoFiles: [],
        repoName: 'repo',
        trackedFilePaths: [],
      });

      expect(result.modelsUsed).toEqual([expect.any(String)]);
    });
  });

  describe('plan problem reports', () => {
    const resultOnly = (result = 'done') => (async function* () {
      yield { type: 'result', result, session_id: 's1', num_turns: 1 } as never;
    })();

    const run = async (repoFiles: string[] = []) => {
      const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
      return adapter.generateAndVerify({
        ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
        planArtifact: {
          plan: {
            action: 'feature', summary: 'test', steps: [{ description: 'step 1' }, { description: 'step 2' }], estimatedComplexity: 'low',
            affectedFiles: [], affectedRepositories: [], risks: [],
          },
          action: 'feature',
          path: '/tmp/p.json',
        },
        options: { trackerName: 'jira', repoDir: '/repo' },
        verificationScripts: [],
        repoFiles,
        repoName: 'repo',
        trackedFilePaths: repoFiles,
      } as never);
    };

    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns no reports when the agent reports nothing', async () => {
      mockSpawnCli.mockImplementation(() => resultOnly());

      const result = await run();

      expect(result.planProblems).toEqual([]);
    });

    it('records a report from the initial pass result', async () => {
      mockSpawnCli.mockImplementation(() => resultOnly('PLAN-PROBLEM: 1 | wrong path | used src/b.ts'));

      const result = await run();

      expect(result.planProblems).toEqual([{ step: 1, reason: 'wrong path', instead: 'used src/b.ts' }]);
    });

    it('records a report from a continuation pass', async () => {
      mockSpawnCli
        .mockImplementationOnce(() => resultOnly())
        .mockImplementationOnce(() => resultOnly('PLAN-PROBLEM: 2 | stale | skipped\nNO-CHANGE: src/app.ts'))
        .mockImplementation(() => resultOnly());

      const result = await run(['repo/src/app.ts']);

      expect(result.planProblems).toEqual([{ step: 2, reason: 'stale', instead: 'skipped' }]);
    });

    it('records a report from a verification fix pass', async () => {
      mockRunProgrammaticVerification.mockResolvedValue([
        { id: 'test', command: 'yarn test', policy: 'enforced', status: 'failed', output: 'boom' },
      ] as never);
      mockSpawnCli
        .mockImplementationOnce(() => resultOnly())
        .mockImplementationOnce(() => resultOnly('PLAN-PROBLEM: 1 | fix reason | fix instead'))
        .mockImplementation(() => resultOnly());

      const result = await run();

      expect(result.planProblems).toEqual([{ step: 1, reason: 'fix reason', instead: 'fix instead' }]);
    });

    it('keeps the first report when a later pass reports the same step', async () => {
      mockSpawnCli
        .mockImplementationOnce(() => resultOnly('PLAN-PROBLEM: 1 | first | one'))
        .mockImplementationOnce(() => resultOnly('PLAN-PROBLEM: 1 | second | two\nNO-CHANGE: src/app.ts'))
        .mockImplementation(() => resultOnly());

      const result = await run(['repo/src/app.ts']);

      expect(result.planProblems).toEqual([{ step: 1, reason: 'first', instead: 'one' }]);
    });

    it('drops a step number above the plan step count', async () => {
      mockSpawnCli.mockImplementation(() => resultOnly('PLAN-PROBLEM: 3 | a | b'));

      const result = await run();

      expect(result.planProblems).toEqual([]);
    });
  });

  describe('verification pass numbering', () => {
    const yieldCliResult = () =>
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 's1', num_turns: 1, total_cost_usd: 0.01 };
      })();

    const createNumberingParams = () => ({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature' as const, summary: 'test', steps: [{ description: 'step 1' }],
          estimatedComplexity: 'low' as const, affectedFiles: [], affectedRepositories: [], risks: [],
        },
        action: 'feature' as const, path: '/tmp/p.json',
      },
      options: { trackerName: 'jira' as const, repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
    });

    it('seeds the verification header from verificationPassOffset', async () => {
      mockSpawnCli.mockReturnValue(yieldCliResult());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
      const result = await adapter.generateAndVerify({ ...createNumberingParams(), verificationPassOffset: 2 });

      const logged = logSpy.mock.calls.map(call => String(call[0])).join('\n');
      logSpy.mockRestore();
      expect(logged).toContain('Running verification (pass 3)');
      expect(result.verificationPassCount).toBe(1);
    });

    it('defaults to pass 1 when no verificationPassOffset is provided', async () => {
      mockSpawnCli.mockReturnValue(yieldCliResult());
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const adapter = new ClaudeCliAdapter(createMockConfigService() as any);
      const result = await adapter.generateAndVerify(createNumberingParams());

      const logged = logSpy.mock.calls.map(call => String(call[0])).join('\n');
      logSpy.mockRestore();
      expect(logged).toContain('Running verification (pass 1)');
      expect(result.verificationPassCount).toBe(1);
    });
  });
});
