/**
 * Manual smoke test: verificationConditions is a no-op in issue:create
 *
 * Run: nr test:manual -- test-adf-validator-noop
 *
 * Verifies:
 *   1. Joi schema still accepts `verificationConditions` in `stages.create`
 *   2. The normalised config populates `verificationConditions` without error
 *   3. `IssueCreateCommand` no longer imports or references `spawnSync`
 *
 * @returns void
 */
import chalk from 'chalk';
import { normalizeWfConfig } from '../../src/config/wf-config-loader';
import * as fs from 'fs';
import * as path from 'path';

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
  console.log(chalk.bold('\nverificationConditions no-op in issue:create smoke test\n'));

  // 1. Joi still accepts verificationConditions in stages.create
  try {
    const config = normalizeWfConfig({
      ai: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
      stages: {
        create: {
          backend: 'cli',
          provider: 'anthropic',
          verificationConditions: {
            scripts: {
              testVerifyRequestFormat: 'yarn test:manual -- test-verify-request-format',
            },
          },
        },
      },
      tracker: 'jira',
    });
    assert('Joi accepts verificationConditions in stages.create', config != null);
    assert(
      'Normalised config has verificationConditions populated',
      config.stages?.create?.verificationConditions != null
    );
  } catch (error) {
    fail('Joi accepts verificationConditions in stages.create', String(error));
    fail('Normalised config has verificationConditions populated', 'skipped');
  }

  // 2. Config without verificationConditions also works
  try {
    const config = normalizeWfConfig({
      ai: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
      stages: {
        create: {
          backend: 'cli',
          provider: 'anthropic',
        },
      },
      tracker: 'jira',
    });
    assert('Config without verificationConditions in create stage is valid', config != null);
  } catch (error) {
    fail('Config without verificationConditions in create stage is valid', String(error));
  }

  // 3. The compiled command file no longer imports spawnSync or child_process
  const commandDistPath = path.join(__dirname, '../../dist/commands/issue-create.command.js');
  const commandSrcPath = path.join(__dirname, '../../src/commands/issue-create.command.ts');

  const filePath = fs.existsSync(commandDistPath) ? commandDistPath : commandSrcPath;
  const source = fs.readFileSync(filePath, 'utf-8');

  assert('issue-create.command does not import child_process', !source.includes('child_process'));
  assert('issue-create.command does not reference spawnSync', !source.includes('spawnSync'));
  assert(
    'issue-create.command does not reference validateAndCorrectDescription',
    !source.includes('validateAndCorrectDescription')
  );

  // Summary
  console.log(`\n${chalk.bold('Results:')} ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)}\n`);
  if (failed > 0) process.exit(1);
}

main();
