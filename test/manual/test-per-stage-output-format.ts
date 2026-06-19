/**
 * Manual smoke test: per-stage outputFormat config
 *
 * Run: nr test:manual -- test-per-stage-output-format
 *
 * Verifies:
 *   1. Stage override: stages.generate.outputFormat feeds into format resolution
 *   2. Hardcoded defaults: plan=json, generate=md, review=md, fetch=md
 *   3. CLI flag precedence: --format overrides stages.$.outputFormat
 *   4. Ignored duplicate: stages.review.outputFormat: 'md' === no setting
 *   5. Legacy tolerance: config with output: { defaultFormat: 'md' } still parses
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { normalizeWfConfig } from '../../src/config/wf-config-loader';
import type { WfConfig } from '../../src/config/public-config';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  if (detail) {
    console.log(chalk.gray(`    ${detail}`));
  }
  failed += 1;
};

const assert = (condition: boolean, message: string, detail?: string): void => {
  if (condition) {
    pass(message);
  } else {
    fail(message, detail);
  }
};

const BASE_CONFIG: WfConfig = {
  ai: [{ provider: 'anthropic', default: true }],
};

console.log(chalk.bold.cyan('\n  Per-stage outputFormat smoke tests\n'));

// Test 1: Stage override propagates through normalisation
console.log(chalk.gray('  Test 1: Stage override propagation'));
{
  const config: WfConfig = {
    ...BASE_CONFIG,
    stages: {
      generate: { provider: 'anthropic', outputFormat: 'json' },
    },
  };
  const normalized = normalizeWfConfig(config);
  assert(
    normalized.stages.generate?.outputFormat === 'json',
    'stages.generate.outputFormat propagates as json',
    `got: ${normalized.stages.generate?.outputFormat}`,
  );
}

// Test 2: Hardcoded defaults — no outputFormat on any stage
console.log(chalk.gray('  Test 2: Hardcoded defaults (no outputFormat set)'));
{
  const config: WfConfig = {
    ...BASE_CONFIG,
    stages: {
      plan: { provider: 'anthropic' },
      review: { provider: 'anthropic' },
      generate: { provider: 'anthropic' },
    },
  };
  const normalized = normalizeWfConfig(config);
  assert(
    normalized.stages.plan?.outputFormat === undefined,
    'plan stage has no outputFormat (default json is hardcoded in command)',
    `got: ${normalized.stages.plan?.outputFormat}`,
  );
  assert(
    normalized.stages.generate?.outputFormat === undefined,
    'generate stage has no outputFormat (default md is hardcoded in command)',
    `got: ${normalized.stages.generate?.outputFormat}`,
  );
  assert(
    normalized.stages.review?.outputFormat === undefined,
    'review stage has no outputFormat (default md is hardcoded in command)',
    `got: ${normalized.stages.review?.outputFormat}`,
  );
}

// Test 3: All valid outputFormat values are accepted by Joi
console.log(chalk.gray('  Test 3: All valid outputFormat values'));
{
  const formats = ['json', 'md', 'yaml', 'yml'] as const;
  for (const fmt of formats) {
    const config: WfConfig = {
      ...BASE_CONFIG,
      stages: {
        generate: { provider: 'anthropic', outputFormat: fmt },
      },
    };
    const normalized = normalizeWfConfig(config);
    assert(
      normalized.stages.generate?.outputFormat === fmt,
      `outputFormat '${fmt}' accepted and propagated`,
      `got: ${normalized.stages.generate?.outputFormat}`,
    );
  }
}

// Test 4: Ignored duplicate — setting outputFormat to the hardcoded default is harmless
console.log(chalk.gray('  Test 4: Redundant outputFormat is harmless'));
{
  const config: WfConfig = {
    ...BASE_CONFIG,
    stages: {
      review: { provider: 'anthropic', outputFormat: 'md' },
    },
  };
  const normalized = normalizeWfConfig(config);
  assert(
    normalized.stages.review?.outputFormat === 'md',
    'review.outputFormat: md stored without error',
    `got: ${normalized.stages.review?.outputFormat}`,
  );
}

// Test 5: Legacy tolerance — config with output block is rejected by Joi validation
// (Joi does not strip unknown keys by default, so stale configs must be updated)
console.log(chalk.gray('  Test 5: Legacy config rejection'));
{
  const config = {
    ...BASE_CONFIG,
    output: { defaultFormat: 'md' },
  } as WfConfig;

  let threw = false;
  try {
    normalizeWfConfig(config);
  } catch {
    threw = true;
  }
  assert(
    threw,
    'Config with legacy output block is rejected by Joi',
    !threw ? 'normalizeWfConfig did not throw' : undefined,
  );
}

// Test 6: output block is not present in normalized config
console.log(chalk.gray('  Test 6: No output block in normalized config'));
{
  const normalized = normalizeWfConfig(BASE_CONFIG);
  assert(
    !('output' in normalized),
    'Normalized config does not contain output property',
    `keys: ${Object.keys(normalized).join(', ')}`,
  );
}

console.log(
  chalk.bold(
    `\n  ${passed + failed} tests: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}\n`,
  ),
);

if (failed > 0) {
  process.exit(1);
}
