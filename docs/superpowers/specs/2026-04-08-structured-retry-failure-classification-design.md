# Structured Retry Failure Classification

**Date:** 2026-04-08
**Status:** Proposed

## Problem

`issue:implement` already has a two-phase retry loop, but its retry decisions are still mostly prompt-driven:

- It infers retry scope from raw diagnostic text and spec/source pairing.
- It tracks progress across attempts, but not the actual class of failure being retried.
- It does not distinguish narrow lint failures from broader type or test failures strongly enough.

In the observed `WBP-3054` run, this produced a non-converging pattern:

1. Attempt 1 failed on narrow lint issues in a small file set.
2. Attempt 2 broadly regenerated the same core files and introduced a new narrow lint residue.
3. Attempt 3 cleared lint, then failed on TypeScript and test-shape mismatches.
4. Subsequent retries kept re-entering the same broad rewrite path instead of using the current failure class to constrain scope.

The root issue is not only prompt quality. The retry loop lacks structured state about:

- what kind of failure just happened,
- which files actually own that failure,
- whether scope should stay surgical or expand,
- and when a retry is repeating the same category with no net convergence.

## Goals

- Make retry decisions explicit and observable.
- Constrain retries to the smallest file set consistent with the current failure class.
- Preserve the existing two-phase model: diagnose first, then regenerate.
- Improve convergence for lint, typecheck, and test failures without introducing a large workflow framework.
- Keep the implementation readable and easy to replace.

## Non-Goals

- Replacing the current two-phase retry architecture.
- Building a generic planner or state machine framework for all commands.
- Changing verification script discovery or branch creation behavior.
- Solving flaky external verification or network-dependent failures in this change.

## Proposed Solution

### 1. Introduce structured retry classification

Add a retry classification model in the implementer flow:

```ts
type RetryFailureCategory =
  | 'lint'
  | 'typecheck'
  | 'test-compile'
  | 'test-runtime'
  | 'build'
  | 'unknown';

type RetryScopeStrategy = 'surgical' | 'paired-files' | 'broad-context';

interface RetryFailureClassification {
  category: RetryFailureCategory;
  implicatedFiles: string[];
  companionFiles: string[];
  rootSignal: string;
  suggestedStrategy: RetryScopeStrategy;
  shouldRunDiagnosis: boolean;
}
```

This classification is derived from the current `VerificationFailure` before the next retry pass is assembled.

### 2. Introduce retry attempt state

Track retry state explicitly inside `ImplementerAgent.execute()`:

```ts
interface RetryAttemptState {
  attemptNumber: number;
  classification: RetryFailureClassification;
  retryRepoFiles: string[];
  trackedFilesChanged: boolean;
  repeatedCategory: boolean;
  repeatedScope: boolean;
  repeatedFingerprint: boolean;
}
```

This state is local to the current `issue:implement` run and is used to:

- explain why the next retry is allowed,
- explain why the retry scope widened or stayed narrow,
- stop retries that repeat the same category and scope without meaningful reduction.

### 3. Make file scope classification-driven

The retry scope should come from classification, not only from raw file mentions.

Rules:

- `lint`
  - Retry only the directly implicated files.
  - Add paired source/spec files only when diagnostics explicitly implicate both sides or the file is a spec/test file with a known companion in `filesAffected`.
  - Prefer `surgical`.

- `typecheck`
  - Retry implicated files plus source/spec companions.
  - Include diagnosis context from related type files.
  - Prefer `paired-files`.

- `test-compile`
  - Retry the failing test file and its implementation companion.
  - Include related type files and test context.
  - Prefer `paired-files`.

- `test-runtime`
  - Retry the failing implementation/test pair.
  - Keep the scope tighter than current broad regeneration unless multiple unrelated runtime failures exist.
  - Prefer `paired-files`, escalate to `broad-context` only when multiple independent files fail.

- `build`
  - Use the current broader behavior because module graphs and packaging failures often span multiple files.
  - Prefer `broad-context`.

- `unknown`
  - Preserve current fallback behavior, but log that classification was inconclusive.

### 4. Pass classification into diagnosis and generation

Extend the AI diagnosis contract so the model is told what class of failure it is fixing and how narrow the retry is expected to be.

Proposed `FixPlan` expansion:

```ts
interface FixPlan {
  summary: string;
  fixes: FixPlanEntry[];
  testContext?: string;
  classification?: {
    category: RetryFailureCategory;
    rootSignal: string;
    strategy: RetryScopeStrategy;
  };
}
```

This is intentionally additive so existing callers remain easy to adapt.

The diagnosis prompt should explicitly say:

- current failure class,
- implicated files,
- why the scope is surgical or paired,
- that the fix must stay within that scope unless the evidence clearly contradicts it.

### 5. Tighten convergence rules

Current retry budgeting already considers stage advancement and shrinking diagnostics. Keep that, but add classification-aware stop and continue rules:

- Allow another retry when category severity clearly improves:
  - `build -> test-runtime -> test-compile -> typecheck -> lint`
- Allow another retry when the file scope shrinks materially after a deeper failure collapses into a residual narrow failure.
- Stop when the same category, same retry scope, and same failure fingerprint repeat without net reduction.
- Stop when a retry classified as `lint` or `typecheck` expands scope without explicit evidence.

This directly targets the observed failure mode where narrow lint retries expanded back into broad rewrites.

## Implementation Plan

### A. `src/agents/interfaces.ts`

- Add `RetryFailureCategory`, `RetryScopeStrategy`, and `RetryFailureClassification`.
- Extend `FixPlan` with optional classification metadata.

### B. `src/agents/implementer.agent.ts`

- Add helpers to classify a `VerificationFailure`.
- Add helpers to compute retry scope from classification.
- Add `RetryAttemptState` and integrate it into the retry loop.
- Update retry exit conditions to consider repeated category/scope patterns.
- Update `buildRetryContext()` so it includes classification and explicit scope instructions.
- Keep existing progress tracking, but combine it with classification-aware decisions instead of replacing it.

### C. `src/integrations/ai/ai.service.ts`

- Extend `diagnoseVerificationFailure()` input with classification data.
- Update the diagnosis prompt to require classification-aligned, minimal-scope fixes.

### D. Tests

Add or update tests to cover:

- lint classification from ESLint unused import diagnostics,
- typecheck classification from `TSxxxx` diagnostics,
- test-compile classification from TypeScript errors reported during Jest runs,
- test-runtime classification from assertion failures,
- scope selection for each category,
- retry stopping when category and scope repeat without progress,
- retry continuation when category downgrades from deeper failures to residual lint/type failures,
- diagnosis prompt wiring with classification metadata.

## Risks

### Misclassification risk

Some diagnostics are mixed, especially Jest output containing both TypeScript compile failures and runtime assertions.

Mitigation:

- classify by highest-confidence, highest-severity signal,
- preserve `unknown` fallback,
- keep the raw diagnostics in the prompt so the AI still sees full evidence.

### Over-constraining retries

If classification is too narrow, the agent may refuse a change that truly requires one more file.

Mitigation:

- allow explicit paired-file expansion,
- allow `broad-context` for build and multi-file runtime failures,
- keep companion-file inference.

### State complexity

Adding retry state can become noisy if it sprawls across the method.

Mitigation:

- keep state as small typed objects,
- isolate classification and retry-scope decisions into pure helpers,
- avoid introducing a generic workflow framework.

## Open Decisions

- Whether classification metadata should be persisted in logs only or also surfaced in CLI output.
- Whether `FixPlan.classification` is necessary for downstream consumers, or whether passing classification only into prompts is enough.

Recommendation:

- surface a concise CLI line per retry,
- keep `FixPlan.classification` optional for now because it improves observability with low coupling cost.

## Acceptance Criteria

- Retry scope for a lint-only failure remains limited to directly implicated files plus explicit companions.
- Typecheck and test failures no longer default to broad regeneration when only one source/test pair is implicated.
- Repeated same-category same-scope failures stop early with a clear message.
- Downgraded residual failures still receive one more retry when diagnostics materially shrink.
- Existing two-phase retry behavior remains intact for unknown or broad build failures.
