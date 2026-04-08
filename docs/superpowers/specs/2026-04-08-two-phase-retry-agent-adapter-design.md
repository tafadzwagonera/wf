# Two-Phase Retry + Experimental Anthropic Agent Adapter

**Date:** 2026-04-08
**Status:** Implemented

## Problem

`issue:implement` uses a retry loop that regenerates files one at a time and feeds raw diagnostic text back to the AI. Two failure categories consistently escaped resolution:

- **TypeScript type errors (B)** — cascading type mismatches across multiple files; each `generateFileChange()` call is file-isolated, so the AI never sees sibling-file state or follows import chains.
- **Test failures (C)** — `hasActionableDiagnostics()` missed Jest/Mocha patterns (premature bail-out); even when retries proceeded, the AI lacked test source context to infer expected behaviour.

## Solution

### 1. Expanded `hasActionableDiagnostics()` pattern

Added Jest/Mocha patterns to prevent premature bail-out on test failures:

```
● |expect\(|received|assertion|✕|✗|FAIL\s|0 passing|[0-9]+ failing
```

### 2. Two-phase retry (standard path, all providers)

**Attempt 1:** unchanged — `generateRepoFiles()` → `verifyImplementation()`.

**Attempt N (N > 1):**

```
diagnoseRetryFailure(failure, repoFiles, repoDir, additionalRepoDirs)
  ├── collectImplicatedFileContents()   — current disk state
  ├── collectRelatedTypeFiles()          — import-chain, depth 1, cap 10
  ├── collectTestSources()               — if test failure detected
  └── aiService.diagnoseVerificationFailure() → FixPlan

generateRepoFiles(repoFiles, ..., fixPlan)
  └── each generateFileChange() receives:
        - sceneContext (unchanged)
        - fixPlan.summary + per-file rationale
        - relatedFiles contents
        - retryContext (existing diagnostics prose)
```

### 3. `additionalRepoDirs` threading

`ImplementerOptions` gained `additionalRepoDirs?: string[]`. Both `IssueCommand` and `IssueImplementCommand` populate it with `options.repos.slice(1)` resolved via `resolveRepoBasePath`. This enables cross-repo reads in `collectRelatedTypeFiles` and `collectTestSources`.

**Cross-repo read/write policy:**

| Operation | Scope |
|---|---|
| Read | `repoDir` + all `additionalRepoDirs` |
| Write | `repoDir` only |
| Shell commands | Verification whitelist, `cwd = repoDir` |

### 4. Experimental Anthropic Agent Adapter

When `stages.implement.experimentalAgent: true` and `ai.provider === 'anthropic'`, `ImplementerAgent.execute()` delegates to `AnthropicAgentAdapter.generateAndVerify()`.

The adapter exposes three tools to the model:

- `read_file` — reads from `repoDir` + `additionalRepoDirs`
- `write_file` — writes to `repoDir` only
- `run_command` — runs commands from the verification whitelist

The model drives its own inner loop until `stop_reason === 'end_turn'` or the turn limit is reached.

## Files Changed

| File | Change |
|---|---|
| `src/agents/interfaces.ts` | Added `FixPlan`, `additionalRepoDirs` in `ImplementerOptions`, `IImplementerBackend` |
| `src/integrations/ai/ai.service.ts` | Added `diagnoseVerificationFailure()` |
| `src/agents/implementer.agent.ts` | Expanded pattern, added diagnosis helpers, two-phase retry loop, backend selection |
| `src/integrations/ai/adapters/anthropic-agent.adapter.ts` | New file — agent backend |
| `src/commands/issue-implement.command.ts` | `additionalRepoDirs`, updated description + examples |
| `src/commands/issue.command.ts` | `additionalRepoDirs` |
| `README.md` | Retry strategy subsection |
