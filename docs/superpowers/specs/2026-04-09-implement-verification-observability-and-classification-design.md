# Implement Verification Observability And Classification

**Date:** 2026-04-09
**Status:** Proposed
**Supersedes:** `2026-04-08-structured-retry-failure-classification-design.md` in the areas of backend observability and verification artifacts

## Problem

`issue:implement` can run in two materially different execution modes:

- the standard two-phase retry loop in `ImplementerAgent`
- the experimental Anthropic agent backend

Today, it is too hard to answer basic operational questions from the logs alone:

- Which backend was selected for this run?
- Was the backend choice intentional or a fallback?
- Why did verification continue or stop?
- Did the retry loop make measurable progress between attempts?
- Did the failure narrow to a small parse or lint issue, or did it remain broad?

The observed `WBP-3054` run exposed both gaps at once:

1. Runtime evidence showed the standard two-phase path was active.
2. Repository config suggested the Anthropic agent backend should have been eligible.
3. Verification retries kept operating on a changing but still underspecified failure picture.
4. The terminal output was not sufficient to explain backend selection or convergence clearly.

This is primarily an observability problem with a smaller policy problem attached to it.
The system needs to say what it is doing before it can reliably improve what it does next.

## Goals

- Make backend selection explicit in both terminal output and persisted artifacts.
- Persist enough per-attempt verification state to debug retry behavior after the fact.
- Introduce deterministic failure classification that the retry controller can use directly.
- Add one cheap policy guardrail for narrow parse failures without redesigning the whole retry engine.
- Keep the implementation small, explicit, and easy to replace.

## Non-Goals

- Replacing the current two-phase retry architecture.
- Reworking verification command ordering.
- Building a generic workflow-state framework shared across all commands.
- Implementing AST-based auto-repair or model-independent code patching.
- Achieving full policy parity between the standard backend and the Anthropic backend in this pass.

## Proposed Solution

### 1. Add explicit backend selection reporting

At the start of `issue:implement`, record the configured intent and the actual backend selected.

Example terminal line:

```text
Implement backend: two-phase (configured: anthropic-agent, provider: openai, reason: provider mismatch)
```

Required fields:

- configured backend intent
- actual backend used
- provider selected for the implement stage
- fallback reason when actual backend differs from intent

This information should be:

- printed once to the terminal near the start of the implement stage
- written to a persisted run artifact

### 2. Persist per-run and per-attempt verification artifacts

Add lightweight JSON artifacts for operational debugging.

Proposed per-run artifact:

```ts
interface ImplementRunArtifact {
  ticketKey: string;
  repoDir: string;
  backendConfigured: 'two-phase' | 'anthropic-agent';
  backendSelected: 'two-phase' | 'anthropic-agent';
  provider: string;
  fallbackReason?: string;
  verificationScripts: Array<{ id: string; command: string }>;
  startedAt: string;
}
```

Proposed per-attempt artifact:

```ts
interface VerificationAttemptArtifact {
  ticketKey: string;
  attemptNumber: number;
  backend: 'two-phase' | 'anthropic-agent';
  command: string;
  exitCode: number;
  failed: boolean;
  classification: VerificationFailureClassification;
  fingerprint: string;
  progress: {
    advancedStage: boolean;
    reducedDiagnostics: boolean;
    narrowedFileSet: boolean;
  };
  retryScope: string[];
  createdAt: string;
}
```

Requirements:

- artifacts must be append-only for the duration of a run
- artifacts must be readable without replaying console output
- artifacts must avoid storing unnecessary full-file contents
- the persisted shape must stay small enough for routine inspection and test fixtures

### 3. Introduce deterministic verification failure classification

Add a rule-based classifier between verification failure capture and retry regeneration.

```ts
type VerificationFailureCategory =
  | 'parse'
  | 'lint'
  | 'typecheck'
  | 'test-compile'
  | 'test-runtime'
  | 'build'
  | 'command'
  | 'unknown';

type RetryScopeStrategy = 'surgical' | 'paired-files' | 'broad-context';

interface VerificationFailureClassification {
  category: VerificationFailureCategory;
  implicatedFiles: string[];
  companionFiles: string[];
  rootSignal: string;
  strategy: RetryScopeStrategy;
  confidence: 'high' | 'medium' | 'low';
}
```

Classification must be deterministic and based on:

- command identity
- structured error patterns such as `TS1234`, ESLint output, Jest assertion failures, parser syntax errors
- file-path extraction from diagnostics

Classification must not depend on an LLM call.

### 4. Add a narrow parse-failure guardrail

Add one concrete retry-policy improvement in this pass:

- when classification is `parse`
- and diagnostics point to one concrete file
- pin the next retry scope to that file plus its source/spec companion when applicable

Additional rules:

- inject explicit parse-repair instructions into the retry context
- do not widen scope on a parse retry without new file evidence
- stop early when the same parse-class fingerprint repeats on the same implicated file set without measurable reduction

This is intentionally narrow because parse failures are cheap to classify and were the terminal failure mode in the observed run.

### 5. Feed classification into diagnosis and retry context

Extend the diagnosis inputs and retry context so the model receives:

- failure category
- root signal
- implicated files
- selected scope strategy
- instruction to avoid broad rewrites when the strategy is `surgical`

This preserves the current two-phase model:

1. diagnose
2. regenerate within the constrained scope

### 6. Keep Anthropic backend scope minimal in this pass

For the Anthropic backend:

- add backend-selection reporting if the selection logic passes through shared code
- reuse the same run artifact writer when possible
- do not redesign the inner loop in this pass

If per-attempt parity is easy to add cleanly, include it. If not, the standard backend remains the required target for attempt-level artifacting in this change.

## Retry Policy By Category

- `parse`
  - strategy: `surgical`
  - retry scope: implicated file plus explicit companion only
  - early stop on repeated same-file parse fingerprint

- `lint`
  - strategy: `surgical`
  - retry scope: directly implicated files plus explicit companion when justified

- `typecheck`
  - strategy: `paired-files`
  - retry scope: implicated files plus paired source/spec files and directly referenced type context

- `test-compile`
  - strategy: `paired-files`
  - retry scope: failing test file plus implementation companion

- `test-runtime`
  - strategy: `paired-files`
  - retry scope: failing source/test pair unless diagnostics show multiple unrelated failures

- `build`
  - strategy: `broad-context`
  - retry scope: current broader behavior remains acceptable

- `command`
  - strategy: `broad-context`
  - behavior: preserve current fallback behavior but emit clearer operational output

- `unknown`
  - strategy: `broad-context`
  - behavior: preserve current fallback behavior and mark the artifact confidence as low

## File Changes

### `src/agents/interfaces.ts`

- Add shared types for:
  - `ImplementBackendSelection`
  - `VerificationFailureCategory`
  - `RetryScopeStrategy`
  - `VerificationFailureClassification`
  - artifact interfaces if shared placement makes sense

### `src/agents/implementer.agent.ts`

- Add backend-selection resolution helper
- Emit terminal log for selected backend
- Write run artifact
- Classify verification failures before diagnosis
- Record per-attempt artifacts
- Add parse-class early-stop and narrow-scope handling
- Inject classification data into retry context

### `src/integrations/ai/ai.service.ts`

- Extend diagnosis input shape with classification metadata
- Update diagnosis prompt so minimal-scope fixes are explicit

### `src/integrations/ai/adapters/anthropic-agent.adapter.ts`

- Reuse backend-selection artifact structures when practical
- Keep behavior changes minimal and avoid inner-loop redesign

### `src/shared/utils/` or similar helper location

- Add pure helpers for:
  - backend selection summary formatting
  - verification failure classification
  - verification artifact writing

## Testing Strategy

Add or update tests for:

- backend selection reporting when:
  - experimental backend is configured and provider is anthropic
  - experimental backend is configured but provider is not anthropic
  - experimental backend is disabled
- parse classification from Prettier or parser syntax errors
- lint classification from ESLint diagnostics
- typecheck classification from `TSxxxx` output
- test-compile classification from Jest TypeScript compile failures
- test-runtime classification from assertion failures
- per-attempt artifact persistence
- parse retry scope narrowing
- early stop on repeated same-file parse fingerprints without progress

## Risks

### Classification drift

Diagnostic formats vary across tools and may change slightly over time.

Mitigation:

- keep rules table-driven
- classify conservatively
- preserve `unknown` fallback

### Too much artifact noise

Artifacts can become clutter if every command emits large payloads.

Mitigation:

- keep artifacts compact
- avoid full command output duplication when existing logs already contain it
- persist summaries, not raw file contents

### Over-constraining parse retries

A parse error may sometimes be a symptom of a broader broken rewrite.

Mitigation:

- allow explicit paired-file companions
- only early-stop when the same parse fingerprint and file set repeat without improvement

## Open Decisions

- Artifact location: `.wf/state` vs `.wf/logs`
- Whether attempt artifacts should be one file per attempt or a single append-only run file
- Whether Anthropic backend attempt-level artifact parity is required now or deferred

## Recommendation

- Store a single append-only run file in the existing wf state area
- Require full per-attempt artifacts for the standard two-phase backend in this pass
- Add Anthropic backend parity only where the shared code path keeps the implementation small

## Acceptance Criteria

- Every implement run prints a single explicit backend-selection line.
- Every implement run persists backend-selection metadata in a machine-readable artifact.
- Every failed verification attempt in the standard backend persists a compact classification artifact.
- Parse failures narrow retry scope to the implicated file set instead of triggering broad rewrites by default.
- Repeated same-file parse failures stop early with a clear message.
- Existing behavior for broader build and unknown failures remains intact unless classification confidently narrows scope.
