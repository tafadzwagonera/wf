/**
 * Smoke test: command-level dedup drops targeted steps matching baseline canonical scripts.
 *
 * Validates that mergeVerificationSteps deduplicates targeted steps whose commands
 * invoke the same well-known script as a baseline entry, even when IDs and package
 * managers differ. Non-script commands pass through. Mirrors the pipeline in
 * ImplementerAgent.prepareVerificationScripts (implementer.agent.ts:486-497).
 *
 * Run: nr test:manual -- test-verification-command-dedup
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadVerificationManifest, mergeVerificationSteps, normalizeTargetedStepCommand } from '../../src/shared/utils/verification-manifest';
import type { VerificationStep } from '../../src/shared/types/verification.types';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cmd-dedup-'));
const manifestPath = path.join(tmpDir, 'verification.json');

fs.writeFileSync(manifestPath, JSON.stringify({
  version: 2,
  implement: {
    baseline: [
      { id: 'build', run: 'yarn build', policy: 'enforced' },
      { id: 'test', run: 'yarn test', policy: 'enforced' },
      { id: 'lint', run: 'yarn lint', policy: 'enforced' },
    ],
  },
}));

console.log('Test 1: loadVerificationManifest returns 3 baseline steps');
const manifest = loadVerificationManifest(manifestPath, 'implement');
assert.strictEqual(manifest.baseline.length, 3, 'Expected 3 baseline steps');
console.log('  PASS');

const targeted: VerificationStep[] = [
  { id: 'typescript-build', run: 'npm build', policy: 'enforced' },
  { id: 'unit-tests', run: 'pnpm test', policy: 'enforced' },
  { id: 'deno-lint', run: 'deno task lint', policy: 'enforced' },
  { id: 'no-stale-symbols', run: "bash -c 'grep -rn OldSymbol src/'", policy: 'enforced' },
];

console.log('Test 2: mergeVerificationSteps returns 4 steps (3 baseline + 1 unique targeted)');
const merged = mergeVerificationSteps(manifest.baseline, targeted);
assert.strictEqual(merged.length, 4, `Expected 4 steps, got ${merged.length}`);
console.log('  PASS');

const mergedIds = new Set(merged.map(s => s.id));

console.log('Test 3: typescript-build is dropped (build script covered by baseline)');
assert.ok(!mergedIds.has('typescript-build'), 'typescript-build should be dropped');
console.log('  PASS');

console.log('Test 4: unit-tests is dropped (test script covered by baseline)');
assert.ok(!mergedIds.has('unit-tests'), 'unit-tests should be dropped');
console.log('  PASS');

console.log('Test 5: deno-lint is dropped (lint script covered by baseline)');
assert.ok(!mergedIds.has('deno-lint'), 'deno-lint should be dropped');
console.log('  PASS');

console.log('Test 6: no-stale-symbols passes through (unique non-script command)');
assert.ok(mergedIds.has('no-stale-symbols'), 'no-stale-symbols should be present');
console.log('  PASS');

console.log('Test 7: normalizeTargetedStepCommand applied to targeted, not baseline');
const baselineIds = new Set(manifest.baseline.map(s => s.id));
const scripts = merged.map(step => {
  const normalizedRun = baselineIds.has(step.id) ? step.run : normalizeTargetedStepCommand(step.run);
  return { id: step.id, run: normalizedRun };
});
const baselineScript = scripts.find(s => s.id === 'build');
assert.strictEqual(baselineScript?.run, 'yarn build', 'Baseline run should be unchanged');
const targetedScript = scripts.find(s => s.id === 'no-stale-symbols');
assert.strictEqual(targetedScript?.run, "bash -c 'grep -rn OldSymbol src/'", 'Targeted run should pass through normalizer');
console.log('  PASS');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\nAll command-level dedup tests passed.');
