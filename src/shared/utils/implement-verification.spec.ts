import * as fs from 'fs';
import { execSync } from 'child_process';
import {
  appendImplementVerificationAttempt,
  buildMutationProgressSignal,
  buildStreamProgressSignal,
  buildVerificationCommandOrder,
  buildVerificationProgressSignal,
  classifyVerificationFailure,
  countDiagnosticLines,
  extractVerificationErrorClasses,
  formatBackendSelection,
  formatImplementProgressSignal,
  resolveVerificationSummary,
  writeImplementVerificationRunFile,
} from './implement-verification';
import * as wfPaths from './wf-paths';
import type {
  ImplementBackendSelection,
  ImplementRunArtifact,
  VerificationAttemptArtifact,
} from '../../agents/interfaces';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
}));
jest.mock('child_process');
jest.mock('./wf-paths');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockExecSync = jest.mocked(execSync);
const mockGetWfStateDir = jest.mocked(wfPaths.getWfStateDir);

describe('implement verification helpers', () => {
  beforeEach(() => {
    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.readdirSync.mockReset();
    mockFs.statSync.mockReset();
    mockExecSync.mockReset();
  });

  describe('classifyVerificationFailure', () => {
    it('classifies syntax failures as parse', () => {
      const result = classifyVerificationFailure({
        command: 'yarn format',
        stdout: '',
        stderr: '[error] src/example.spec.ts: SyntaxError: Unterminated template literal. (9:13)',
      });

      expect(result.category).toBe('parse');
      expect(result.rootSignal).toBe('syntax-error');
      expect(result.strategy).toBe('surgical');
      expect(result.confidence).toBe('high');
      expect(result.implicatedFiles).toEqual(['src/example.spec.ts']);
    });

    it('classifies lint failures as lint', () => {
      const result = classifyVerificationFailure({
        command: 'yarn lint:fix',
        stdout: '/tmp/repo/src/example.ts\n  4:7  error  x is assigned a value but never used',
        stderr: '',
      });

      expect(result.category).toBe('lint');
      expect(result.rootSignal).toBe('lint-diagnostic');
      expect(result.strategy).toBe('surgical');
    });

    it('falls back to unknown when no signal matches', () => {
      const result = classifyVerificationFailure({
        command: 'yarn verify',
        stdout: 'finished',
        stderr: '',
      });

      expect(result.category).toBe('unknown');
      expect(result.strategy).toBe('broad-context');
      expect(result.confidence).toBe('low');
    });
  });

  describe('formatBackendSelection', () => {
    it('formats backend selection inline', () => {
      const selection: ImplementBackendSelection = {
        configured: 'anthropic-agent',
        selected: 'anthropic-agent',
        provider: 'anthropic',
      };

      expect(formatBackendSelection(selection)).toBe('Implement backend: anthropic-agent (provider: anthropic)');
    });

    it('formats openai-agent selections', () => {
      const selection: ImplementBackendSelection = {
        configured: 'openai-agent',
        selected: 'openai-agent',
        provider: 'openai',
      };

      expect(formatBackendSelection(selection)).toBe('Implement backend: openai-agent (provider: openai)');
    });
  });

  describe('progress signals', () => {
    it('marks file mutations as continue signals', () => {
      const signal = buildMutationProgressSignal({
        change: 'updated',
        path: 'src/example.ts',
        changedFilesSinceLastVerification: ['src/example.ts'],
      });

      expect(signal.verdict).toBe('continue');
      expect(formatImplementProgressSignal(signal)).toContain('progress: continue');
    });

    it('marks a successful verification as complete', () => {
      const signal = buildVerificationProgressSignal({
        currentSnapshot: {
          command: 'npm test',
          commandIndex: 1,
          exitCode: 0,
          diagnosticLineCount: 0,
          errorClasses: new Set(),
        },
        changedFilesSinceLastVerification: [],
      });

      expect(signal.verdict).toBe('complete');
      expect(signal.nextAction).toContain('Stop');
    });

    it('marks streamed task progress as continue', () => {
      const signal = buildStreamProgressSignal({
        kind: 'task_progress',
        summary: 'Checking file boundaries',
        lastToolName: 'Edit',
      });

      expect(signal.verdict).toBe('continue');
      expect(signal.reasons).toEqual(expect.arrayContaining(['Checking file boundaries', 'last tool: Edit']));
    });

    it('builds a verification command order map from the configured scripts', () => {
      const order = buildVerificationCommandOrder([{ command: 'npm test' }, { command: 'yarn lint' }]);

      expect(order.get('npm test')).toBe(0);
      expect(order.get('yarn lint')).toBe(1);
    });

    it('counts diagnostics and extracts error classes', () => {
      expect(countDiagnosticLines('line one\n\nline two', '')).toBe(2);
      expect(
        Array.from(
          extractVerificationErrorClasses(
            'src/example.ts:1:1 - error TS2322: Type \'string\' is not assignable to type \'number\'',
            'eslint: no-unused-vars'
          )
        )
      ).toEqual(expect.arrayContaining(['type', 'lint']));
    });
  });

  describe('writeImplementVerificationRunFile', () => {
    it('writes an empty attempt list for a new run file', () => {
      const run: ImplementRunArtifact = {
        ticketKey: 'WBP-1000',
        repoDir: '/tmp/repo-a',
        backendConfigured: 'anthropic-agent',
        backendSelected: 'anthropic-agent',
        provider: 'openai',
        verificationScripts: [{ id: 'lint', command: 'yarn lint' }],
        startedAt: '2026-04-09T00:00:00.000Z',
      };

      writeImplementVerificationRunFile('/tmp/run.json', run);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/run.json',
        expect.stringContaining('"attempts": []'),
        'utf-8'
      );
    });
  });

  describe('appendImplementVerificationAttempt', () => {
    it('appends an attempt to the persisted run file', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          run: {
            ticketKey: 'WBP-1000',
            repoDir: '/tmp/repo-a',
            backendConfigured: 'anthropic-agent',
            backendSelected: 'anthropic-agent',
            provider: 'openai',
            verificationScripts: [{ id: 'lint', command: 'yarn lint' }],
            startedAt: '2026-04-09T00:00:00.000Z',
          },
          attempts: [],
        })
      );

      const attempt: VerificationAttemptArtifact = {
        ticketKey: 'WBP-1000',
        attemptNumber: 1,
        backend: 'anthropic-agent',
        command: 'yarn lint',
        exitCode: 1,
        failed: true,
        classification: {
          category: 'lint',
          implicatedFiles: ['src/example.ts'],
          companionFiles: [],
          rootSignal: 'lint-diagnostic',
          strategy: 'surgical',
          confidence: 'high',
        },
        fingerprint: 'abc123',
        progress: {
          advancedStage: false,
          reducedDiagnostics: true,
          narrowedFileSet: true,
        },
        retryScope: ['src/example.ts'],
        createdAt: '2026-04-09T00:00:01.000Z',
      };

      appendImplementVerificationAttempt('/tmp/run.json', attempt);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/run.json',
        expect.stringContaining('"attemptNumber": 1'),
        'utf-8'
      );
    });
  });

  describe('resolveVerificationSummary', () => {
    const REPO_DIR = '/projects/my-repo';
    const TICKET = 'WBP-99';

    const validRunFile = JSON.stringify({
      run: {
        ticketKey: TICKET,
        repoDir: REPO_DIR,
        backendConfigured: 'anthropic-agent',
        backendSelected: 'anthropic-agent',
        provider: 'anthropic',
        verificationScripts: [{ id: 'test', command: 'yarn test' }],
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      attempts: [
        {
          ticketKey: TICKET,
          attemptNumber: 1,
          backend: 'anthropic-agent',
          command: 'yarn test',
          exitCode: 0,
          failed: false,
          classification: {
            category: 'test-runtime',
            implicatedFiles: [],
            companionFiles: [],
            rootSignal: 'test-diagnostic',
            strategy: 'paired-files',
            confidence: 'medium',
          },
          fingerprint: 'abc',
          progress: { advancedStage: true, reducedDiagnostics: true, narrowedFileSet: false },
          retryScope: [],
          createdAt: '2026-01-01T00:01:00.000Z',
        },
      ],
    });

    beforeEach(() => {
      mockGetWfStateDir.mockReturnValue('/state');
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([`${TICKET}-2026-01-01T00-00-00-000Z.json`] as unknown as ReturnType<typeof fs.readdirSync>);
      mockFs.statSync.mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
      mockFs.readFileSync.mockReturnValue(validRunFile);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns a formatted summary from the cached run file when attempts exist', () => {
      const result = resolveVerificationSummary(REPO_DIR, TICKET);

      expect(result).toContain('Prior implement run');
      expect(result).toContain(TICKET);
      expect(result).toContain('1 attempt(s)');
      expect(result).toContain('passed');
      expect(result).toContain('yarn test');
    });

    it('reports no attempts recorded when the cached run file has an empty attempts array', () => {
      const emptyAttempts = JSON.stringify({ ...JSON.parse(validRunFile), attempts: [] });
      mockFs.readFileSync.mockReturnValue(emptyAttempts);

      const result = resolveVerificationSummary(REPO_DIR, TICKET);

      expect(result).toContain('no verification attempts recorded');
    });

    it('reads the most recently modified matching file when several exist', () => {
      mockFs.readdirSync.mockReturnValue([
        `${TICKET}-older.json`,
        `${TICKET}-newer.json`,
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      mockFs.statSync
        .mockReturnValueOnce({ mtimeMs: 500 } as fs.Stats)
        .mockReturnValueOnce({ mtimeMs: 2000 } as fs.Stats);

      resolveVerificationSummary(REPO_DIR, TICKET);

      expect(mockFs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('newer'), 'utf-8');
    });

    it('falls back to git diff --stat when no cache directory exists', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue('4 files changed, 20 insertions');

      const result = resolveVerificationSummary(REPO_DIR, TICKET);

      expect(result).toContain('4 files changed');
    });

    it('falls back to git diff --stat when no matching cached files exist', () => {
      mockFs.readdirSync.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
      mockExecSync.mockReturnValue('2 files changed');

      const result = resolveVerificationSummary(REPO_DIR, TICKET);

      expect(result).toContain('2 files changed');
    });

    it('returns an empty string when there is no cache and git diff throws', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => {
        throw new Error('not a repo');
      });

      expect(resolveVerificationSummary(REPO_DIR, TICKET)).toBe('');
    });

    it('falls back to git diff --stat when the cached file fails to parse', () => {
      mockFs.readFileSync.mockReturnValue('INVALID_JSON');
      mockExecSync.mockReturnValue('1 file changed');

      const result = resolveVerificationSummary(REPO_DIR, TICKET);

      expect(result).toContain('1 file changed');
    });

    it('ignores files that do not match the ticketKey prefix and falls back to git diff', () => {
      mockFs.readdirSync.mockReturnValue(['OTHER-1-2026.json'] as unknown as ReturnType<typeof fs.readdirSync>);
      mockExecSync.mockReturnValue('');

      const result = resolveVerificationSummary(REPO_DIR, TICKET);

      expect(mockFs.readFileSync).not.toHaveBeenCalled();
      expect(result).toBe('');
    });
  });
});
