import { EventEmitter } from 'node:events';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { resolveSkippedSteps, printVerificationReport, checkVerificationStall, DEFAULT_STALL_THRESHOLD, buildVerificationFixPrompt, runProgrammaticVerification, runScriptWithEarlyExit } from './verification-report';
import type { VerificationOutcome, VerificationScript } from '../../../shared/types/agent.types';
import { signalProcessTree } from '../../../shared/utils/signal-process-tree';

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('../../../shared/utils/signal-process-tree', () => ({
  signalProcessTree: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockSignalProcessTree = signalProcessTree as jest.MockedFunction<typeof signalProcessTree>;

const createMockChild = (): ChildProcess => {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as ChildProcess['stdout'];
  child.stderr = new EventEmitter() as ChildProcess['stderr'];
  return child;
};

const createMockScript = (overrides: Partial<VerificationScript> = {}): VerificationScript => ({
  id: 'lint',
  name: 'Lint',
  command: 'yarn lint',
  policy: 'enforced',
  aliases: [],
  ...overrides,
});

const createMockOutcome = (overrides: Partial<VerificationOutcome> = {}): VerificationOutcome => ({
  id: 'lint',
  command: 'yarn lint',
  policy: 'enforced',
  status: 'passed',
  ...overrides,
});

describe('resolveSkippedSteps', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns outcomes unchanged when all scripts have matching outcomes', () => {
    const scripts = [createMockScript({ id: 'lint', command: 'yarn lint' })];
    const outcomes = [createMockOutcome({ id: 'lint', command: 'yarn lint', status: 'passed' })];

    const result = resolveSkippedSteps(scripts, outcomes);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('passed');
  });

  it('appends skipped entries for scripts with no matching outcome', () => {
    const scripts = [
      createMockScript({ id: 'lint', command: 'yarn lint' }),
      createMockScript({ id: 'typecheck', command: 'yarn typecheck', policy: 'best_effort' }),
      createMockScript({ id: 'test', command: 'yarn test' }),
    ];
    const outcomes = [createMockOutcome({ id: 'lint', command: 'yarn lint', status: 'passed' })];

    const result = resolveSkippedSteps(scripts, outcomes);

    expect(result).toHaveLength(3);
    expect(result[0].status).toBe('passed');
    const skipped = result.filter(o => o.status === 'skipped');
    expect(skipped).toHaveLength(2);
    expect(skipped.map(s => s.id)).toEqual(expect.arrayContaining(['typecheck', 'test']));
  });

  it('marks all scripts as skipped when no outcomes are provided', () => {
    const scripts = [
      createMockScript({ id: 'lint', command: 'yarn lint' }),
      createMockScript({ id: 'build', command: 'yarn build', policy: 'best_effort' }),
    ];

    const result = resolveSkippedSteps(scripts, []);

    expect(result).toHaveLength(2);
    expect(result.every(o => o.status === 'skipped')).toBe(true);
  });

  it('returns empty array when both scripts and outcomes are empty', () => {
    expect(resolveSkippedSteps([], [])).toEqual([]);
  });
});

describe('printVerificationReport', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prints nothing when outcomes is empty', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printVerificationReport([]);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('prints a line for each outcome with the correct command', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const outcomes: VerificationOutcome[] = [
      createMockOutcome({ command: 'yarn lint', status: 'passed' }),
      createMockOutcome({ id: 'typecheck', command: 'yarn typecheck', status: 'failed', policy: 'enforced' }),
      createMockOutcome({ id: 'test', command: 'yarn test', status: 'skipped', policy: 'best_effort' }),
    ];

    printVerificationReport(outcomes);

    const allOutput = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('yarn lint');
    expect(allOutput).toContain('yarn typecheck');
    expect(allOutput).toContain('yarn test');
  });

  it('prints a header line followed by one line per outcome', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const outcomes: VerificationOutcome[] = [
      createMockOutcome({ status: 'passed' }),
      createMockOutcome({ id: 'build', command: 'yarn build', status: 'failed', policy: 'best_effort' }),
    ];

    printVerificationReport(outcomes);

    // header + 2 outcome lines
    expect(consoleSpy).toHaveBeenCalledTimes(3);
  });
});

describe('checkVerificationStall', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('exports DEFAULT_STALL_THRESHOLD as 2', () => {
    expect(DEFAULT_STALL_THRESHOLD).toBe(2);
  });

  it('returns incremented count when failures are not decreasing and below threshold', () => {
    const result = checkVerificationStall(5, 5, 0, 'test-adapter');
    expect(result).toBe(1);
  });

  it('returns -1 when stalled count reaches default threshold', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = checkVerificationStall(5, 5, 1, 'test-adapter');
    expect(result).toBe(-1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Verification failures not decreasing after 2 passes'));
  });

  it('returns 0 when failures decrease', () => {
    const result = checkVerificationStall(3, 5, 1, 'test-adapter');
    expect(result).toBe(0);
  });

  it('respects a custom threshold parameter', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    // stalledPasses=1 with threshold=3 should NOT stop yet
    const notYet = checkVerificationStall(5, 5, 1, 'test-adapter', 3);
    expect(notYet).toBe(2);
    expect(consoleSpy).not.toHaveBeenCalled();

    // stalledPasses=2 with threshold=3 should stop (updated reaches threshold)
    const stopped = checkVerificationStall(5, 5, 2, 'test-adapter', 3);
    expect(stopped).toBe(-1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('after 3 passes'));
  });
});

describe('buildVerificationFixPrompt', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns empty string for no failures', () => {
    expect(buildVerificationFixPrompt([])).toBe('');
  });

  it('returns base prompt without scope note when scopedFiles is omitted', () => {
    const result = buildVerificationFixPrompt([createMockOutcome({ status: 'failed' })]);
    expect(result).toContain('fix the code so all listed commands pass');
    expect(result).not.toContain('Only modify files within this task');
  });

  it('appends scope note with each file path when scopedFiles is non-empty', () => {
    const result = buildVerificationFixPrompt(
      [createMockOutcome({ status: 'failed' })],
      ['src/foo.ts', 'src/bar.ts'],
    );
    expect(result).toContain('Only modify files within this task');
    expect(result).toContain("\n\nOnly modify files within this task's scope:\nsrc/foo.ts\nsrc/bar.ts");
    expect(result).toContain('pre-existing issue unrelated to this task');
  });

  it('omits scope note when scopedFiles is an empty array', () => {
    const result = buildVerificationFixPrompt(
      [createMockOutcome({ status: 'failed' })],
      [],
    );
    expect(result).toBe(buildVerificationFixPrompt([createMockOutcome({ status: 'failed' })]));
    expect(result).not.toContain('Only modify files within this task');
  });
});

describe('runProgrammaticVerification', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    mockExecSync.mockClear();
    mockSpawn.mockClear();
    mockSignalProcessTree.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns skipped outcome when binary is not in PATH', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).startsWith('command -v')) throw new Error('command not found');
      throw new Error('should not reach real command');
    });
    const scripts = [createMockScript({ id: 'tf', command: 'terraform plan', policy: 'enforced' })];

    const outcomes = await runProgrammaticVerification(scripts, '/repo');

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('skipped');
    expect(outcomes[0].output).toBe('terraform: command not found');
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith('command -v terraform', { stdio: 'pipe' });
  });

  it('returns passed outcome when binary exists and script succeeds', async () => {
    mockExecSync.mockImplementation(() => Buffer.from(''));
    const scripts = [createMockScript({ id: 'tf', command: 'terraform validate', policy: 'enforced' })];

    const outcomes = await runProgrammaticVerification(scripts, '/repo');

    expect(outcomes[0].status).toBe('passed');
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(1, 'command -v terraform', { stdio: 'pipe' });
    expect(mockExecSync).toHaveBeenNthCalledWith(2, 'terraform validate', expect.objectContaining({ cwd: '/repo' }));
  });

  it('returns failed outcome when binary exists but script throws', async () => {
    const scriptError = Object.assign(new Error('exit 1'), { stdout: 'plan failed', stderr: '' });
    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).startsWith('command -v')) return Buffer.from('/usr/bin/terraform');
      throw scriptError;
    });
    const scripts = [createMockScript({ id: 'tf', command: 'terraform plan', policy: 'enforced' })];

    const outcomes = await runProgrammaticVerification(scripts, '/repo');

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].output).toContain('plan failed');
  });

  it('probes the binary after cd prefix, not cd itself', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).startsWith('command -v')) throw new Error('not found');
      return Buffer.from('');
    });
    const scripts = [createMockScript({ id: 'tf', command: 'cd /app && terraform plan', policy: 'enforced' })];

    const outcomes = await runProgrammaticVerification(scripts, '/repo');

    expect(outcomes[0].status).toBe('skipped');
    expect(outcomes[0].output).toBe('terraform: command not found');
    expect(mockExecSync).toHaveBeenCalledWith('command -v terraform', { stdio: 'pipe' });
  });

  it('skips binary probe and runs real command for ambiguous leading token', async () => {
    mockExecSync.mockImplementation(() => Buffer.from(''));
    const scripts = [createMockScript({ id: 'env', command: 'FOO=bar terraform plan', policy: 'enforced' })];

    const outcomes = await runProgrammaticVerification(scripts, '/repo');

    expect(outcomes[0].status).toBe('passed');
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith('FOO=bar terraform plan', expect.objectContaining({ cwd: '/repo' }));
  });

  it('stops a spawned process group when stdout matches the early-exit pattern', async () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/bin/terraform'));
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const scripts = [createMockScript({ command: 'terraform apply', earlyExitPattern: '(?:^|\\n)Preparing the remote plan' })];

    const result = runProgrammaticVerification(scripts, '/repo');
    child.stdout?.emit('data', Buffer.from('Preparing the remote plan'));
    child.emit('close', null, 'SIGTERM');

    await expect(result).resolves.toEqual([
      expect.objectContaining({ id: 'lint', status: 'passed' }),
    ]);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith('terraform apply', expect.objectContaining({
      cwd: '/repo', detached: true, shell: true,
    }));
    expect(mockSignalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
  });

  it('stops a spawned process group when stderr matches the early-exit pattern', async () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/bin/terraform'));
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const result = runProgrammaticVerification([createMockScript({ earlyExitPattern: 'Preparing the remote plan' })], '/repo');
    child.stderr?.emit('data', Buffer.from('Preparing the remote plan'));
    child.emit('close', null, 'SIGTERM');
    await expect(result).resolves.toEqual([expect.objectContaining({ status: 'passed' })]);
    expect(mockSignalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
  });

  it('matches an early-exit pattern split across output chunks', async () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/bin/terraform'));
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const result = runProgrammaticVerification([
      createMockScript({ earlyExitPattern: 'Preparing the remote plan' }),
    ], '/repo');
    child.stdout?.emit('data', Buffer.from('Preparing the remote '));
    child.stdout?.emit('data', Buffer.from('plan'));
    child.emit('close', null, 'SIGTERM');

    await expect(result).resolves.toEqual([expect.objectContaining({ status: 'passed' })]);
    expect(mockSignalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
  });

  it('fails when a process exits before its early-exit pattern is observed', async () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/bin/terraform'));
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const result = runProgrammaticVerification([createMockScript({ earlyExitPattern: 'marker' })], '/repo');
    child.emit('close', 0, null);
    await expect(result).resolves.toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(mockSignalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
  });

  it('reports output from a non-zero early-exit process', async () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/bin/terraform'));
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);
    const result = runProgrammaticVerification([createMockScript({ earlyExitPattern: 'marker' })], '/repo');
    child.stderr?.emit('data', Buffer.from('terraform failed'));
    child.emit('close', 1, null);

    await expect(result).resolves.toEqual([
      expect.objectContaining({ status: 'failed', output: expect.stringContaining('terraform failed') }),
    ]);
  });

  it('fails after an injected early-exit timeout', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    await expect(runScriptWithEarlyExit(
      { ...createMockScript(), earlyExitPattern: 'marker' }, '/repo', 1,
    )).resolves.toEqual(expect.objectContaining({
      status: 'failed', output: expect.stringContaining('timed out'),
    }));
    expect(mockSignalProcessTree).toHaveBeenCalledWith(child, 'SIGKILL');
  });
});
