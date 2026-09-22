/**
 * Manual smoke test for the sanitizeCodeReviewTrace false-positive fix.
 *
 * Validates that traces containing "suggestions" as a code identifier are
 * preserved, while traces containing reviewer-narration phrases like
 * "generating suggestions" are still sanitized.
 *
 * Run:
 *   yarn test:manual -- test-review-trace-suggestion-false-positive
 */

import { sanitizeCodeReviewTrace } from '../../src/integrations/ai/ai.service';
import type { CodeReview } from '../../src/shared/types/review.types';

const diff = `
diff --git a/src/error/error.handler.ts b/src/error/error.handler.ts
@@
+function handleProviderError() {
+  return getSuggestion(error.code);
+}
`;

const paymentDiff = `
diff --git a/src/payment/payment.controller.ts b/src/payment/payment.controller.ts
@@
+export async function eventPaymentRecorded() {
+  return addPaymentToBooking();
+}
`;

const codeIdentifierTrace: CodeReview = {
  summary: 'ok',
  issues: [],
  traceProvenance: 'evidence-based',
  callStack: [
    {
      frame: 'handleProviderError()',
      children: [
        {
          frame: 'getSuggestion(error.code)',
          children: [
            {
              frame: 'suggestions[ERROR_CODE.AI_PROVIDER_ERROR]',
              children: [],
            },
          ],
        },
      ],
    },
  ],
  stateTransition: {
    from: 'handleProviderError',
    to: 'getSuggestion',
    steps: [
      {
        frame: 'handleProviderError()',
        captured: { 'suggestion map key': 'computed property' },
        changes: {},
        children: [],
      },
    ],
  },
  suggestions: [],
  approved: true,
};

const narrationTrace: CodeReview = {
  summary: 'ok',
  issues: [],
  traceProvenance: 'evidence-based',
  callStack: [
    {
      frame: 'Generating suggestions for payment.controller.ts',
      children: [{ frame: 'eventPaymentRecorded()', children: [] }],
    },
  ],
  stateTransition: { from: 'initial', to: 'complete', steps: [] },
  suggestions: [],
  approved: true,
};

const providingTrace: CodeReview = {
  summary: 'ok',
  issues: [],
  traceProvenance: 'evidence-based',
  callStack: [
    {
      frame: 'Providing suggestions for the code review',
      children: [{ frame: 'eventPaymentRecorded()', children: [] }],
    },
  ],
  stateTransition: { from: 'initial', to: 'complete', steps: [] },
  suggestions: [],
  approved: true,
};

function checkCodeIdentifierPreserved(): void {
  const preserved = sanitizeCodeReviewTrace(codeIdentifierTrace, diff);
  if (preserved.traceProvenance !== 'evidence-based') {
    throw new Error(`Case 1 FAILED: expected traceProvenance "evidence-based", got "${preserved.traceProvenance}"`);
  }
  if (!preserved.callStack || preserved.callStack.length === 0) {
    throw new Error('Case 1 FAILED: callStack was wiped despite code identifiers');
  }
  console.log('  ✓ Case 1: code-identifier trace preserved');
}

function checkNarrationSanitized(): void {
  const sanitized = sanitizeCodeReviewTrace(narrationTrace, paymentDiff);
  if (sanitized.traceProvenance !== 'unavailable') {
    throw new Error(`Case 2 FAILED: expected traceProvenance "unavailable", got "${sanitized.traceProvenance}"`);
  }
  if (sanitized.callStack?.length) {
    throw new Error('Case 2 FAILED: callStack was not wiped for narration trace');
  }
  console.log('  ✓ Case 2: narration-phrase trace sanitized');
}

function checkProvidingSanitized(): void {
  const sanitizedProviding = sanitizeCodeReviewTrace(providingTrace, paymentDiff);
  if (sanitizedProviding.traceProvenance !== 'unavailable') {
    throw new Error(
      `Case 3 FAILED: expected traceProvenance "unavailable", got "${sanitizedProviding.traceProvenance}"`
    );
  }
  console.log('  ✓ Case 3: "providing suggestions" narration sanitized');
}

function main(): void {
  console.log('🧪 Manual smoke: sanitizeCodeReviewTrace suggestion false-positive\n');
  checkCodeIdentifierPreserved();
  checkNarrationSanitized();
  checkProvidingSanitized();
  console.log('\n✓ Manual smoke test passed: sanitizeCodeReviewTrace suggestion false-positive');
}

main();
