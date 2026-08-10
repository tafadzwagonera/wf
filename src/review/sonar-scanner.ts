import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';

export type SonarScanResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  skipped: boolean;
  skipReason?: string;
};

interface SonarScanOptions {
  repoDir: string;
  timeoutInMs?: number;
  onProgress?: (line: string) => void;
}

/**
 * Checks whether a `sonar-project.properties` file exists in the given repo directory.
 * @param repoDir Absolute path to the repository root
 * @returns true when the file exists, false otherwise
 */
export function hasSonarProjectProperties(repoDir: string): boolean {
  return fs.existsSync(path.join(repoDir, 'sonar-project.properties'));
}

type ExecError = Error & { code?: number; stdout?: string; stderr?: string };

const buildExecErrorResult = (err: ExecError, fallbackOut: string, fallbackErr: string): SonarScanResult => ({
  stdout: err.stdout ?? fallbackOut,
  stderr: err.stderr ?? fallbackErr,
  exitCode: typeof err.code === 'number' ? err.code : 1,
  skipped: false,
});

/**
 * Runs `npx @sonar/scan` in the given repo directory.
 * Never throws — errors are captured and returned as a non-zero exitCode result.
 * @param options Scan configuration
 * @returns Scan result with stdout, stderr, exitCode, and skipped flag
 */
export function runSonarScan(options: SonarScanOptions): Promise<SonarScanResult> {
  const { repoDir, timeoutInMs = 120_000, onProgress } = options;
  onProgress?.('Running SonarScanner...');
  return new Promise(resolve => {
    exec('npx @sonar/scan', { cwd: repoDir, timeout: timeoutInMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve(buildExecErrorResult(err as ExecError, stdout, stderr));
      else resolve({ stdout, stderr, exitCode: 0, skipped: false });
    });
  });
}

/**
 * Builds a SonarScanResult representing a skipped scan.
 * @param reason Human-readable reason for skipping
 */
export function buildSkippedSonarResult(reason: string): SonarScanResult {
  return { stdout: '', stderr: '', exitCode: 0, skipped: true, skipReason: reason };
}

/**
 * Returns true when the review's complexity or pass count warrants waiving the SonarScanner scan.
 * Mirrors the `shouldForkReviewSession` guard logic (strict `>`, not `>=`).
 * @param estimatedComplexity Plan complexity estimate (e.g. 'high')
 * @param passCount Number of verification passes completed by the implementer
 */
export function shouldWaiveSonarScan(estimatedComplexity?: string, passCount?: number): boolean {
  return estimatedComplexity === 'high' || (passCount !== undefined && passCount > 5);
}
