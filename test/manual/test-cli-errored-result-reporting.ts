/**
 * Manual smoke test: CLI adapter errored result reporting via describeCliFailure()
 *
 * Run: nr test:manual -- test-cli-errored-result-reporting
 *
 * Verifies:
 *   1. A full error result (errors, terminal_reason, subtype, num_turns) surfaces all fields
 *   2. A minimal error result (subtype, num_turns only) surfaces subtype and turns
 *   3. A bare error result (is_error only) falls back to "unknown error"
 *   4. An error result with only result string surfaces that string
 *
 * @returns void
 */
import chalk from 'chalk';
import { ClaudeCliAdapter } from '../../src/integrations/ai/adapters/claude-cli.adapter';
import * as cliRunner from '../../src/integrations/ai/adapters/claude-cli-runner';

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

const makeParams = () => ({
  ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
  planArtifact: {
    plan: {
      action: 'feature' as const,
      summary: 'test',
      steps: ['step 1'],
      estimatedComplexity: 'low' as const,
      affectedFiles: [],
      affectedRepositories: [],
      risks: [],
    },
    action: 'feature' as const,
    path: '/tmp/p.json',
  },
  options: { trackerName: 'jira', repoDir: '/repo' },
  verificationScripts: [],
  repoFiles: [],
  repoName: 'repo',
  trackedFilePaths: [],
  conventionsSection: 'conventions',
});

async function runWithMessage(msg: Record<string, unknown>): Promise<Error | null> {
  (cliRunner as Record<string, unknown>).assertClaudeCliAvailable = () => undefined;
  (cliRunner as Record<string, unknown>).buildCliArgs = () => ['-p', '--output-format', 'stream-json'];
  (cliRunner as Record<string, unknown>).spawnCli = async function* () {
    yield msg;
  };

  // Suppress console output from the adapter
  const originalLog = console.log;
  console.log = () => undefined;

  let caughtError: Error | null = null;
  try {
    const mockConfigService = {
      get: (_key: string, fallback?: unknown) => fallback,
    };
    const adapter = new ClaudeCliAdapter(mockConfigService as never);
    await adapter.generateAndVerify(makeParams());
  } catch (err) {
    caughtError = err instanceof Error ? err : new Error(String(err));
  } finally {
    console.log = originalLog;
    (cliRunner as Record<string, unknown>).assertClaudeCliAvailable = originalAssert;
    (cliRunner as Record<string, unknown>).buildCliArgs = originalBuild;
    (cliRunner as Record<string, unknown>).spawnCli = originalSpawn;
  }

  return caughtError;
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nCLI errored result reporting smoke test\n'));

  // Case 1: full error message with errors[], terminal_reason, subtype, num_turns
  {
    const msg = {
      type: 'result',
      is_error: true,
      errors: ['tool execution aborted'],
      terminal_reason: 'aborted_tools',
      subtype: 'error_during_execution',
      num_turns: 12,
    };
    const err = await runWithMessage(msg);
    assert(
      'Case 1: error is thrown',
      err !== null,
      'expected an error to be thrown but none was'
    );
    assert(
      'Case 1: message contains errors[] entry',
      err?.message.includes('tool execution aborted') ?? false,
      `message was: ${err?.message}`
    );
    assert(
      'Case 1: message contains terminal_reason',
      err?.message.includes('terminal_reason=aborted_tools') ?? false,
      `message was: ${err?.message}`
    );
    assert(
      'Case 1: message contains subtype',
      err?.message.includes('subtype=error_during_execution') ?? false,
      `message was: ${err?.message}`
    );
    assert(
      'Case 1: message contains num_turns',
      err?.message.includes('turns=12') ?? false,
      `message was: ${err?.message}`
    );
  }

  // Case 2: minimal error — only subtype and num_turns
  {
    const msg = {
      type: 'result',
      is_error: true,
      subtype: 'error_max_turns',
      num_turns: 40,
    };
    const err = await runWithMessage(msg);
    assert(
      'Case 2: error is thrown',
      err !== null,
      'expected an error to be thrown but none was'
    );
    assert(
      'Case 2: message contains subtype',
      err?.message.includes('subtype=error_max_turns') ?? false,
      `message was: ${err?.message}`
    );
    assert(
      'Case 2: message contains num_turns',
      err?.message.includes('turns=40') ?? false,
      `message was: ${err?.message}`
    );
  }

  // Case 3: bare error — is_error only, should fall back to "unknown error"
  {
    const msg = {
      type: 'result',
      is_error: true,
    };
    const err = await runWithMessage(msg);
    assert(
      'Case 3: error is thrown',
      err !== null,
      'expected an error to be thrown but none was'
    );
    assert(
      'Case 3: message is the literal fallback',
      err?.message === 'Claude CLI failed: unknown error',
      `message was: ${err?.message}`
    );
  }

  // Case 4: error with result string — surfaces that string
  {
    const msg = {
      type: 'result',
      is_error: true,
      result: 'explicit reason',
    };
    const err = await runWithMessage(msg);
    assert(
      'Case 4: error is thrown',
      err !== null,
      'expected an error to be thrown but none was'
    );
    assert(
      'Case 4: message contains explicit result string',
      err?.message.includes('explicit reason') ?? false,
      `message was: ${err?.message}`
    );
  }

  // Summary
  console.log(
    chalk.bold(
      `\n${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`
    )
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main();
