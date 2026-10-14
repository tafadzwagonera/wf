import { execFile, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigurationError, ExecutionError } from '../shared/errors/app.error';
import { appendToLogFile } from '../shared/logger/log-file-writer';
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
  output?: string;
};

export type SonarScanResult = {
  status: 'clean' | 'findings';
  findingsText?: string;
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

/**
 * Structured record for a scan's overall outcome, persisted regardless of status. `onProgress`
 * only reports the overall result on the clean path (see the call in `runSonarScan`) — a findings
 * result is otherwise only ever announced per individual step — so without this record a findings
 * scan's overall outcome, and a clean scan's outcome entirely, would leave no trace in the log.
 */
const logScanOutcome = (
  status: 'clean' | 'findings', repoDir: string, scope: SonarScanScope, steps: SonarStepOutcome[]
): void => {
  const rendered = [
    `repoDir=${repoDir}`,
    `scope=${scope.kind}`,
    `steps=${steps.map(s => `${s.step}:${s.status}`).join(',')}`,
  ].join(' ');
  appendToLogFile(status === 'findings' ? 'WARN' : 'INFO', `sonar.scan.${status} ${rendered}`, 'sonar-scanner');
};

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

  const detail = output ? `: ${output}` : '.';
  throw new ExecutionError(`SonarQube ${step} exited with code ${code}${detail}`);
};

const handleSonarStepCallback = (
  step: 'secrets' | 'analyze',
  err: Error | null,
  stdout: string,
  stderr: string,
  timeoutMs: number,
  onProgress?: StageProgressCallback
): SonarStepOutcome => {
  assertNotTimedOut(step, err as ExecFileError | null, timeoutMs);
  const code = (err as ExecFileError | null)?.code ?? 0;
  const output = [stdout, stderr].filter(Boolean).join('\n').trim();
  return buildSonarStepOutcome(step, code, output, onProgress);
};

const assertNotTimedOut = (
  step: 'secrets' | 'analyze',
  err: ExecFileError | null,
  timeoutMs: number
): void => {
  if (!isTimeoutError(err)) return;
  throw new ExecutionError(`SonarQube ${step} timed out after ${timeoutMs}ms`);
};

const buildSonarStepOutcome = (
  step: 'secrets' | 'analyze',
  code: number,
  output: string,
  onProgress?: StageProgressCallback
): SonarStepOutcome => {
  const status = classifyExitCode(step, code, output);
  if (status === 'findings') onProgress?.(`SonarQube ${step}: findings detected`);
  return { step, status, exitCode: code, output: output || undefined };
};

const executeSonarStep = (
  args: string[],
  repoDir: string,
  timeoutMs: number,
): Promise<{ err: Error | null; stdout: string; stderr: string }> => new Promise(resolve => {
  execFile(
    'sonar',
    args,
    { cwd: repoDir, timeout: timeoutMs, maxBuffer: SONAR_MAX_BUFFER },
    (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' })
  );
});

const runSonarStep = async (
  step: 'secrets' | 'analyze',
  args: string[],
  repoDir: string,
  timeoutMs: number,
  onProgress?: StageProgressCallback
): Promise<SonarStepOutcome> => {
  const { err, stdout, stderr } = await executeSonarStep(args, repoDir, timeoutMs);
  return handleSonarStepCallback(step, err, stdout, stderr, timeoutMs, onProgress);
};

const buildFindingsText = (steps: SonarStepOutcome[]): string | undefined => {
  const findings = steps
    .filter(step => step.status === 'findings' && step.output)
    .map(step => `SonarQube ${step.step} findings:\n${step.output}`);
  return findings.length > 0 ? findings.join('\n\n') : undefined;
};

const reportMissingSecretPaths = (
  missing: string[],
  onProgress?: StageProgressCallback
): void => {
  if (missing.length === 0) return;
  const message = `SonarQube secrets: skipping ${missing.length} path(s) missing on disk (deleted or renamed): ${missing.join(', ')}`;
  onProgress?.(message);
  appendToLogFile('WARN', message, 'sonar-scanner');
};

const runSecretsStep = async (
  repoDir: string,
  secretPaths: string[] | undefined,
  timeoutMs: number,
  onProgress?: StageProgressCallback
): Promise<{ steps: SonarStepOutcome[]; hasFindings: boolean }> => {
  const paths = secretPaths ?? [];
  const existing = paths.filter(p => existsSync(join(repoDir, p)));
  reportMissingSecretPaths(paths.filter(p => !existsSync(join(repoDir, p))), onProgress);
  if (existing.length === 0) {
    return { steps: [{ step: 'secrets', status: 'skipped', exitCode: null }], hasFindings: false };
  }
  const result = await runSonarStep('secrets', ['analyze', 'secrets', ...existing], repoDir, timeoutMs, onProgress);
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
    return { steps: [{ step: 'analyze', status: 'skipped', exitCode: null }], hasFindings: secretsHasFindings };
  }
  const result = await runSonarStep('analyze', buildAnalyzeArgs(scope, depth), repoDir, timeoutMs, onProgress);
  return { steps: [result], hasFindings: result.status === 'findings' || secretsHasFindings };
};

/**
 * Runs SonarQube analysis on the specified change set, optionally including a secrets scan.
 * Secrets are scanned before code analysis to detect hardcoded secrets before transmission.
 * Secret paths missing on disk (deleted or renamed files) are skipped with a warning, since
 * the CLI rejects the whole batch with exit code 2 when any path does not exist.
 *
 * @param options Configuration for the scan
 * @returns A result object with overall status and per-step outcomes
 * @throws ConfigurationError if the SonarQube CLI is missing or setup is misconfigured
 * @throws ExecutionError for execution failures or timeouts
 */
export async function runSonarScan(options: SonarScanOptions): Promise<SonarScanResult> {
  ensureSonarCliAvailable();
  const timeoutMs = options.timeoutMs ?? SONAR_TIMEOUT_MS;
  const { steps, status } = await collectScanSteps(options, timeoutMs);
  return finalizeSonarScan(options, steps, status);
}

const collectScanSteps = async (
  options: SonarScanOptions,
  timeoutMs: number
): Promise<{ steps: SonarStepOutcome[]; status: 'clean' | 'findings' }> => {
  const secretsResult = await runSecretsStep(options.repoDir, options.secretPaths, timeoutMs, options.onProgress);
  const analyzeResult = await runAnalyzeAfterSecrets(options, timeoutMs, secretsResult.hasFindings);
  const steps = [...secretsResult.steps, ...analyzeResult.steps];
  return { steps, status: analyzeResult.hasFindings ? 'findings' : 'clean' };
};

const runAnalyzeAfterSecrets = (
  options: SonarScanOptions,
  timeoutMs: number,
  secretsHasFindings: boolean
): Promise<{ steps: SonarStepOutcome[]; hasFindings: boolean }> => runAnalyzeStep(
  options.repoDir,
  options.scope,
  options.depth,
  timeoutMs,
  secretsHasFindings,
  options.onProgress
);

const finalizeSonarScan = (
  options: SonarScanOptions,
  steps: SonarStepOutcome[],
  status: 'clean' | 'findings'
): SonarScanResult => {
  const findingsText = buildFindingsText(steps);
  logScanOutcome(status, options.repoDir, options.scope, steps);
  if (status === 'clean') {
    options.onProgress?.(`SonarQube scan: clean — no issues found (scope=${options.scope.kind})`);
  }
  return { status, steps, findingsText };
};
