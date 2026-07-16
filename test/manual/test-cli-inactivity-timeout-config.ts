/**
 * Manual smoke test: Configurable CLI inactivity timeout via stages config
 *
 * Run: nr test:manual -- test-cli-inactivity-timeout-config
 *
 * Verifies:
 *   1. Schema accepts inactivityTimeoutMs (valid integer ≥ 1000)
 *   2. Schema accepts timeoutMs (valid integer ≥ 1000)
 *   3. Schema rejects inactivityTimeoutMs below 1000
 *   4. Schema rejects non-integer inactivityTimeoutMs
 *   5. Config normalization passes inactivityTimeoutMs through to normalized output
 *   6. Config normalization passes timeoutMs through to normalized output
 *   7. Omitting both timeout fields produces undefined (ConfigService falls back to defaults)
 *   8. CLI_INACTIVITY_TIMEOUT_MS is exported from claude-cli-runner and equals 120 000
 *
 * @returns void
 */
import chalk from 'chalk';
import { wfAiStageTargetConfigSchema } from '../../src/shared/schemas/config.schema';
import { normalizeWfConfig } from '../../src/config/wf-config-loader';
import { CLI_INACTIVITY_TIMEOUT_MS } from '../../src/integrations/ai/adapters/claude-cli-runner';

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

function main(): void {
  console.log(chalk.bold('\nCLI inactivity timeout config smoke test\n'));

  // 1. Schema accepts inactivityTimeoutMs (valid integer ≥ 1000)
  const validResult = wfAiStageTargetConfigSchema.safeParse({
    provider: 'anthropic',
    inactivityTimeoutMs: 600000,
  });
  assert('schema accepts valid inactivityTimeoutMs', validResult.success, `error: ${JSON.stringify(validResult.error?.issues)}`);

  // 2. Schema accepts timeoutMs (valid integer ≥ 1000)
  const timeoutResult = wfAiStageTargetConfigSchema.safeParse({
    provider: 'anthropic',
    timeoutMs: 1800000,
  });
  assert('schema accepts valid timeoutMs', timeoutResult.success, `error: ${JSON.stringify(timeoutResult.error?.issues)}`);

  // 3. Schema rejects inactivityTimeoutMs below 1000
  const belowMinResult = wfAiStageTargetConfigSchema.safeParse({
    provider: 'anthropic',
    inactivityTimeoutMs: 500,
  });
  assert('schema rejects inactivityTimeoutMs below 1000', !belowMinResult.success);

  // 4. Schema rejects non-integer inactivityTimeoutMs
  const nonIntResult = wfAiStageTargetConfigSchema.safeParse({
    provider: 'anthropic',
    inactivityTimeoutMs: 1500.5,
  });
  assert('schema rejects non-integer inactivityTimeoutMs', !nonIntResult.success);

  // 5. Config normalization passes inactivityTimeoutMs through
  try {
    const config = normalizeWfConfig({
      ai: [{ provider: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-4-6', default: true }],
      stages: {
        review: {
          provider: 'anthropic',
          backend: 'cli',
          inactivityTimeoutMs: 600000,
        },
      },
    });
    assert(
      'normalization passes inactivityTimeoutMs through',
      config.stages.review?.inactivityTimeoutMs === 600000,
      `got: ${config.stages.review?.inactivityTimeoutMs}`
    );
  } catch (error) {
    fail('normalization passes inactivityTimeoutMs through', `threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 6. Config normalization passes timeoutMs through
  try {
    const config = normalizeWfConfig({
      ai: [{ provider: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-4-6', default: true }],
      stages: {
        review: {
          provider: 'anthropic',
          backend: 'cli',
          timeoutMs: 1800000,
        },
      },
    });
    assert(
      'normalization passes timeoutMs through',
      config.stages.review?.timeoutMs === 1800000,
      `got: ${config.stages.review?.timeoutMs}`
    );
  } catch (error) {
    fail('normalization passes timeoutMs through', `threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 7. Omitting both timeout fields produces undefined
  try {
    const config = normalizeWfConfig({
      ai: [{ provider: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-4-6', default: true }],
      stages: {
        plan: {
          provider: 'anthropic',
          backend: 'cli',
        },
      },
    });
    assert(
      'omitting timeout fields produces undefined',
      config.stages.plan?.inactivityTimeoutMs === undefined && config.stages.plan?.timeoutMs === undefined,
      `got inactivityTimeoutMs: ${config.stages.plan?.inactivityTimeoutMs}, timeoutMs: ${config.stages.plan?.timeoutMs}`
    );
  } catch (error) {
    fail('omitting timeout fields produces undefined', `threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 8. CLI_INACTIVITY_TIMEOUT_MS is exported and equals 120000
  assert(
    'CLI_INACTIVITY_TIMEOUT_MS is exported and equals 120000',
    CLI_INACTIVITY_TIMEOUT_MS === 120000,
    `got: ${CLI_INACTIVITY_TIMEOUT_MS}`
  );

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
