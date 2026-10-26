import { ConfigService } from '@nestjs/config';
import { CodexCliAdapter } from './codex-cli.adapter';
import { STALL_THRESHOLD, runProgrammaticVerification } from './verification-report';
import * as codexRunner from './codex-cli-runner';
import * as skillContent from '../../../skills/skill-content';

jest.mock('./codex-cli-runner');
jest.mock('./verification-report', () => ({
  ...jest.requireActual<typeof import('./verification-report')>('./verification-report'),
  runProgrammaticVerification: jest.fn(),
}));
jest.mock('./shared-routing', () => {
  const actual = jest.requireActual<typeof import('./shared-routing')>('./shared-routing');
  return {
    ...actual,
    discoverChangedFiles: jest.fn().mockResolvedValue(new Set<string>()),
  };
});

const mockAssertCodexCliAvailable = codexRunner.assertCodexCliAvailable as jest.MockedFunction<
  typeof codexRunner.assertCodexCliAvailable
>;
const mockBuildCodexCliArgs = codexRunner.buildCodexCliArgs as jest.MockedFunction<
  typeof codexRunner.buildCodexCliArgs
>;
const mockRunProgrammaticVerification = runProgrammaticVerification as jest.MockedFunction<
  typeof runProgrammaticVerification
>;
const mockSpawnCodex = codexRunner.spawnCodex as jest.MockedFunction<typeof codexRunner.spawnCodex>;
const mockGetCodexCliVersion = codexRunner.getCodexCliVersion as jest.MockedFunction<
  typeof codexRunner.getCodexCliVersion
>;

const createMockConfigService = (overrides: Record<string, unknown> = {}): Pick<ConfigService, 'get'> => ({
  get: jest.fn((key: string, fallback?: unknown) => (key in overrides ? overrides[key] : fallback)),
});

describe('CodexCliAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunProgrammaticVerification.mockImplementation(
      jest.requireActual<typeof import('./verification-report')>('./verification-report').runProgrammaticVerification,
    );
    mockAssertCodexCliAvailable.mockImplementation(() => undefined);
    mockBuildCodexCliArgs.mockImplementation(() => ['codex', 'exec', '--json']);
    mockGetCodexCliVersion.mockReturnValue({ major: 0, minor: 147, patch: 0 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes repo conventions into the initial prompt', async () => {
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          result: 'done',
          session_id: 'codex-session',
          num_turns: 1,
          total_cost_usd: 0.01,
        };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
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

    expect(mockBuildCodexCliArgs).toHaveBeenCalledTimes(1);
    expect(mockBuildCodexCliArgs.mock.calls[0][0].prompt).toContain('Repository conventions (repo):');
    expect(mockBuildCodexCliArgs.mock.calls[0][0].prompt).toContain('Formatter: prettier');
  });

  it('builds the initial prompt when the plan carries object risks', async () => {
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 'codex-session', num_turns: 1, total_cost_usd: 0.01 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
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
    });

    expect(mockBuildCodexCliArgs).toHaveBeenCalledTimes(1);
    expect(mockBuildCodexCliArgs.mock.calls[0][0].prompt).toContain('conventions');
  });

  const createBaseParams = () => ({
    ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
    planArtifact: {
      plan: {
        action: 'feature' as const, summary: 'test', steps: [{ description: 'step 1' }],
        estimatedComplexity: 'low' as const, affectedFiles: [], affectedRepositories: [], risks: [],
      },
      action: 'feature' as const, path: '/tmp/p.json',
    },
    options: { trackerName: 'jira' as const, repoDir: '/repo' },
    verificationScripts: [] as never[],
    repoFiles: [] as string[],
    repoName: 'repo',
    trackedFilePaths: [] as string[],
  });

  const yieldCodexResult = () =>
    (async function* () {
      yield { type: 'thread.started', thread_id: 'thread-abc' };
      yield { type: 'result', result: 'done', session_id: 'codex-session', num_turns: 1 };
    })();

  it('seeds the verification header from verificationPassOffset', async () => {
    mockSpawnCodex.mockReturnValue(yieldCodexResult());
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    const result = await adapter.generateAndVerify({ ...createBaseParams(), verificationPassOffset: 2 });

    const logged = logSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(logged).toContain('Running verification (pass 3)');
    expect(result.verificationPassCount).toBe(1);
  });

  it('defaults to pass 1 when no verificationPassOffset is provided', async () => {
    mockSpawnCodex.mockReturnValue(yieldCodexResult());
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    const result = await adapter.generateAndVerify(createBaseParams());

    const logged = logSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(logged).toContain('Running verification (pass 1)');
    expect(result.verificationPassCount).toBe(1);
  });

  it('captures session ID from thread.started message', async () => {
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-abc' };
        yield { type: 'result', result: 'done', session_id: 'codex-session', num_turns: 1 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    const result = await adapter.generateAndVerify(createBaseParams());
    expect(result.sessionId).toBe('thread-abc');
  });

  it('throws when the codex stream ends with a terminal error message', async () => {
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-abc' };
        yield {
          type: 'error', subtype: 'no_progress', is_error: true,
          result: 'Codex CLI emitted 10 consecutive agent messages without running a command or editing files; aborted as stalled.',
        };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await expect(adapter.generateAndVerify(createBaseParams())).rejects.toMatchObject({
      message: expect.stringContaining('aborted as stalled'),
    });
  });

  it('logs command start and completion events', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'item.started', item: { type: 'command_execution', command: 'npm test' } };
        yield { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 } };
        yield { type: 'result', result: 'done', session_id: 'codex-session', num_turns: 1 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify(createBaseParams());

    const logged = consoleSpy.mock.calls.map(c => c[0]);
    expect(logged.some((line: string) => line.includes('Running: npm test'))).toBe(true);
    expect(logged.some((line: string) => line.includes('Command completed: npm test'))).toBe(true);
  });

  it('tracks files from assistant tool_use blocks', async () => {
    jest.spyOn(console, 'log').mockImplementation();
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Write', input: { file_path: '/repo/src/new.ts' } },
            ],
          },
        };
        yield { type: 'result', result: 'done', session_id: 'codex-session', num_turns: 1 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify(createBaseParams());

    const consoleSpy = jest.spyOn(console, 'log');
    const logged = consoleSpy.mock.calls.map(c => c[0]);
    expect(logged.some((line: string) => line.includes('File updated: src/new.ts'))).toBe(true);
  });

  it('tracks files from message files array', async () => {
    jest.spyOn(console, 'log').mockImplementation();
    const { discoverChangedFiles } = jest.requireMock<typeof import('./shared-routing')>('./shared-routing');
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'assistant', files: [{ filename: '/repo/package.json' }] };
        yield { type: 'result', result: 'done', session_id: 'codex-session', num_turns: 1 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify(createBaseParams());

    expect(discoverChangedFiles).toHaveBeenCalled();
    const touchedFiles = (discoverChangedFiles as jest.Mock).mock.calls[0][1] as Set<string>;
    expect(touchedFiles.has('package.json')).toBe(true);
  });

  it('logs system message summaries', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'system', summary: 'Codex initialized' };
        yield { type: 'result', result: 'done', session_id: 'codex-session', num_turns: 1 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify(createBaseParams());

    const logged = consoleSpy.mock.calls.map(c => c[0]);
    expect(logged.some((line: string) => line.includes('Codex initialized'))).toBe(true);
  });

  it('forwards codexVersion to buildCodexCliArgs', async () => {
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 'codex-session', num_turns: 1 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify(createBaseParams());

    expect(mockBuildCodexCliArgs).toHaveBeenCalledWith(
      expect.objectContaining({ codexVersion: { major: 0, minor: 147, patch: 0 } }),
    );
  });

  it('uses initialPromptOverride as the prompt when set', async () => {
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 'codex-session', num_turns: 1 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify({
      ...createBaseParams(),
      options: { trackerName: 'jira', repoDir: '/repo', initialPromptOverride: 'custom override' },
    });

    expect(mockBuildCodexCliArgs.mock.calls[0][0].prompt).toBe('custom override');
  });

  it('resolves with modelsUsed containing the configured model', async () => {
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 'codex-session', num_turns: 1 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    const result = await adapter.generateAndVerify(createBaseParams());

    expect(result.modelsUsed).toEqual([expect.any(String)]);
  });

  describe('plan problem reports', () => {
    const agentMessage = (text: string) => ({ type: 'item.completed', item: { type: 'agent_message', text } });

    const run = async (messages: unknown[]) => {
      mockSpawnCodex.mockReturnValue(
        (async function* () {
          for (const message of messages) yield message as never;
        })()
      );
      jest.spyOn(console, 'log').mockImplementation(() => {});
      return new CodexCliAdapter(createMockConfigService() as ConfigService).generateAndVerify({
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
        repoFiles: [],
        repoName: 'repo',
        trackedFilePaths: [],
      } as never);
    };

    it('tells the agent how to report a plan problem', async () => {
      await run([agentMessage('Done.')]);

      expect(mockBuildCodexCliArgs).toHaveBeenCalled();
      expect(mockBuildCodexCliArgs.mock.calls[0][0].prompt).toContain('PLAN-PROBLEM: <step number');
    });

    it('returns no reports when the agent reports nothing', async () => {
      const result = await run([agentMessage('Done.')]);

      expect(result.planProblems).toEqual([]);
    });

    it('records a report from the last agent message', async () => {
      const result = await run([
        agentMessage('Working on it.'),
        agentMessage('Done.\nPLAN-PROBLEM: 2 | wrong path | used src/b.ts'),
      ]);

      expect(result.planProblems).toEqual([{ step: 2, reason: 'wrong path', instead: 'used src/b.ts' }]);
    });

    it('ignores a report that only appears in an earlier interim agent message', async () => {
      const result = await run([
        agentMessage('PLAN-PROBLEM: 1 | interim | thought'),
        agentMessage('Done.'),
      ]);

      expect(result.planProblems).toEqual([]);
    });

    it('drops a step number above the plan step count', async () => {
      const result = await run([agentMessage('PLAN-PROBLEM: 3 | a | b')]);

      expect(result.planProblems).toEqual([]);
    });
  });

  describe('implement stage stall threshold', () => {
    const makeState = (readOnly: number) => ({
      outcomes: [], codeFailures: [{}], sessionId: 's1',
      prevFails: Infinity, stalled: 0, readOnly, passNumber: 1, exhausted: false,
    });

    it('resolves stages.implement.stallThresholdForVerificationFix from config', () => {
      const adapter = new CodexCliAdapter(
        createMockConfigService({ 'stages.implement.stallThresholdForVerificationFix': 5 }) as ConfigService
      );
      expect((adapter as any).resolveStallThreshold()).toBe(5);
    });

    it('falls back to STALL_THRESHOLD when stallThresholdForVerificationFix is unset', () => {
      const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
      expect((adapter as any).resolveStallThreshold()).toBe(STALL_THRESHOLD);
    });

    it('gates fix iterations on the configured cap instead of the hardcoded default', () => {
      const adapter = new CodexCliAdapter(
        createMockConfigService({ 'stages.implement.stallThresholdForVerificationFix': 4 }) as ConfigService
      );
      expect((adapter as any).shouldRunFixIteration(makeState(3))).toBe(true);
      expect((adapter as any).shouldRunFixIteration(makeState(4))).toBe(false);
    });
  });

  it('logs the File summary no-changes line when no files were touched', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 's', num_turns: 1 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify(createBaseParams());

    const lines = logSpy.mock.calls.map(([message]) => String(message));
    expect(lines).toContain('\n  File summary: no file changes were made.');
    logSpy.mockRestore();
  });

  it('injects skill SKILL.md content into the implement prompt when skillNames is set', async () => {
    jest.spyOn(skillContent, 'buildSkillPromptFragment').mockResolvedValue('## Skill: coding-style\nContent');
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 's', num_turns: 1, total_cost_usd: 0 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify({ ...createBaseParams(), skillNames: ['coding-style'] });

    const builtArgs = mockBuildCodexCliArgs.mock.calls[0][0];
    expect(builtArgs.prompt).toContain('## Skill: coding-style');
  });

  it('uses the red-green tail when the TDD skill fragment is present', async () => {
    jest.spyOn(skillContent, 'buildSkillPromptFragment')
      .mockResolvedValue('\n\n## Skill: test-driven-development\nContent');
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 's', num_turns: 1, total_cost_usd: 0 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify({ ...createBaseParams(), skillNames: ['test-driven-development'] });

    const builtArgs = mockBuildCodexCliArgs.mock.calls[0][0];
    expect(builtArgs.prompt).toContain('confirm it fails');
    expect(builtArgs.prompt).not.toContain('After ALL edits are complete');
  });

  it('keeps the legacy tail without the TDD skill fragment', async () => {
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield { type: 'result', result: 'done', session_id: 's', num_turns: 1, total_cost_usd: 0 };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify(createBaseParams());

    expect(mockBuildCodexCliArgs.mock.calls[0][0].prompt).toContain('After ALL edits are complete');
  });

  it('includes the skill fragment in the verification fix-pass prompt', async () => {
    jest.spyOn(skillContent, 'buildSkillPromptFragment')
      .mockResolvedValue('\n\n## Skill: test-driven-development\nContent');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockRunProgrammaticVerification
      .mockResolvedValueOnce([{ id: 'lint', command: 'yarn lint', policy: 'enforced', status: 'failed', output: 'lint error' }] as never)
      .mockResolvedValueOnce([{ id: 'lint', command: 'yarn lint', policy: 'enforced', status: 'passed' }] as never);
    let streamCount = 0;
    mockSpawnCodex.mockImplementation(() => {
      const filename = `file-${streamCount++}.ts`;
      return (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-1', files: [{ filename }] };
        yield { type: 'result', result: 'done', session_id: 's', num_turns: 1, total_cost_usd: 0 };
      })();
    });

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify({
      ...createBaseParams(),
      skillNames: ['test-driven-development'],
      verificationScripts: [{ id: 'lint', name: 'lint', command: 'yarn lint', policy: 'enforced', aliases: [] }],
    });

    const prompts = mockBuildCodexCliArgs.mock.calls.map(([args]) => args.prompt);
    const fixPrompt = prompts.find(prompt => prompt.includes('enforced verification commands failed'));
    expect(fixPrompt).toContain('## Skill: test-driven-development');
    expect(mockRunProgrammaticVerification).toHaveBeenCalledTimes(2);
  });
});
