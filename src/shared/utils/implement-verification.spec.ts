import * as fs from 'fs';
import {
  appendImplementVerificationAttempt,
  classifyVerificationFailure,
  formatBackendSelection,
  writeImplementVerificationRunFile,
} from './implement-verification';
import type {
  ImplementBackendSelection,
  ImplementRunArtifact,
  VerificationAttemptArtifact,
} from '../../agents/interfaces';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;

describe('implement verification helpers', () => {
  beforeEach(() => {
    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
    mockFs.writeFileSync.mockReset();
  });

  describe('classifyVerificationFailure', () => {
    it('classifies syntax failures as parse', () => {
      const result = classifyVerificationFailure({
        command: 'npm run format',
        stdout: '',
        stderr:
          '[error] src/example.spec.ts: SyntaxError: Unterminated template literal. (9:13)',
      });

      expect(result.category).toBe('parse');
      expect(result.rootSignal).toBe('syntax-error');
      expect(result.strategy).toBe('surgical');
      expect(result.confidence).toBe('high');
      expect(result.implicatedFiles).toEqual(['src/example.spec.ts']);
    });

    it('classifies lint failures as lint', () => {
      const result = classifyVerificationFailure({
        command: 'npm run lint:fix',
        stdout:
          '/tmp/repo/src/example.ts\n  4:7  error  x is assigned a value but never used',
        stderr: '',
      });

      expect(result.category).toBe('lint');
      expect(result.rootSignal).toBe('lint-diagnostic');
      expect(result.strategy).toBe('surgical');
    });

    it('falls back to unknown when no signal matches', () => {
      const result = classifyVerificationFailure({
        command: 'npm run verify',
        stdout: 'finished',
        stderr: '',
      });

      expect(result.category).toBe('unknown');
      expect(result.strategy).toBe('broad-context');
      expect(result.confidence).toBe('low');
    });
  });

  describe('formatBackendSelection', () => {
    it('formats fallback reasons inline', () => {
      const selection: ImplementBackendSelection = {
        configured: 'anthropic-agent',
        selected: 'two-phase',
        provider: 'openai',
        fallbackReason: 'provider mismatch',
      };

      expect(formatBackendSelection(selection)).toBe(
        'Implement backend: two-phase (configured: anthropic-agent, provider: openai, reason: provider mismatch)',
      );
    });
  });

  describe('writeImplementVerificationRunFile', () => {
    it('writes an empty attempt list for a new run file', () => {
      const run: ImplementRunArtifact = {
        ticketKey: 'WBP-1000',
        repoDir: '/tmp/repo-a',
        backendConfigured: 'two-phase',
        backendSelected: 'two-phase',
        provider: 'openai',
        verificationScripts: [{ id: 'lint', command: 'npm run lint' }],
        startedAt: '2026-04-09T00:00:00.000Z',
      };

      writeImplementVerificationRunFile('/tmp/run.json', run);

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/run.json',
        expect.stringContaining('"attempts": []'),
        'utf-8',
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
            backendConfigured: 'two-phase',
            backendSelected: 'two-phase',
            provider: 'openai',
            verificationScripts: [{ id: 'lint', command: 'npm run lint' }],
            startedAt: '2026-04-09T00:00:00.000Z',
          },
          attempts: [],
        }),
      );

      const attempt: VerificationAttemptArtifact = {
        ticketKey: 'WBP-1000',
        attemptNumber: 1,
        backend: 'two-phase',
        command: 'npm run lint',
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
        'utf-8',
      );
    });
  });
});
