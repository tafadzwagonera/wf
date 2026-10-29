/**
 * Manual smoke test: issue:implement's headless Codex CLI backend never sees OPENAI_API_KEY
 *
 * Run: nr test:manual codex-cli-strips-openai-api-key.smoke
 *
 * Scenario: OPENAI_API_KEY is exported in the parent shell and issue:implement runs with
 * `implement: { provider: 'openai', backend: 'cli' }`. The spawned `codex` process must not
 * receive OPENAI_API_KEY in its own environment, so the Codex CLI falls back to its authenticated
 * account/session login instead of API-key billing.
 *
 * Verify:
 *   1. The run exits 0.
 *   2. The fake `codex` binary's recorded environment shows OPENAI_API_KEY absent on every call.
 *   3. Unrelated env vars (PATH) are still present in the fake binary's recorded environment.
 */
import { restoreEnv, withEnv } from '../../src/common/testing/env';
import {
  cleanupCodexHarness, type CodexEnvReportEntry, readCodexEnvReport, runCodexImplement, setupCodexImplementHarness,
} from './support/codex-implement-harness';
import { createReporter, summarise } from './support/reporter';
import type { RunResult } from './support/implement-cli-harness';

const { counts, pass, fail } = createReporter();

function verifyRun({ exitCode, output }: RunResult): void {
  if (exitCode === 0) {
    pass('issue:implement exits 0');
  } else {
    fail('issue:implement exits 0', `exitCode=${exitCode}\n${output.slice(-800)}`);
  }
}

function checkInvocationRecorded(report: CodexEnvReportEntry[]): void {
  if (report.length > 0) {
    pass(`fake codex recorded ${report.length} invocation(s)`);
  } else {
    fail('fake codex recorded at least one invocation', 'env-report.log was empty');
  }
}

function checkKeyAbsent(report: CodexEnvReportEntry[]): void {
  if (report.length > 0 && report.every(entry => !entry.hasOpenaiApiKey)) {
    pass('OPENAI_API_KEY is absent from every codex invocation env');
  } else {
    fail('OPENAI_API_KEY is absent from every codex invocation env', JSON.stringify(report));
  }
}

function checkPathPresent(report: CodexEnvReportEntry[]): void {
  if (report.length > 0 && report.every(entry => entry.hasPath)) {
    pass('PATH is still present in the codex invocation env');
  } else {
    fail('PATH is still present in the codex invocation env', JSON.stringify(report));
  }
}

function verifyEnvReport(report: CodexEnvReportEntry[]): void {
  checkInvocationRecorded(report);
  checkKeyAbsent(report);
  checkPathPresent(report);
}

async function main(): Promise<void> {
  console.log('\n issue:implement (codex-cli backend) strips OPENAI_API_KEY\n');

  const harness = setupCodexImplementHarness('wf-codex-cli-strip-key-', ['src/a.ts']);
  withEnv({ OPENAI_API_KEY: 'sk-openai-leaked-test' });

  try {
    verifyRun(runCodexImplement(harness));
    verifyEnvReport(readCodexEnvReport(harness));
  } finally {
    restoreEnv();
    cleanupCodexHarness(harness);
  }

  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
