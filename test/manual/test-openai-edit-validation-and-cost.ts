/**
 * Manual smoke test: OpenAI edit validation and cost estimation
 *
 * Run: nr test:manual -- test-openai-edit-validation-and-cost
 *
 * Verifies:
 *   1. validateTypeScriptEdit returns null for valid TypeScript.
 *   2. validateTypeScriptEdit catches duplicate constructors.
 *   3. validateTypeScriptEdit catches duplicate imports.
 *   4. validateTypeScriptEdit returns null for non-TS files.
 *   5. validateTypeScriptEdit catches syntax errors.
 *   6. estimateOpenAiCostUsd returns correct cost for gpt-4.1-mini.
 *   7. estimateOpenAiCostUsd discounts cached input tokens.
 *   8. estimateOpenAiCostUsd returns null for unknown models.
 *   9. Adapter source contains validation wired into editFileTool.
 *  10. Adapter source contains fallback logic for incomplete work.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import {
  validateTypeScriptEdit,
  estimateOpenAiCostUsd,
} from '../../src/integrations/ai/adapters/openai-agent.adapter';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    console.log(chalk.green(`  PASS: ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`));
    failed++;
  }
};

const run = async (): Promise<void> => {
  console.log(
    chalk.bold('\nSmoke test: OpenAI edit validation and cost estimation\n'),
  );

  // 1. Valid TypeScript
  assert(
    'valid TypeScript returns null',
    validateTypeScriptEdit(
      'foo.ts',
      'class Foo { constructor(private x: string) {} }',
    ) === null,
  );

  // 2. Duplicate constructors
  const dupCtor = validateTypeScriptEdit(
    'foo.ts',
    'class Foo { constructor(a: string) {} constructor(b: number) {} }',
  );
  assert(
    'duplicate constructors caught',
    dupCtor !== null && dupCtor.includes('constructor declarations'),
    dupCtor ?? 'returned null',
  );

  // 3. Duplicate imports
  const dupImport = validateTypeScriptEdit(
    'foo.ts',
    'import { A, A } from "./mod";',
  );
  assert(
    'duplicate imports caught',
    dupImport !== null && dupImport.includes('Duplicate import'),
    dupImport ?? 'returned null',
  );

  // 4. Non-TS files skipped
  assert(
    'non-TS files return null',
    validateTypeScriptEdit('foo.js', 'invalid {{{') === null,
  );

  // 5. Syntax errors
  const syntaxErr = validateTypeScriptEdit('foo.ts', 'class { constructor( {}');
  assert(
    'syntax errors caught',
    syntaxErr !== null && syntaxErr.includes('syntax error'),
    syntaxErr ?? 'returned null',
  );

  // 6. Cost estimation for gpt-4.1-mini
  const cost = estimateOpenAiCostUsd('gpt-4.1-mini', 100_000, 10_000, 0);
  assert(
    'gpt-4.1-mini cost is ~$0.056',
    cost !== null && Math.abs(cost - 0.056) < 0.001,
    cost !== null ? `got $${cost.toFixed(4)}` : 'returned null',
  );

  // 7. Cached tokens discounted
  const cachedCost = estimateOpenAiCostUsd(
    'gpt-4.1-mini',
    100_000,
    10_000,
    60_000,
  );
  assert(
    'cached tokens reduce cost',
    cachedCost !== null && cost !== null && cachedCost < cost,
    cachedCost !== null ? `got $${cachedCost.toFixed(4)}` : 'returned null',
  );

  // 8. Unknown model returns null
  assert(
    'unknown model returns null',
    estimateOpenAiCostUsd('gpt-99', 100_000, 10_000, 0) === null,
  );

  // 9. Adapter source contains validation in editFileTool
  const adapterSource = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      '..',
      'src',
      'integrations',
      'ai',
      'adapters',
      'openai-agent.adapter.ts',
    ),
    'utf8',
  );
  assert(
    'editFileTool contains validateTypeScriptEdit call',
    adapterSource.includes('validateTypeScriptEdit(absolutePath, updated)'),
  );

  // 10. Adapter source contains incomplete-work loop with workload tracking
  assert(
    'adapter contains incomplete-work loop',
    adapterSource.includes('currentWorkload') &&
      adapterSource.includes('currentUnvisited'),
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
};

run();
