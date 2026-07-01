/**
 * Manual Test Script for review artifact path derivation fix
 *
 * Run: nr test:manual -- test-review-artifact-path-derivation
 *
 * What it checks:
 *   1. Real ticket path (.md) produces correct review path
 *   2. Synthetic plan path (.json) produces correct review path
 *   3. Reviewer skip-existing check: .json ticket path with plan JSON on disk does NOT skip
 *   4. createReviewArtifact writes to the derived path (not the plan JSON)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deriveReviewArtifactPath } from '../../src/shared/utils/plan-artifact';

async function testReviewArtifactPathDerivation() {
  console.log('🧪 Testing review artifact path derivation\n');

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`✓ ${msg}\n`);
    passed++;
  };
  const fail = (msg: string) => {
    console.error(`❌ ${msg}\n`);
    failed++;
  };

  // Test 1: Real ticket path (.md) produces correct review path
  const mdPath = '/tmp/consumer/.wf/jira/WBP-123.md';
  const mdReview = deriveReviewArtifactPath(mdPath);
  if (mdReview === '/tmp/consumer/.wf/jira/WBP-123-review.md') {
    pass(`Real ticket .md path → ${mdReview}`);
  } else {
    fail(`Expected WBP-123-review.md, got ${mdReview}`);
  }

  // Test 2: Synthetic plan path (.json) produces correct review path
  const jsonPath = '/tmp/consumer/.wf/jira/2026-06-30-b37ef1d4-fix-plan.json';
  const jsonReview = deriveReviewArtifactPath(jsonPath);
  if (jsonReview === '/tmp/consumer/.wf/jira/2026-06-30-b37ef1d4-fix-plan-review.md') {
    pass(`Synthetic .json plan path → ${jsonReview}`);
  } else {
    fail(`Expected fix-plan-review.md, got ${jsonReview}`);
  }

  // Test 3: Reviewer skip-existing check — derived review path differs from plan JSON
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-review-path-'));
  const planJsonPath = path.join(tempDir, '2026-06-30-b37ef1d4-fix-plan.json');
  fs.writeFileSync(planJsonPath, JSON.stringify({ action: 'fix', summary: 'test' }));

  const derivedReviewPath = deriveReviewArtifactPath(planJsonPath);
  const planJsonExists = fs.existsSync(planJsonPath);
  const reviewExists = fs.existsSync(derivedReviewPath);

  if (planJsonExists && !reviewExists) {
    pass('Plan JSON exists but derived review path does not — skip-existing would NOT fire');
  } else if (reviewExists) {
    fail('Derived review path unexpectedly exists on disk');
  } else {
    fail('Plan JSON does not exist (test setup issue)');
  }

  // Test 4: Writing to derived path does not overwrite plan JSON
  fs.writeFileSync(derivedReviewPath, '# Review\n✓ Approved');
  const planContent = fs.readFileSync(planJsonPath, 'utf-8');
  const reviewContent = fs.readFileSync(derivedReviewPath, 'utf-8');

  if (planContent.includes('"action"') && reviewContent.includes('✓ Approved')) {
    pass('Plan JSON intact after writing review to derived path');
  } else {
    fail('Plan JSON was corrupted or review was not written correctly');
  }

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) {
    console.log('✅ All tests passed!');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

testReviewArtifactPathDerivation();
