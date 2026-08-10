/**
 * Smoke test: override policy bypasses command-level dedup in the merge pipeline.
 *
 * Validates that targeted steps with policy 'override' bypass both ID-based and
 * command-level dedup. Same-ID override replaces the baseline entry; different-ID
 * override appends alongside. Mirrors ImplementerAgent.prepareVerificationScripts.
 *
 * Run: nr test:manual -- test-verification-override-bypass
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadVerificationManifest, mergeVerificationSteps } from '../../src/shared/utils/verification-manifest';
import type { VerificationStep } from '../../src/shared/types/verification.types';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-override-bypass-'));
const manifestPath = path.join(tmpDir, 'verification.json');

fs.writeFileSync(manifestPath, JSON.stringify({
  version: 2,
  implement: {
    baseline: [
      { id: 'build', run: 'yarn build', policy: 'enforced' },
      { id: 'test', run: 'yarn test', policy: 'enforced' },
    ],
  },
}));

console.log('Test 1: loadVerificationManifest returns 2 baseline steps');
const manifest = loadVerificationManifest(manifestPath, 'implement');
assert.strictEqual(manifest.baseline.length, 2, 'Expected 2 baseline steps');
console.log('  PASS');

const targeted: VerificationStep[] = [
  { id: 'scoped-test', run: 'yarn test -- src/foo.spec.ts', policy: 'override' },
  { id: 'build', run: 'yarn build --verbose', policy: 'override' },
];

console.log('Test 2: mergeVerificationSteps returns 3 steps');
const merged = mergeVerificationSteps(manifest.baseline, targeted);
assert.strictEqual(merged.length, 3, `Expected 3 steps, got ${merged.length}`);
console.log('  PASS');

console.log('Test 3: build step is replaced by same-ID override');
const buildStep = merged.find(s => s.id === 'build');
assert.ok(buildStep, 'build step should exist');
assert.strictEqual(buildStep.run, 'yarn build --verbose', 'build run should be the override version');
assert.strictEqual(buildStep.policy, 'override', 'build policy should be override');
console.log('  PASS');

console.log('Test 4: test step retains baseline values (untouched)');
const testStep = merged.find(s => s.id === 'test');
assert.ok(testStep, 'test step should exist');
assert.strictEqual(testStep.run, 'yarn test', 'test run should be baseline');
assert.strictEqual(testStep.policy, 'enforced', 'test policy should be enforced');
console.log('  PASS');

console.log('Test 5: scoped-test is appended (different-ID override bypasses command dedup)');
const scopedTestStep = merged.find(s => s.id === 'scoped-test');
assert.ok(scopedTestStep, 'scoped-test step should exist');
assert.strictEqual(scopedTestStep.run, 'yarn test -- src/foo.spec.ts', 'scoped-test run should match');
assert.strictEqual(scopedTestStep.policy, 'override', 'scoped-test policy should be override');
console.log('  PASS');

console.log('Test 6: result order is [build, test, scoped-test]');
assert.deepStrictEqual(
  merged.map(s => s.id),
  ['build', 'test', 'scoped-test'],
  'Order should be baseline insertion order with targeted appended',
);
console.log('  PASS');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\nAll override bypass tests passed.');
