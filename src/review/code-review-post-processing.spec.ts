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
        suggestion: 'First suggestion',
      },
      {
        issue: processed.review.issues[1],
        suggestion: 'Second suggestion',
      },
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
        suggestion: 'Paired suggestion',
      },
    ]);
    expect(processed.presentation.unmatchedSuggestions).toEqual([
      'Trailing suggestion',
    ]);
  });
});
