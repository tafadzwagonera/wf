/**
 * Manual smoke test: CLI adapter diagnostic logging from NDJSON messages
 *
 * Run: nr test:manual cli-diagnostic-logging.smoke.ts
 *
 * Verifies:
 *   1. Assistant messages with Write tool_use log "File created"
 *   2. Assistant messages with Edit tool_use log "File updated"
 *   3. Assistant messages with Bash tool_use log "Verification running"
 *   4. User messages with successful tool_result log "Verification passed"
 *   5. User messages with error tool_result log "Verification failed"
 *   6. Assistant messages with Read tool_use log tool activity
 *   7. Rate limit events still log via SDK-compatible path
 *   8. Cost and turn count are logged from result messages
 *
 * @returns void
 */
import chalk from 'chalk';
import { ClaudeCliAdapter } from '../../src/integrations/ai/adapters/claude-cli.adapter';
import * as cliRunner from '../../src/integrations/ai/adapters/claude-cli-runner';
import { createReporter, summarise } from './support/reporter';

const originalAssert = cliRunner.assertClaudeCliAvailable;
const originalBuild = cliRunner.buildCliArgs;
const originalSpawn = cliRunner.spawnCli;

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
};

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replaceAll(/\x1b\[[0-9;]*m/g, '');

const makePlan = () => ({
  action: 'feature' as const,
  summary: 'test',
  steps: ['step 1'],
  estimatedComplexity: 'low' as const,
  affectedFiles: [],
  affectedRepositories: [],
  risks: [],
});

const makeParams = () => ({
  ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
  planArtifact: {
    plan: makePlan(),
    action: 'feature' as const,
    path: '/tmp/p.json',
  },
  options: { trackerName: 'jira', repoDir: '/repo' },
  verificationScripts: [],
  ticketContext: 'context',
  repoFiles: [],
  repoName: 'repo',
  trackedFilePaths: [],
});

const DIAGNOSTIC_MESSAGES: Record<string, unknown>[] = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/repo/src/new-file.ts' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/existing.ts' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/package.json' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'All tests passed successfully', is_error: false }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run lint' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'Lint failed with 3 errors', is_error: false }] } },
  { type: 'rate_limit_event' },
  { type: 'result', result: 'Implementation complete.', session_id: 's1', num_turns: 5, total_cost_usd: 0.12 },
];

function patchRunnerForMessages(messages: Record<string, unknown>[]): void {
  (cliRunner as Record<string, unknown>).assertClaudeCliAvailable = () => undefined;
  (cliRunner as Record<string, unknown>).buildCliArgs = () => ['-p', '--output-format', 'stream-json'];
  (cliRunner as Record<string, unknown>).spawnCli = async function* () {
    for (const msg of messages) {
      yield msg;
    }
  };
}

function restoreRunnerExports(): void {
  (cliRunner as Record<string, unknown>).assertClaudeCliAvailable = originalAssert;
  (cliRunner as Record<string, unknown>).buildCliArgs = originalBuild;
  (cliRunner as Record<string, unknown>).spawnCli = originalSpawn;
}

const createLogInterceptor = (captured: string[]) => (...args: unknown[]) => {
  captured.push(stripAnsi(String(args[0])));
};

async function runWithMessages(messages: Record<string, unknown>[]): Promise<string[]> {
  patchRunnerForMessages(messages);
  const captured: string[] = [];
  const originalLog = console.log;
  console.log = createLogInterceptor(captured);
  try {
    const mockConfigService = { get: (_key: string, fallback?: unknown) => fallback };
    const adapter = new ClaudeCliAdapter(mockConfigService as never);
    await adapter.generateAndVerify(makeParams());
  } finally {
    console.log = originalLog;
    restoreRunnerExports();
  }
  return captured;
}

function checkToolUseLogs(lines: string[]): void {
  assert('Write tool_use logs File created', lines.some(l => /File created.*new-file\.ts/.test(l)), `no match in: ${lines.filter(l => /File/.test(l)).join(' | ') || '(none)'}`);
  assert('Edit tool_use logs File updated', lines.some(l => /File updated.*existing\.ts/.test(l)), `no match in: ${lines.filter(l => /File/.test(l)).join(' | ') || '(none)'}`);
  assert('Bash tool_use logs Verification running', lines.some(l => /Verification running.*npm test/.test(l)), `no match in: ${lines.filter(l => /Verification/.test(l)).join(' | ') || '(none)'}`);
  assert('Successful tool_result logs Verification passed', lines.some(l => /Verification passed.*npm test/.test(l)), `no match in: ${lines.filter(l => /Verification/.test(l)).join(' | ') || '(none)'}`);
  assert('Failed tool_result logs Verification failed', lines.some(l => /Verification failed.*npm run lint/.test(l)), `no match in: ${lines.filter(l => /Verification/.test(l)).join(' | ') || '(none)'}`);
}

function checkMetaLogs(lines: string[], noSessionLines: string[]): void {
  assert('Read tool_use logs tool activity', lines.some(l => /Read.*package\.json/.test(l)), `no match in: ${lines.filter(l => /Read/.test(l)).join(' | ') || '(none)'}`);
  assert('rate_limit_event logs via SDK-compatible path', lines.some(l => /Rate limit/.test(l)), `no match in: ${lines.filter(l => /[Rr]ate/.test(l)).join(' | ') || '(none)'}`);
  assert('Result logs turn count', lines.some(l => /Completed in 5 turn/.test(l)), `no match in: ${lines.filter(l => /turn/.test(l)).join(' | ') || '(none)'}`);
  assert('Result logs cost', lines.some(l => /Cost.*\$0\.1200/.test(l)), `no match in: ${lines.filter(l => /Cost/.test(l)).join(' | ') || '(none)'}`);
  assert('Result logs session ID', lines.some(l => /Provider session:.*s1/.test(l)), `no match in: ${lines.filter(l => /[Ss]ession/.test(l)).join(' | ') || '(none)'}`);
  assert('No Session: line when session_id is absent', !noSessionLines.some(l => /Session:/.test(l)), `unexpected match in: ${noSessionLines.filter(l => /Session/.test(l)).join(' | ')}`);
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nCLI diagnostic logging smoke test\n'));
  const lines = await runWithMessages(DIAGNOSTIC_MESSAGES);
  const noSessionLines = await runWithMessages([{ type: 'result', result: 'done', num_turns: 1, total_cost_usd: 0.01 }]);
  checkToolUseLogs(lines);
  checkMetaLogs(lines, noSessionLines);
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
