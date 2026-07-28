/**
 * Smoke test: Verify app.nodeEnv configuration has been fully removed.
 *
 * Run: nr test:manual -- test-remove-app-nodeenv-config
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
let failures = 0;

const pass = (label: string) => console.log(`  ✓ ${label}`);
const fail = (label: string, detail?: string) => {
  console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
  failures++;
};
const assert = (condition: boolean, label: string, detail?: string) => {
  if (condition) pass(label);
  else fail(label, detail);
};

console.log('🧪 Remove app.nodeEnv Config Smoke Test\n');

// 1. validation.schema.ts deleted
console.log('1. validation.schema.ts deleted');
assert(!fs.existsSync(path.join(SRC, 'config/validation.schema.ts')), 'validation.schema.ts does not exist');

// 2. public-config.ts has no app property
console.log('\n2. public-config.ts has no app property');
const publicConfig = fs.readFileSync(path.join(SRC, 'config/public-config.ts'), 'utf-8');
assert(!publicConfig.includes('nodeEnv'), 'No nodeEnv in WfConfig');
assert(!/\bapp\?\s*:\s*\{/.test(publicConfig), 'No app? property in WfConfig');

// 3. wf-config-loader.ts has no app/nodeEnv references
console.log('\n3. wf-config-loader.ts has no app/nodeEnv references');
const configLoader = fs.readFileSync(path.join(SRC, 'config/wf-config-loader.ts'), 'utf-8');
assert(!configLoader.includes('nodeEnv'), 'No nodeEnv in wf-config-loader.ts');
assert(!/app:\s*Joi\.object/.test(configLoader), 'No app Joi schema in wf-config-loader.ts');

// 4. No source file imports validation.schema
console.log('\n4. No source file imports validation.schema');
const srcFiles: string[] = [];
const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    if (entry.isFile() && entry.name.endsWith('.ts')) srcFiles.push(full);
  }
};
walk(SRC);

let importFound = false;
for (const file of srcFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  if (content.includes('validation.schema')) {
    importFound = true;
    fail(`${path.relative(ROOT, file)} imports validation.schema`);
  }
}
if (!importFound) pass('No imports of validation.schema in src/');

console.log(`\n${failures === 0 ? '✓ All checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
