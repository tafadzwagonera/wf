import { execFile, execSync } from 'node:child_process';
import { ConfigurationError, ExecutionError } from '../shared/errors/app.error';
import type { StageProgressCallback } from '../shared/types/agent.types';

const SONAR_TIMEOUT_MS = 120_000;
const SONAR_MAX_BUFFER = 4 * 1024 * 1024;

export type SonarScanScope
  = { kind: 'staged' }
    | { kind: 'base'; ref: string }
    | { kind: 'files'; paths: string[] }
    | { kind: 'branch' };

export type SonarStepOutcome = {
  step: 'secrets' | 'analyze';
  status: 'clean' | 'findings' | 'skipped';
  exitCode: number | null;
};

export type SonarScanResult = {
  status: 'clean' | 'findings';
  steps: SonarStepOutcome[];
};

interface SonarScanOptions {
  repoDir: string;
  scope: SonarScanScope;
  secretPaths?: string[];
  depth?: 'STANDARD' | 'DEEP';
  timeoutMs?: number;
  onProgress?: StageProgressCallback;
}

const ensureSonarCliAvailable = (): void => {
  try {
    execSync('command -v sonar', { stdio: 'pipe' });
  } catch {
    throw new ConfigurationError(
      'SonarQube CLI not found. Install with `brew install sonarqube-cli`.'
    );
  }
};

const buildScopeArgs = (scope: SonarScanScope): string[] => {
  if (scope.kind === 'staged') {
    return ['--staged'];
  }
  if (scope.kind === 'base') {
    return ['--base', scope.ref];
  }
  if (scope.kind === 'branch') {
    return [];
  }
  return scope.paths.flatMap(p => ['--file', p]);
};

const buildAnalyzeArgs = (scope: SonarScanScope, depth?: string): string[] => {
  const scopeArgs = buildScopeArgs(scope);
  return ['analyze', ...scopeArgs, '--force', '--format', 'text', '--depth', depth || 'STANDARD'];
};

type ExecFileError = Error & { code?: number; killed?: boolean; signal?: string };

const isTimeoutError = (err: ExecFileError | null): boolean => {
  if (!err) return false;
  return Boolean(err.killed || err.signal);
};

const isSetupError = (output: string): boolean => {
  return /not authenticated|unknown project|project not found/i.test(output);
};

const classifyExitCode = (
  step: 'secrets' | 'analyze',
  code: number | undefined,
  output: string
): 'clean' | 'findings' => {
  if (code === 0) return 'clean';
  if (code === 51) return 'findings';

  if (isSetupError(output)) {
    throw new ConfigurationError(`SonarQube ${step} failed: ${output}`);
  }

  throw new ExecutionError(`SonarQube ${step} exited with code ${code}.`);
};

const handleSonarStepCallback = (
  step: 'secrets' | 'analyze',
  err: Error | null,
  stderr: string,
  timeoutMs: number,
  onProgress?: StageProgressCallback
): SonarStepOutcome => {
  if (isTimeoutError(err as ExecFileError | null)) {
    throw new ExecutionError(`SonarQube ${step} timed out after ${timeoutMs}ms`);
  }
  const code = (err as ExecFileError | null)?.code ?? 0;
  const status = classifyExitCode(step, code, stderr);
  if (status === 'findings') onProgress?.(`SonarQube ${step}: findings detected`);
  return { step, status, exitCode: code };
};

const runSonarStep = async (
  step: 'secrets' | 'analyze',
  args: string[],
  repoDir: string,
  timeoutMs: number,
  onProgress?: StageProgressCallback
): Promise<SonarStepOutcome> => new Promise((resolve, reject) => {
  execFile('sonar', args, { cwd: repoDir, timeout: timeoutMs, maxBuffer: SONAR_MAX_BUFFER }, (err, _stdout, stderr) => {
    try {
      resolve(handleSonarStepCallback(step, err, stderr || '', timeoutMs, onProgress));
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
});

const runSecretsStep = async (
  repoDir: string,
  secretPaths: string[] | undefined,
  timeoutMs: number,
  onProgress?: StageProgressCallback
): Promise<{ steps: SonarStepOutcome[]; hasFindings: boolean }> => {
  if (!secretPaths || secretPaths.length === 0) {
    return { steps: [{ step: 'secrets', status: 'skipped', exitCode: null }], hasFindings: false };
  }
  const result = await runSonarStep('secrets', ['analyze', 'secrets', ...secretPaths], repoDir, timeoutMs, onProgress);
  return { steps: [result], hasFindings: result.status === 'findings' };
};

const runAnalyzeStep = async (
  repoDir: string,
  scope: SonarScanScope,
  depth: string | undefined,
  timeoutMs: number,
  secretsHasFindings: boolean,
  onProgress?: StageProgressCallback
): Promise<{ steps: SonarStepOutcome[]; hasFindings: boolean }> => {
  if (scope.kind === 'files' && scope.paths.length === 0) {
    return { steps: [{ step: 'analyze', status: 'skipped', exitCode: null }], hasFindings: false };
  }
  const result = await runSonarStep('analyze', buildAnalyzeArgs(scope, depth), repoDir, timeoutMs, onProgress);
  return { steps: [result], hasFindings: result.status === 'findings' || secretsHasFindings };
};

/**
 * Runs SonarQube analysis on the specified change set, optionally including a secrets scan.
 * Secrets are scanned before code analysis to detect hardcoded secrets before transmission.
 *
 * @param options Configuration for the scan
 * @returns A result object with overall status and per-step outcomes
 * @throws ConfigurationError if the SonarQube CLI is missing or setup is misconfigured
 * @throws ExecutionError for execution failures or timeouts
 */
export async function runSonarScan(options: SonarScanOptions): Promise<SonarScanResult> {
  ensureSonarCliAvailable();
  const timeoutMs = options.timeoutMs ?? SONAR_TIMEOUT_MS;
  const secretsResult = await runSecretsStep(options.repoDir, options.secretPaths, timeoutMs, options.onProgress);
  const analyzeResult = await runAnalyzeStep(
    options.repoDir, options.scope, options.depth, timeoutMs, secretsResult.hasFindings, options.onProgress
  );
  return {
    status: analyzeResult.hasFindings ? 'findings' : 'clean',
    steps: [...secretsResult.steps, ...analyzeResult.steps],
  };
}
