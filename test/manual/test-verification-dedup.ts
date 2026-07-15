import assert from 'node:assert';
import { verificationPolicySchema } from '../../src/shared/schemas/verification.schema';
import { mergeVerificationSteps } from '../../src/shared/utils/verification-manifest';
import type { VerificationStep } from '../../src/shared/types/verification.types';

console.log('Test 1: Targeted with unique ID is appended');
{
  const baseline: VerificationStep[] = [{ id: 'lint', run: 'yarn lint', policy: 'enforced' }];
  const targeted: VerificationStep[] = [{ id: 'snapshot', run: 'yarn test:snap', policy: 'enforced' }];
  const result = mergeVerificationSteps(baseline, targeted);
  assert.strictEqual(result.length, 2, 'Should have 2 steps');
  assert.strictEqual(result[0].id, 'lint', 'First step should be lint');
  assert.strictEqual(result[1].id, 'snapshot', 'Second step should be snapshot');
  console.log('✓ Test 1 passed');
}

console.log('Test 2: Duplicate ID without override is dropped (baseline wins)');
{
  const baseline: VerificationStep[] = [{ id: 'lint', run: 'yarn lint', policy: 'enforced' }];
  const targeted: VerificationStep[] = [{ id: 'lint', run: 'yarn lint --fix', policy: 'enforced' }];
  const result = mergeVerificationSteps(baseline, targeted);
  assert.strictEqual(result.length, 1, 'Should have 1 step');
  assert.strictEqual(result[0].id, 'lint', 'Step id should be lint');
  assert.strictEqual(result[0].run, 'yarn lint', 'Run command should be the baseline version');
  console.log('✓ Test 2 passed');
}

console.log('Test 3: Duplicate ID with override replaces baseline');
{
  const baseline: VerificationStep[] = [{ id: 'lint', run: 'yarn lint', policy: 'enforced' }];
  const targeted: VerificationStep[] = [{ id: 'lint', run: 'yarn lint --fix', policy: 'override' }];
  const result = mergeVerificationSteps(baseline, targeted);
  assert.strictEqual(result.length, 1, 'Should have 1 step');
  assert.strictEqual(result[0].id, 'lint', 'Step id should be lint');
  assert.strictEqual(result[0].run, 'yarn lint --fix', 'Run command should be the targeted version');
  assert.strictEqual(result[0].policy, 'override', 'Policy should be override');
  console.log('✓ Test 3 passed');
}

console.log('Test 4: Waivers still remove by ID after dedup');
{
  const baseline: VerificationStep[] = [
    { id: 'e2e', run: 'yarn e2e', policy: 'enforced' },
    { id: 'lint', run: 'yarn lint', policy: 'enforced' },
  ];
  const targeted: VerificationStep[] = [];
  const merged = mergeVerificationSteps(baseline, targeted);
  const waiverIds = new Set(['e2e']);
  const result = merged.filter(step => !waiverIds.has(step.id));
  assert.strictEqual(result.length, 1, 'Should have 1 step after waiver');
  assert.strictEqual(result[0].id, 'lint', 'Remaining step should be lint');
  console.log('✓ Test 4 passed');
}

console.log('Test 5: Empty targeted array — only baseline steps present');
{
  const baseline: VerificationStep[] = [
    { id: 'lint', run: 'yarn lint', policy: 'enforced' },
    { id: 'build', run: 'yarn build', policy: 'enforced' },
  ];
  const targeted: VerificationStep[] = [];
  const result = mergeVerificationSteps(baseline, targeted);
  assert.strictEqual(result.length, 2, 'Should have 2 steps');
  assert.strictEqual(result[0].id, 'lint', 'First step should be lint');
  assert.strictEqual(result[1].id, 'build', 'Second step should be build');
  console.log('✓ Test 5 passed');
}

console.log('Test 6: Targeted override for non-existent baseline ID — new step added');
{
  const baseline: VerificationStep[] = [{ id: 'lint', run: 'yarn lint', policy: 'enforced' }];
  const targeted: VerificationStep[] = [{ id: 'snapshot', run: 'yarn test:snap', policy: 'override' }];
  const result = mergeVerificationSteps(baseline, targeted);
  assert.strictEqual(result.length, 2, 'Should have 2 steps');
  const snapshotStep = result.find(s => s.id === 'snapshot');
  assert.ok(snapshotStep, 'Should have snapshot step');
  assert.strictEqual(snapshotStep?.policy, 'override', 'Snapshot policy should be override');
  console.log('✓ Test 6 passed');
}

console.log('Test 7: override is accepted by verificationPolicySchema');
{
  const result = verificationPolicySchema.safeParse('override');
  assert.ok(result.success, 'override should be a valid policy value');
  console.log('✓ Test 7 passed');
}

console.log('All verification dedup tests passed.');
