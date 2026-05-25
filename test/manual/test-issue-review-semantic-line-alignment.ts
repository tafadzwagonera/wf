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
    throw new Error(
      `Expected semantic remap to line 121, received ${processed.review.issues[0]?.line}`,
    );
  }

  console.log(
    '✅ Manual smoke test passed: issue:review semantic line alignment',
  );
}

run().catch((error) => {
  console.error(`❌ Manual smoke test failed: ${error.message}`);
  process.exit(1);
});
