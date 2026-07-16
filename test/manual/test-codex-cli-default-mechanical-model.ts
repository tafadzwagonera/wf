/**
 * Manual smoke test: Codex CLI default mechanical model constant
 *
 * Run: nr test:manual -- test-codex-cli-default-mechanical-model
 *
 * Verifies:
 *   1. DEFAULT_MECHANICAL_MODEL in codex-cli.adapter.ts is 'gpt-5.4-mini'.
 *   2. buildCodexCliArgs passes the model through to the CLI args.
 *   3. resolveModelRouting returns the mechanical model for a low-complexity plan.
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { buildCodexCliArgs } from '../../src/integrations/ai/adapters/codex-cli-runner';
import { resolveModelRouting } from '../../src/integrations/ai/adapters/shared-routing';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed++;
};

const fail = (message: string, detail: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  console.log(chalk.gray(`    ${detail}`));
  failed++;
};

const assert = (condition: boolean, label: string, detail = ''): void => {
  if (condition) return pass(label);
  fail(label, detail || 'assertion failed');
};

async function main(): Promise<void> {
  console.log(chalk.bold('\nCodex CLI default mechanical model smoke test\n'));

  // Test 1: Source file contains the expected constant value
  {
    const adapterPath = path.resolve(__dirname, '../../src/integrations/ai/adapters/codex-cli.adapter.ts');
    const source = fs.readFileSync(adapterPath, 'utf-8');
    const match = /DEFAULT_MECHANICAL_MODEL\s*=\s*'([^']+)'/.exec(source);

    assert(match !== null, 'DEFAULT_MECHANICAL_MODEL constant exists in source', 'constant not found');
    assert(
      match?.[1] === 'gpt-5.4-mini',
      'DEFAULT_MECHANICAL_MODEL is gpt-5.4-mini',
      `got: ${match?.[1] ?? 'undefined'}`
    );
  }

  // Test 2: buildCodexCliArgs includes --model with the expected value
  {
    const args = buildCodexCliArgs({
      prompt: 'test prompt',
      model: 'gpt-5.4-mini',
      cwd: '/tmp',
      permissionMode: 'full-auto',
    });

    const modelIdx = args.indexOf('--model');
    assert(modelIdx !== -1, 'buildCodexCliArgs includes --model flag', `args: ${JSON.stringify(args)}`);
    assert(
      args[modelIdx + 1] === 'gpt-5.4-mini',
      'buildCodexCliArgs passes gpt-5.4-mini as model value',
      `got: ${args[modelIdx + 1]}`
    );
  }

  // Test 3: resolveModelRouting returns mechanical model for low-complexity plan
  {
    const mockConfigService = {
      get: (_key: string) => undefined,
    } as never;

    const result = resolveModelRouting({
      routing: 'auto',
      fallbackDefaultModel: 'gpt-4.1',
      defaultMechanicalModel: 'gpt-5.4-mini',
      configService: mockConfigService,
      plan: {
        action: 'fix',
        summary: 'Simple rename',
        steps: ['Rename variable'],
        estimatedComplexity: 'low',
        affectedFiles: ['src/a.ts'],
      },
      adapterLabel: 'codex-cli',
    });

    assert(
      result.model === 'gpt-5.4-mini',
      'resolveModelRouting returns gpt-5.4-mini for low-complexity plan',
      `got: ${result.model}`
    );
    assert(
      result.logMessage.includes('mechanical'),
      'log message indicates mechanical routing',
      `got: ${result.logMessage}`
    );
  }

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  process.exit(failed > 0 ? 1 : 0);
}

main();
