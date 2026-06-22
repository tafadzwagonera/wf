/**
 * Manual smoke test: CLI adapter diagnostic logging from NDJSON messages
 *
 * Run: nr test:manual -- test-cli-diagnostic-logging
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

// Stub the runner module so no real subprocess is spawned
const originalAssert = cliRunner.assertClaudeCliAvailable;
const originalBuild = cliRunner.buildCliArgs;
const originalSpawn = cliRunner.spawnCli;

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
};

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const makeParams = () => ({
  ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
  planArtifact: {
    plan: {
      action: 'feature' as const,
      summary: 'test',
      steps: ['step 1'],
      estimatedComplexity: 'low' as const,
      filesAffected: [],
      repositoriesAffected: [],
      risks: [],
    },
    action: 'feature' as const,
    path: '/tmp/p.json',
  },
  options: { trackerName: 'jira', repoDir: '/repo' },
  verificationScripts: [],
  sceneContext: 'context',
  repoFiles: [],
  repoName: 'repo',
  trackedFilePaths: [],
});

async function runWithMessages(
  messages: Record<string, unknown>[],
): Promise<string[]> {
  // Monkey-patch the runner exports for this run
  (cliRunner as Record<string, unknown>).assertClaudeCliAvailable = () =>
    undefined;
  (cliRunner as Record<string, unknown>).buildCliArgs = () => [
    '-p',
    '--output-format',
    'stream-json',
  ];
  (cliRunner as Record<string, unknown>).spawnCli = async function* () {
    for (const msg of messages) {
      yield msg;
    }
  };

  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(stripAnsi(String(args[0])));
  };

  try {
    const mockConfigService = {
      get: (_key: string, fallback?: unknown) => fallback,
    };
    const adapter = new ClaudeCliAdapter(mockConfigService as never);
    await adapter.generateAndVerify(makeParams());
  } finally {
    console.log = originalLog;
    // Restore originals
    (cliRunner as Record<string, unknown>).assertClaudeCliAvailable =
      originalAssert;
    (cliRunner as Record<string, unknown>).buildCliArgs = originalBuild;
    (cliRunner as Record<string, unknown>).spawnCli = originalSpawn;
  }

  return captured;
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nCLI diagnostic logging smoke test\n'));

  // Run with a sequence that exercises all message types
  const lines = await runWithMessages([
    // 1. Write tool_use
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/repo/src/new-file.ts' },
          },
        ],
      },
    },
    // 2. Edit tool_use
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/repo/src/existing.ts' },
          },
        ],
      },
    },
    // 3. Read tool_use
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/repo/package.json' },
          },
        ],
      },
    },
    // 4. Bash tool_use (verification)
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'npm test' },
          },
        ],
      },
    },
    // 5. Successful tool_result
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: 'All tests passed successfully',
            is_error: false,
          },
        ],
      },
    },
    // 6. Another Bash for failure test
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'npm run lint' },
          },
        ],
      },
    },
    // 7. Failed tool_result
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: 'Lint failed with 3 errors',
            is_error: false,
          },
        ],
      },
    },
    // 8. Rate limit event
    { type: 'rate_limit_event' },
    // 9. Result
    {
      type: 'result',
      result: 'Implementation complete.',
      session_id: 's1',
      num_turns: 5,
      total_cost_usd: 0.12,
    },
  ]);

  // 1. Write → File created
  assert(
    'Write tool_use logs File created',
    lines.some((l) => /File created.*new-file\.ts/.test(l)),
    `no match in: ${lines.filter((l) => /File/.test(l)).join(' | ') || '(none)'}`,
  );

  // 2. Edit → File updated
  assert(
    'Edit tool_use logs File updated',
    lines.some((l) => /File updated.*existing\.ts/.test(l)),
    `no match in: ${lines.filter((l) => /File/.test(l)).join(' | ') || '(none)'}`,
  );

  // 3. Bash → Verification running
  assert(
    'Bash tool_use logs Verification running',
    lines.some((l) => /Verification running.*npm test/.test(l)),
    `no match in: ${lines.filter((l) => /Verification/.test(l)).join(' | ') || '(none)'}`,
  );

  // 4. Successful result → Verification passed
  assert(
    'Successful tool_result logs Verification passed',
    lines.some((l) => /Verification passed.*npm test/.test(l)),
    `no match in: ${lines.filter((l) => /Verification/.test(l)).join(' | ') || '(none)'}`,
  );

  // 5. Failed result → Verification failed
  assert(
    'Failed tool_result logs Verification failed',
    lines.some((l) => /Verification failed.*npm run lint/.test(l)),
    `no match in: ${lines.filter((l) => /Verification/.test(l)).join(' | ') || '(none)'}`,
  );

  // 6. Read → gray tool activity
  assert(
    'Read tool_use logs tool activity',
    lines.some((l) => /Read.*package\.json/.test(l)),
    `no match in: ${lines.filter((l) => /Read/.test(l)).join(' | ') || '(none)'}`,
  );

  // 7. Rate limit event
  assert(
    'rate_limit_event logs via SDK-compatible path',
    lines.some((l) => /Rate limit/.test(l)),
    `no match in: ${lines.filter((l) => /[Rr]ate/.test(l)).join(' | ') || '(none)'}`,
  );

  // 8. Cost and turns from result
  assert(
    'Result logs turn count',
    lines.some((l) => /Completed in 5 turn/.test(l)),
    `no match in: ${lines.filter((l) => /turn/.test(l)).join(' | ') || '(none)'}`,
  );
  assert(
    'Result logs cost',
    lines.some((l) => /Cost.*\$0\.1200/.test(l)),
    `no match in: ${lines.filter((l) => /Cost/.test(l)).join(' | ') || '(none)'}`,
  );

  // 9. Session ID from result
  assert(
    'Result logs session ID',
    lines.some((l) => /Session:.*s1/.test(l)),
    `no match in: ${lines.filter((l) => /Session/.test(l)).join(' | ') || '(none)'}`,
  );

  // 10. No session ID when absent
  const noSessionLines = await runWithMessages([
    {
      type: 'result',
      result: 'done',
      num_turns: 1,
      total_cost_usd: 0.01,
    },
  ]);
  assert(
    'No Session: line when session_id is absent',
    !noSessionLines.some((l) => /Session:/.test(l)),
    `unexpected match in: ${noSessionLines.filter((l) => /Session/.test(l)).join(' | ')}`,
  );

  // Summary
  console.log(
    chalk.bold(
      `\n${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`,
    ),
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main();
