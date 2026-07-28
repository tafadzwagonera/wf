/**
 * Manual smoke tests for issue:review semantic line alignment.
 *
 * Run:
 *   yarn test:manual -- test-issue-review-semantic-line-alignment
 */

import { postProcessCodeReview } from '../../src/review/code-review-post-processing';

async function run(): Promise<void> {
  console.log('🧪 Manual smoke: issue:review semantic line alignment\n');

  const review = {
    summary: 'Review summary',
    issues: [
      {
        severity: 'warning' as const,
        message:
          'Sensitive values are written via `echo "export FRESHDESK_API_KEY=$FRESHDESK_API_KEY_SIGNUP" >> vars.sh` and passed between steps as an artifact.',
        file: 'bitbucket-pipelines.yml',
        line: 122,
      },
    ],
    suggestions: [],
    approved: false,
  };

  const diff = `diff --git a/bitbucket-pipelines.yml b/bitbucket-pipelines.yml
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

  const processed = postProcessCodeReview(review, diff);

  if (processed.review.issues[0]?.line !== 121) {
    throw new Error(`Expected semantic remap to line 121, received ${processed.review.issues[0]?.line}`);
  }

  console.log('  ✓ Test 1 passed: message-only anchors remap correctly\n');

  // Test 2: Suggestion text provides anchors when message has none
  console.log('Test 2: suggestion-based anchor extraction');
  const suggestionReview = {
    summary: 'Review summary',
    issues: [
      {
        severity: 'warning' as const,
        message: 'The variable value looks incorrect.',
        suggestion: 'Change `DB_PASSWORD` to use a real secret reference instead of a placeholder.',
        file: 'main.tf',
        line: 13,
      },
    ],
    suggestions: [],
    approved: false,
  };

  const suggestionDiff = `diff --git a/main.tf b/main.tf
--- a/main.tf
+++ b/main.tf
@@ -10,0 +10,4 @@
+resource "aws_secretsmanager_secret_version" "v" {
+  secret_string = jsonencode({
+    DB_PASSWORD = "<placeholder>"
+  })
`;

  const suggestionProcessed = postProcessCodeReview(suggestionReview, suggestionDiff);

  if (suggestionProcessed.review.issues[0]?.line !== 12) {
    throw new Error(
      `Expected suggestion anchor remap to line 12, received ${suggestionProcessed.review.issues[0]?.line}`
    );
  }

  console.log('  ✓ Test 2 passed: suggestion anchors remap correctly\n');

  // Test 3: Zero-score anchors omit line instead of preserving wrong line
  console.log('Test 3: zero-score anchor omission');
  const zeroScoreReview = {
    summary: 'Review summary',
    issues: [
      {
        severity: 'error' as const,
        message: 'This PR does not add the DNS record in Route53 or any ACM certificate attachment.',
        suggestion: 'Add an `aws_route53_record` for the hostname and attach a certificate.',
        file: 'infra.tf',
        line: 80,
      },
    ],
    suggestions: [],
    approved: false,
  };

  const zeroScoreDiff = `diff --git a/infra.tf b/infra.tf
--- a/infra.tf
+++ b/infra.tf
@@ -1,0 +1,3 @@
+resource "aws_ecs_service" "app" {
+  desired_count = 1
+}
`;

  const zeroScoreProcessed = postProcessCodeReview(zeroScoreReview, zeroScoreDiff);

  if (zeroScoreProcessed.review.issues[0]?.line !== undefined) {
    throw new Error(
      `Expected line to be omitted for zero-score anchors, received ${zeroScoreProcessed.review.issues[0]?.line}`
    );
  }

  console.log('  ✓ Test 3 passed: zero-score anchors omit line\n');

  // Test 4: Preserve model line when anchors score zero but line is within hunk span
  console.log('Test 4: hunk-span preservation');
  const hunkSpanReview = {
    summary: 'Review summary',
    issues: [
      {
        severity: 'warning' as const,
        message: 'The `aws_lb_target_group` health check path should use a deeper readiness probe.',
        file: 'main.tf',
        line: 12,
      },
    ],
    suggestions: [],
    approved: false,
  };

  const hunkSpanDiff = `diff --git a/main.tf b/main.tf
--- a/main.tf
+++ b/main.tf
@@ -10,6 +10,7 @@
 resource "aws_lb_target_group" "tg" {
   port     = 3000
   protocol = "HTTP"
+  deregistration_delay = 30

   health_check {
     path = "/api/health"
`;

  const hunkSpanProcessed = postProcessCodeReview(hunkSpanReview, hunkSpanDiff);

  if (hunkSpanProcessed.review.issues[0]?.line !== 13) {
    throw new Error(
      `Expected hunk-span preservation to yield line 13, received ${hunkSpanProcessed.review.issues[0]?.line}`
    );
  }

  console.log('  ✓ Test 4 passed: hunk-span preserves in-range model line\n');

  console.log('✓ Manual smoke test passed: issue:review semantic line alignment');
}

run().catch(error => {
  console.error(`✗ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
