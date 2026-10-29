/**
 * Manual smoke test: issue:implement's headless Claude CLI backend never sees ANTHROPIC_API_KEY
 *
 * Run: nr test:manual claude-cli-strips-anthropic-api-key.smoke
 *
 * Scenario: ANTHROPIC_API_KEY is exported in the parent shell and issue:implement runs with
 * `implement: { provider: 'anthropic', backend: 'cli' }`. The spawned `claude` process must not
 * receive ANTHROPIC_API_KEY in its own environment, so Claude Code falls back to its authenticated
 * account/session login instead of API-key billing.
 *
 * Verify:
 *   1. The run exits 0.
 *   2. The fake `claude` binary's recorded environment shows ANTHROPIC_API_KEY absent on every call.
 *   3. Unrelated env vars (PATH) are still present in the fake binary's recorded environment.
 */
import { restoreEnv, withEnv } from '../../src/common/testing/env';
import {
  cleanupHarness, type EnvReportEntry, readEnvReport, type RunResult, runImplement, setupImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function verifyRun({ exitCode, output }: RunResult): void {
  if (exitCode === 0) {
    pass('issue:implement exits 0');
  } else {
    fail('issue:implement exits 0', `exitCode=${exitCode}\n${output.slice(-800)}`);
  }
}

function checkInvocationRecorded(report: EnvReportEntry[]): void {
  if (report.length > 0) {
    pass(`fake claude recorded ${report.length} invocation(s)`);
  } else {
    fail('fake claude recorded at least one invocation', 'env-report.log was empty');
  }
}

function checkKeyAbsent(report: EnvReportEntry[]): void {
  if (report.length > 0 && report.every(entry => !entry.hasAnthropicApiKey)) {
    pass('ANTHROPIC_API_KEY is absent from every claude invocation env');
  } else {
    fail('ANTHROPIC_API_KEY is absent from every claude invocation env', JSON.stringify(report));
  }
}

function checkPathPresent(report: EnvReportEntry[]): void {
  if (report.length > 0 && report.every(entry => entry.hasPath)) {
    pass('PATH is still present in the claude invocation env');
  } else {
    fail('PATH is still present in the claude invocation env', JSON.stringify(report));
  }
}

function verifyEnvReport(report: EnvReportEntry[]): void {
  checkInvocationRecorded(report);
  checkKeyAbsent(report);
  checkPathPresent(report);
}

async function main(): Promise<void> {
  console.log('\n issue:implement (claude-cli backend) strips ANTHROPIC_API_KEY\n');

  const harness = setupImplementHarness('wf-claude-cli-strip-key-', 'noop', ['src/a.ts']);
  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-leaked-test' });

  try {
    verifyRun(runImplement(harness));
    verifyEnvReport(readEnvReport(harness));
  } finally {
    restoreEnv();
    cleanupHarness(harness);
  }

  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
