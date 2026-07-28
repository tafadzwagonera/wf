/**
 * Manual smoke test for review verdict label normalization.
 *
 * Verifies:
 * 1. REVIEW_VERDICT_APPROVED and REVIEW_VERDICT_CHANGES_REQUESTED hold the expected values
 * 2. Constants are re-exported from ai.service.ts
 * 3. All call sites reference the constants instead of raw string literals
 * 4. No stale verdict labels remain in source files
 *
 * Run:
 *   yarn test:manual -- test-review-verdict-constants
 */

import * as fs from 'fs';
import * as path from 'path';
import { REVIEW_VERDICT_APPROVED, REVIEW_VERDICT_CHANGES_REQUESTED } from '../../src/integrations/ai/ai.service';

const SRC_DIR = path.resolve(__dirname, '../../src');

const CALL_SITE_FILES = [
  'commands/issue-review.command.ts',
  'agents/reviewer.agent.ts',
  'workflows/stages/review-stage.service.ts',
  'commands/issue.command.ts',
  'integrations/ai/conversation/chat-ui.service.ts',
];

const STALE_LABELS = ['NOT APPROVED', 'NEEDS WORK', 'Changes needed', 'Needs Work'];

const readSource = (relativePath: string): string => fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf8');

function assertIncludes(source: string, needle: string, file: string, label: string): void {
  if (!source.includes(needle)) {
    throw new Error(`${label}\n  File: ${file}\n  Expected to find: ${JSON.stringify(needle)}`);
  }
}

async function run(): Promise<void> {
  console.log('🧪 Manual smoke: review verdict constants\n');

  // 1. Verify constant values
  if (REVIEW_VERDICT_APPROVED !== 'Approved') {
    throw new Error(`REVIEW_VERDICT_APPROVED should be 'Approved', got '${REVIEW_VERDICT_APPROVED}'`);
  }
  if (REVIEW_VERDICT_CHANGES_REQUESTED !== 'Changes requested') {
    throw new Error(
      `REVIEW_VERDICT_CHANGES_REQUESTED should be 'Changes requested', got '${REVIEW_VERDICT_CHANGES_REQUESTED}'`
    );
  }
  console.log('  ✓ Constants hold correct values');

  // 2. Verify re-export from ai.service.ts
  const aiServiceSource = readSource('integrations/ai/ai.service.ts');
  assertIncludes(
    aiServiceSource,
    'REVIEW_VERDICT_APPROVED',
    'integrations/ai/ai.service.ts',
    'ai.service.ts must re-export REVIEW_VERDICT_APPROVED'
  );
  assertIncludes(
    aiServiceSource,
    'REVIEW_VERDICT_CHANGES_REQUESTED',
    'integrations/ai/ai.service.ts',
    'ai.service.ts must re-export REVIEW_VERDICT_CHANGES_REQUESTED'
  );
  console.log('  ✓ Constants re-exported from ai.service.ts');

  // 3. Verify each call site imports and references the constants
  for (const file of CALL_SITE_FILES) {
    const source = readSource(file);
    assertIncludes(source, 'REVIEW_VERDICT_APPROVED', file, `${file} must import REVIEW_VERDICT_APPROVED`);
    assertIncludes(
      source,
      'REVIEW_VERDICT_CHANGES_REQUESTED',
      file,
      `${file} must import REVIEW_VERDICT_CHANGES_REQUESTED`
    );
  }
  console.log('  ✓ All call sites import and reference the constants');

  // 4. Verify no raw verdict string literals remain in call-site files
  for (const file of CALL_SITE_FILES) {
    const source = readSource(file);
    const rawLiterals = ['\'Approved\'', '\'Changes requested\'', '"Approved"', '"Changes requested"'];
    for (const raw of rawLiterals) {
      if (source.includes(raw)) {
        throw new Error(`Raw string literal ${raw} found in ${file} — should use constant instead`);
      }
    }
  }
  console.log('  ✓ No raw verdict string literals in call-site files');

  // 5. Verify no stale labels remain anywhere in src/
  const walk = (dir: string): string[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        files.push(...walk(fullPath));
      }
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        files.push(fullPath);
      }
    }
    return files;
  };

  for (const filePath of walk(SRC_DIR)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const relative = path.relative(SRC_DIR, filePath);
    for (const stale of STALE_LABELS) {
      if (source.includes(stale)) {
        throw new Error(`Stale verdict label '${stale}' found in ${relative}`);
      }
    }
  }
  console.log('  ✓ No stale verdict labels in src/');

  // 6. Verify the constants definition file exists and is the single source of truth
  const typesSource = readSource('shared/types/review.types.ts');
  assertIncludes(
    typesSource,
    'export const REVIEW_VERDICT_APPROVED = \'Approved\' as const',
    'shared/types/review.types.ts',
    'Constants must be defined in review.types.ts'
  );
  assertIncludes(
    typesSource,
    'export const REVIEW_VERDICT_CHANGES_REQUESTED = \'Changes requested\' as const',
    'shared/types/review.types.ts',
    'Constants must be defined in review.types.ts'
  );
  console.log('  ✓ Single source of truth in review.types.ts');

  console.log('\n✓ Manual smoke test passed: review verdict constants');
}

run().catch(error => {
  console.error(`\n✗ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
