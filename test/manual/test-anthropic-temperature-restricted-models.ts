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

console.log(chalk.cyan('\n  Method existence verification'));

const adapterPath = path.resolve(__dirname, '../../src/integrations/ai/adapters/anthropic.adapter.ts');
const adapterSource = fs.readFileSync(adapterPath, 'utf-8');

assert('isTemperatureRestricted method exists in source', adapterSource.includes('private isTemperatureRestricted('));

console.log(chalk.cyan('\n  Regex pattern coverage'));

const regexMatch = adapterSource.match(
  /isTemperatureRestricted\(model: string\): boolean\s*\{\s*return\s+(.+)\.test\(model\);/
);
assert('regex pattern is extractable from source', regexMatch !== null, 'could not extract regex');

if (regexMatch) {
  const regex = new RegExp(regexMatch[1].replace(/^\/|\/$/g, ''));

  const shouldMatch = [
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-4-9',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-sonnet-6',
    'claude-fable-5',
    'claude-mythos-preview',
  ];
  const shouldNotMatch = [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-20250514',
  ];

  for (const model of shouldMatch) {
    assert(`regex matches restricted model "${model}"`, regex.test(model));
  }

  for (const model of shouldNotMatch) {
    assert(`regex does not match unrestricted model "${model}"`, !regex.test(model));
  }
}

console.log(chalk.cyan('\n  Call site coverage'));

const callSiteCount = (adapterSource.match(/this\.isTemperatureRestricted\(/g) ?? []).length;
assert(
  'isTemperatureRestricted is called in both execute and executeWithHistory (2 call sites)',
  callSiteCount === 2,
  `found ${callSiteCount} call sites, expected 2`
);

console.log(chalk.cyan('\n  Nullish coalescing verification'));

const temperatureFallbackLines = adapterSource
  .split('\n')
  .filter(line => line.includes('temperature') && line.includes('request.temperature'));

for (const line of temperatureFallbackLines) {
  assert('temperature fallback uses ?? (not ||)', line.includes('??') && !line.includes('||'), `line: ${line.trim()}`);
}

console.log(chalk.cyan('\n  Test coverage verification'));

const specPath = path.resolve(__dirname, '../../src/integrations/ai/adapters/anthropic.adapter.spec.ts');
const specSource = fs.readFileSync(specPath, 'utf-8');

assert(
  'spec tests adaptive-thinking-only models in execute()',
  specSource.includes('\'omits temperature for adaptive-thinking-only models\'')
);

assert('spec tests Sonnet 5 in execute()', specSource.includes('\'omits temperature for Sonnet 5\''));

assert(
  'spec tests non-restricted models in execute()',
  specSource.includes('\'includes temperature for non-restricted models\'')
);

assert(
  'spec tests fable and mythos branches',
  specSource.includes('\'claude-fable-5\'') && specSource.includes('\'claude-mythos-preview\'')
);

assert(
  'spec tests adaptive-thinking-only models in executeWithHistory()',
  specSource.includes('executeWithHistory') && specSource.includes('\'claude-opus-4-7\'')
);

console.log(
  chalk.cyan(
    `\n  ${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed ? `, ${chalk.red(`${failed} failed`)}` : ''}`
  )
);

if (failed > 0) {
  process.exit(1);
}
