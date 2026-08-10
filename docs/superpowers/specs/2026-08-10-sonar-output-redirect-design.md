# Sonar Output Redirect

**Date:** 2026-08-10
**Status:** Draft

## Problem

`wf issue:review` hangs after SonarScanner exits with code 1. The scanner's raw stdout/stderr (up to 4 MB) is injected into the AI review prompt via `buildSonarSection()`. When that output is large — especially on scanner failure, where stderr contains a full error trace — the assembled prompt exceeds the model's effective context budget. The AI response is truncated or malformed, validation retries fire with the same oversized prompt, and the provider session enters repeated context compaction cycles with no forward progress.

## Root Cause

`sonarOutput` flows untruncated from `resolveSonarOutputForTarget()` through the review stage service, into the AI service, and into prompt assembly (`buildReviewPrompt()` / `buildStageReviewPrompt()`). There is no size gate on the sonar output — the 4 MB `maxBuffer` on `child_process.exec()` is the only bound.

## Solution

Remove sonar output from the AI prompt entirely. Redirect scanner output to the terminal (stdout/stderr via `onProgress`). Add two new skip guards: one for repos with a remote `sonar.host.url`, and one when `shouldForkReviewSession` is true.

## Design

### 1. Remove sonar output from AI prompt

**`src/commands/issue-review.command.ts`**

`resolveSonarOutputForTarget()` return type changes from `Promise<string | undefined>` to `Promise<void>`. Scanner output is logged to the terminal via `onProgress()` instead of being returned:

- Exit code 0: log stdout via `onProgress()` (gray status lines in terminal).
- Exit code non-zero: log exit code and stderr summary via `onProgress()`.

The `sonarOutput` variable at the call site (line 578) is removed. Downstream calls to `reviewStageService.reviewDiff()`, `displayReview()`, and artifact persistence no longer receive a `sonarOutput` parameter.

**`src/integrations/ai/prompt-fragments.ts`**

Delete `buildSonarSection()` (lines 102-107). No prompt fragment references sonar output.

**`src/integrations/ai/ai.service.ts`**

- `buildReviewPrompt()` (lines 724-737): remove `sonarOutput` parameter and the `sonarSection` assembly.
- `buildReviewPromptFrom()` (lines 989-992): remove `sonarOutput` parameter.
- `reviewCode()` (lines 974-987): remove `sonarOutput` parameter.

**`src/integrations/ai/stage-agent.service.ts`**

- `buildStageReviewPrompt()` (lines 410-419): remove `sonarOutput` parameter and the `buildSonarSection()` call.
- `reviewCode()` (lines 1011-1025): remove `sonarOutput` from the `opts` object.

**`src/workflows/stages/review-stage.service.ts`**

- `reviewDiff()` and `performReview()`: remove `sonarOutput` from `ReviewDiffOptions` and downstream calls.
- Remove sonar output from the review markdown artifact.

### 2. Redirect scanner output to terminal

In `resolveSonarOutputForTarget()`, after `runSonarScan()` returns:

```
const combinedOutput = (scanResult.stdout + '\n' + scanResult.stderr).trim();
if (combinedOutput) onProgress?.(combinedOutput);
if (scanResult.exitCode !== 0) {
  onProgress?.('SonarScanner exited with code ' + scanResult.exitCode);
}
```

Scanner output appears as gray terminal lines. It is never stored, passed to AI, or persisted to artifacts.

### 3. Skip scan when `sonar.host.url` is present

New guard in `resolveSonarOutputForTarget()`, after the `hasSonarProjectProperties()` check:

- Read `sonar-project.properties` from `target.repoDir`.
- Parse for `sonar.host.url` key.
- If present: log `'SonarScanner skipped: sonar.host.url is configured; remote analysis not supported locally'` via `onProgress()` and return early.

Implementation detail: simple line-by-line parse of the properties file. No new dependencies.

### 4. Skip scan when `shouldForkReviewSession` is true

Thread fork-session context into `resolveSonarOutputForTarget()` via an options parameter. Add a guard:

- If `shouldForkReviewSession(estimatedComplexity, passCount, resumeSessionId)` returns true: log `'SonarScanner skipped: review session forked'` via `onProgress()` and return early.

In `issue-review.command.ts` (standalone `wf issue:review`), `shouldForkReviewSession` is never true because there is no implementer pipeline. This gate only activates when called from `issue.command.ts`.

### 5. Presentation cleanup

**`src/shared/presentation/review-presenter.service.ts`**

- Delete `displayStaticAnalysis()` (lines 64-68).
- Remove `sonarOutput` parameter from `displayReview()` (line 26).
- Remove the `this.displayStaticAnalysis(sonarOutput)` call (line 31).

**`src/commands/issue-review.command.ts`**

- `displayReview()` (line 1407): remove `sonarOutput` parameter.
- Call site (line 584): remove `sonarOutput` argument.

### 6. Delete `shouldWaiveSonarScan()`

**`src/review/sonar-scanner.ts`**

Delete `shouldWaiveSonarScan()` (lines 68-70). Its role is replaced by the `shouldForkReviewSession` guard at the call site. The two functions had mirrored logic; consolidating to a single guard eliminates the duplication.

## Guard Evaluation Order

```
1. --skip-sonar flag              -> skip
2. stages.review.sonar = false    -> skip
3. no repoDir                     -> skip
4. no sonar-project.properties    -> skip
5. sonar.host.url present         -> skip (new)
6. shouldForkReviewSession = true -> skip (new)
7. run scanner, log output to terminal
```

## What Gets Deleted

| Symbol | File | Reason |
|--------|------|--------|
| `buildSonarSection()` | `prompt-fragments.ts` | No prompt injection |
| `displayStaticAnalysis()` | `review-presenter.service.ts` | No sonar string to render |
| `shouldWaiveSonarScan()` | `sonar-scanner.ts` | Replaced by `shouldForkReviewSession` guard |
| `sonarOutput` parameter | `reviewDiff`, `performReview`, `reviewCode`, `buildReviewPrompt`, `buildStageReviewPrompt`, `displayReview` | Entire threading chain removed |

## What Stays

| Symbol | File | Reason |
|--------|------|--------|
| `runSonarScan()` | `sonar-scanner.ts` | Still spawns `npx @sonar/scan` |
| `hasSonarProjectProperties()` | `sonar-scanner.ts` | Still the primary gate check |
| `buildSkippedSonarResult()` | `sonar-scanner.ts` | Retained for skip-reason patterns |
| `--skip-sonar` flag | `issue-review.command.ts` | User-facing escape hatch |
| `stages.review.sonar` config | `wf.config.ts` | Config-level disable |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No `sonar-project.properties` | Skip, log reason |
| `sonar.host.url` present | Skip, log warning |
| `shouldForkReviewSession` true | Skip, log reason |
| Scanner exit code 0 | Log stdout to terminal, proceed with AI review |
| Scanner exit code non-zero | Log exit code + stderr to terminal, proceed with AI review |
| `--skip-sonar` flag | Skip (unchanged) |
| `stages.review.sonar: false` | Skip (unchanged) |
| Scanner stdout/stderr empty | Nothing logged, proceed with AI review |

## Test Impact

- `ai.service.spec.ts`: Remove tests that assert `sonarOutput` presence in prompt.
- `stage-agent.service.spec.ts`: Remove tests that assert `sonarOutput` in agent prompt.
- `review-presenter.service.spec.ts`: Remove `displayStaticAnalysis` tests; update `displayReview` call signatures.
- `issue-review.command.spec.ts`: Update `resolveSonarOutputForTarget` tests for new return type and new guards.
- `sonar-scanner.ts` spec (if present): Remove `shouldWaiveSonarScan` tests.
- New tests: `sonar.host.url` guard, `shouldForkReviewSession` guard.
