/**
 * Manual smoke test: postProcessCodeReview normalizes endLine alongside line
 *
 * Run: nr test:manual -- test-review-endline-normalization
 *
 * Verifies:
 *   1. endLine preserved when line is an exact changed-line match
 *   2. endLine stripped when line is snapped to nearest changed line
 *   3. endLine stripped when file is not in the diff
 *   4. endLine stripped when endLine equals line (degenerate range)
 *   5. endLine stripped when line is invalid (negative)
 *   6. endLine stays undefined when absent on input
 *   7. endLine stripped when semantic matching moves line
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { postProcessCodeReview } from '../../src/review/code-review-post-processing';
import type { CodeReview, CodeIssue } from '../../src/shared/types/review.types';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

const assertLine = (
  label: string, issue: CodeIssue, expectedLine: number | undefined, expectedEndLine: number | undefined
): void => {
  const lineOk = issue.line === expectedLine;
  const endLineOk = issue.endLine === expectedEndLine;
  if (lineOk && endLineOk) {
    pass(label);
    return;
  }
  fail(label, `line: expected ${expectedLine}, got ${issue.line}; endLine: expected ${expectedEndLine}, got ${issue.endLine}`);
};

const makeReview = (issues: CodeIssue[]): CodeReview => ({
  summary: 'test',
  issues,
  suggestions: [],
  approved: true,
});

const STANDARD_DIFF = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,3 +10,4 @@
 context
-oldValue
+newValue
 unchanged
+addedValue
`;

const FRESHDESK_DIFF = `diff --git a/bitbucket-pipelines.yml b/bitbucket-pipelines.yml
--- a/bitbucket-pipelines.yml
+++ b/bitbucket-pipelines.yml
@@ -87,0 +119,6 @@ pipelines:
+            # Freshdesk contact-form integration (WBP-3068).
+            - echo "export FRESHDESK_DOMAIN=$FRESHDESK_DOMAIN" >> vars.sh
+            - echo "export FRESHDESK_API_KEY=$FRESHDESK_API_KEY_SIGNUP" >> vars.sh
+            - echo "export FRESHDESK_GROUP_LEADS=$FRESHDESK_GROUP_LEADS" >> vars.sh
+            - echo "export FRESHDESK_GROUP_SUPPORT=$FRESHDESK_GROUP_SUPPORT" >> vars.sh
+            - echo "export FRESHDESK_GROUP_AGENTS=$FRESHDESK_GROUP_AGENTS" >> vars.sh
`;

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nReview endLine normalization smoke test\n'));

  const result1 = postProcessCodeReview(
    makeReview([{ severity: 'info', message: 'spans lines', file: 'src/example.ts', line: 11, endLine: 13 }]),
    STANDARD_DIFF
  );
  assertLine('1. endLine preserved when line is exact changed-line match', result1.review.issues[0], 11, 13);

  const result2 = postProcessCodeReview(
    makeReview([{ severity: 'warning', message: 'wrong line', file: 'src/example.ts', line: 99, endLine: 105 }]),
    STANDARD_DIFF
  );
  assertLine('2. endLine stripped when line snapped to nearest changed line', result2.review.issues[0], 13, undefined);

  const result3 = postProcessCodeReview(
    makeReview([{ severity: 'warning', message: 'missing file', file: 'src/missing.ts', line: 20, endLine: 25 }]),
    STANDARD_DIFF
  );
  assertLine('3. endLine stripped when file not in diff', result3.review.issues[0], undefined, undefined);

  const result4 = postProcessCodeReview(
    makeReview([{ severity: 'info', message: 'degenerate', file: 'src/example.ts', line: 11, endLine: 11 }]),
    STANDARD_DIFF
  );
  assertLine('4. endLine stripped when endLine equals line', result4.review.issues[0], 11, undefined);

  const result5 = postProcessCodeReview(
    makeReview([{ severity: 'error', message: 'negative', file: 'src/example.ts', line: -3, endLine: 5 }]),
    STANDARD_DIFF
  );
  assertLine('5. endLine stripped when line is invalid', result5.review.issues[0], undefined, undefined);

  const result6 = postProcessCodeReview(
    makeReview([{ severity: 'info', message: 'no range', file: 'src/example.ts', line: 11 }]),
    STANDARD_DIFF
  );
  assertLine('6. endLine stays undefined when absent on input', result6.review.issues[0], 11, undefined);

  const result7 = postProcessCodeReview(
    makeReview([{
      severity: 'warning',
      message: 'Sensitive values written via `echo "export FRESHDESK_API_KEY=$FRESHDESK_API_KEY_SIGNUP" >> vars.sh`.',
      file: 'bitbucket-pipelines.yml',
      line: 122,
      endLine: 124,
    }]),
    FRESHDESK_DIFF
  );
  assertLine('7. endLine stripped when semantic matching moves line', result7.review.issues[0], 121, undefined);

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

void main();
