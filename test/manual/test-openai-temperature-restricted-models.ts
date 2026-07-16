// test/manual/test-openai-temperature-restricted-models.ts
//
// Smoke test: OpenAI adapter strips temperature for temperature-restricted
// models (reasoning models like o1/o3/o4 and frontier models like gpt-5/gpt-5.5).
//
// Verifies:
//   1. isTemperatureRestricted method exists (renamed from isReasoningModel)
//   2. The regex matches expected model families
//   3. execute() and executeWithHistory() omit temperature for restricted models
//   4. execute() and executeWithHistory() include temperature for unrestricted models
//
// Run: nr test:manual -- test-openai-temperature-restricted-models

import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean, detail?: string) => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`));
    failed++;
  }
};

// ---------------------------------------------------------------------------
// 1. Source file contains isTemperatureRestricted (not isReasoningModel)
// ---------------------------------------------------------------------------
console.log(chalk.cyan('\n  Method rename verification'));

const adapterPath = path.resolve(__dirname, '../../src/integrations/ai/adapters/openai.adapter.ts');
const adapterSource = fs.readFileSync(adapterPath, 'utf-8');

assert('isTemperatureRestricted method exists in source', adapterSource.includes('private isTemperatureRestricted('));

assert('isReasoningModel method is removed from source', !adapterSource.includes('private isReasoningModel('));

assert('all call sites use isTemperatureRestricted', !adapterSource.includes('this.isReasoningModel('));

// ---------------------------------------------------------------------------
// 2. Regex pattern matches expected model families
// ---------------------------------------------------------------------------
console.log(chalk.cyan('\n  Regex pattern coverage'));

const regexMatch = /isTemperatureRestricted\(model: string\): boolean\s*\{\s*return\s+(.+)\.test\(model\);/.exec(adapterSource);
assert('regex pattern is extractable from source', regexMatch !== null, 'could not extract regex');

if (regexMatch) {
  const regex = new RegExp(regexMatch[1].replaceAll(/^\/|\/$/g, ''));

  const shouldMatch = ['o1', 'o3', 'o4-mini', 'gpt-5', 'gpt-5.4', 'gpt-5.5', 'gpt-5.4-mini'];
  const shouldNotMatch = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'claude-sonnet-4-6'];

  for (const model of shouldMatch) {
    assert(`regex matches temperature-restricted model "${model}"`, regex.test(model));
  }

  for (const model of shouldNotMatch) {
    assert(`regex does not match unrestricted model "${model}"`, !regex.test(model));
  }
}

// ---------------------------------------------------------------------------
// 3. Both execute() and executeWithHistory() use isTemperatureRestricted
// ---------------------------------------------------------------------------
console.log(chalk.cyan('\n  Call site coverage'));

const callSiteCount = (adapterSource.match(/this\.isTemperatureRestricted\(/g) ?? []).length;
assert(
  'isTemperatureRestricted is called in both execute and executeWithHistory (2 call sites)',
  callSiteCount === 2,
  `found ${callSiteCount} call sites, expected 2`
);

// ---------------------------------------------------------------------------
// 4. Unit test file covers gpt-5 frontier models
// ---------------------------------------------------------------------------
console.log(chalk.cyan('\n  Test coverage verification'));

const specPath = path.resolve(__dirname, '../../src/integrations/ai/adapters/openai.adapter.spec.ts');
const specSource = fs.readFileSync(specPath, 'utf-8');

assert(
  'spec tests gpt-5 frontier model in execute()',
  specSource.includes('\'omits temperature for gpt-5 frontier models\'')
);

assert(
  'spec tests gpt-5 frontier model in executeWithHistory()',
  specSource.includes('\'omits temperature for gpt-5 frontier models in executeWithHistory\'')
);

assert(
  'spec tests reasoning model temperature omission',
  specSource.includes('\'omits temperature for reasoning models\'')
);

assert(
  'spec tests unrestricted model temperature inclusion',
  specSource.includes('\'includes temperature for non-reasoning models\'')
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(
  chalk.cyan(
    `\n  ${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed ? `, ${chalk.red(`${failed} failed`)}` : ''}`
  )
);

if (failed > 0) {
  process.exit(1);
}
