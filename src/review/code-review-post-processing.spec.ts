import type { CodeReview } from '../integrations/ai/ai.service';
import { postProcessCodeReview } from './code-review-post-processing';

const createReview = (overrides: Partial<CodeReview> = {}): CodeReview => ({
  summary: 'review summary',
  issues: [],
  suggestions: [],
  approved: false,
  ...overrides,
});

describe('postProcessCodeReview', () => {
  it('preserves a valid changed destination-side line', () => {
    const review = createReview({
      issues: [
        {
          severity: 'warning',
          message: 'Use clearer naming',
          file: 'src/example.ts',
          line: 11,
        },
      ],
    });

    const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,3 +10,4 @@
 context
-oldValue
+newValue
 unchanged
+addedValue
`;

    const processed = postProcessCodeReview(review, diff);

    expect(processed.review.issues[0]?.line).toBe(11);
  });

  it('maps an invalid line to the nearest changed destination-side line', () => {
    const review = createReview({
      issues: [
        {
          severity: 'warning',
          message: 'Guard the branch',
          file: 'src/example.ts',
          line: 99,
        },
      ],
    });

    const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,3 +10,4 @@
 context
-oldValue
+newValue
 unchanged
+addedValue
`;

    const processed = postProcessCodeReview(review, diff);

    expect(processed.review.issues[0]?.line).toBe(13);
  });

  it('keeps the file and omits the line when the issue file is not present in the diff', () => {
    const review = createReview({
      issues: [
        {
          severity: 'warning',
          message: 'Review this branch',
          file: 'src/missing.ts',
          line: 20,
        },
      ],
    });

    const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,1 +1,1 @@
-before
+after
`;

    const processed = postProcessCodeReview(review, diff);

    expect(processed.review.issues[0]).toEqual({
      severity: 'warning',
      message: 'Review this branch',
      file: 'src/missing.ts',
      line: undefined,
    });
  });

  it('omits the line when a file has no changed destination-side lines', () => {
    const review = createReview({
      issues: [
        {
          severity: 'error',
          message: 'Deletion-only diff cannot anchor inline comments',
          file: 'src/example.ts',
          line: 7,
        },
      ],
    });

    const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -7,2 +7,0 @@
-firstRemovedLine
-secondRemovedLine
`;

    const processed = postProcessCodeReview(review, diff);

    expect(processed.review.issues[0]?.line).toBeUndefined();
  });

  it('pairs suggestions with issues by index', () => {
    const review = createReview({
      issues: [
        {
          severity: 'warning',
          message: 'First issue',
          file: 'src/example.ts',
          line: 1,
        },
        {
          severity: 'info',
          message: 'Second issue',
          file: 'src/example.ts',
          line: 2,
        },
      ],
      suggestions: ['First suggestion', 'Second suggestion'],
    });

    const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,2 +1,2 @@
-beforeOne
+afterOne
-beforeTwo
+afterTwo
`;

    const processed = postProcessCodeReview(review, diff);

    expect(processed.presentation.issueRows).toEqual([
      {
        issue: processed.review.issues[0],
        suggestion: undefined,
      },
      {
        issue: processed.review.issues[1],
        suggestion: undefined,
      },
    ]);
    expect(processed.presentation.unmatchedSuggestions).toEqual([
      'First suggestion',
      'Second suggestion',
    ]);
  });

  it('keeps unmatched extra suggestions in trailing presentation output', () => {
    const review = createReview({
      issues: [
        {
          severity: 'warning',
          message: 'Only issue',
          file: 'src/example.ts',
          line: 1,
        },
      ],
      suggestions: ['Paired suggestion', 'Trailing suggestion'],
    });

    const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,1 +1,1 @@
-before
+after
`;

    const processed = postProcessCodeReview(review, diff);

    expect(processed.presentation.issueRows).toEqual([
      {
        issue: processed.review.issues[0],
        suggestion: undefined,
      },
    ]);
    expect(processed.presentation.unmatchedSuggestions).toEqual([
      'Paired suggestion',
      'Trailing suggestion',
    ]);
  });

  it('prefers explicit issue-local suggestions over detached top-level suggestions', () => {
    const review = createReview({
      issues: [
        {
          severity: 'warning',
          message: 'Normalize the input',
          file: 'src/example.ts',
          line: 1,
          suggestion: 'Uppercase the lookup key before querying.',
        },
      ],
      suggestions: ['General follow-up recommendation'],
    });

    const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,1 +1,1 @@
-before
+after
`;

    const processed = postProcessCodeReview(review, diff);

    expect(processed.presentation.issueRows).toEqual([
      {
        issue: processed.review.issues[0],
        suggestion: 'Uppercase the lookup key before querying.',
      },
    ]);
    expect(processed.presentation.unmatchedSuggestions).toEqual([
      'General follow-up recommendation',
    ]);
  });

  it('prefers a semantically matching changed line when the model picked the wrong changed line in the same hunk', () => {
    const review = createReview({
      issues: [
        {
          severity: 'warning',
          message:
            'Sensitive values are written via `echo "export FRESHDESK_API_KEY=$FRESHDESK_API_KEY_SIGNUP" >> vars.sh` and passed between steps as an artifact.',
          file: 'bitbucket-pipelines.yml',
          line: 122,
        },
      ],
    });

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

    expect(processed.review.issues[0]?.line).toBe(121);
  });

  it('extracts anchors from issue suggestion text for semantic matching', () => {
    const review = createReview({
      issues: [
        {
          severity: 'warning',
          message: 'The variable value looks incorrect.',
          suggestion:
            'Change `DB_PASSWORD` to use a real secret reference instead of a placeholder.',
          file: 'main.tf',
          line: 13,
        },
      ],
    });

    const diff = `diff --git a/main.tf b/main.tf
--- a/main.tf
+++ b/main.tf
@@ -10,0 +10,4 @@
+resource "aws_secretsmanager_secret_version" "v" {
+  secret_string = jsonencode({
+    DB_PASSWORD = "<placeholder>"
+  })
`;

    const processed = postProcessCodeReview(review, diff);

    expect(processed.review.issues[0]?.line).toBe(12);
  });

  it('omits the line when anchors exist but none match any changed line', () => {
    const review = createReview({
      issues: [
        {
          severity: 'error',
          message:
            'This PR does not add the DNS record in Route53 or any ACM certificate attachment.',
          suggestion:
            'Add an `aws_route53_record` for the hostname and attach a certificate.',
          file: 'infra.tf',
          line: 80,
        },
      ],
    });

    const diff = `diff --git a/infra.tf b/infra.tf
--- a/infra.tf
+++ b/infra.tf
@@ -1,0 +1,3 @@
+resource "aws_ecs_service" "app" {
+  desired_count = 1
+}
`;

    const processed = postProcessCodeReview(review, diff);

    expect(processed.review.issues[0]?.line).toBeUndefined();
  });
});
