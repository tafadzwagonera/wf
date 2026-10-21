---
name: conclude-feature
description: Conclude a feature or fix in a target project — write the commit description, commit via wf issue:commit with a ticket-key message, merge worktree branches back, never commit manual tests, and in Nuxt codebases verify explicit imports against .nuxt auto-import declarations before removing them. Use when wrapping up implemented work.
---

**Category:** Workflow skill (target projects).

## Purpose

Finishing pass for a completed feature or fix: write the commit message, commit through wf's CLI, fold any worktree branches back into the active branch, and — in Nuxt codebases — clean up redundant explicit imports with verified evidence first. Nothing here writes new feature code.

## Step 1 — Import hygiene (Nuxt codebases only; verify before removing)

Skip this step entirely when the project is not a Nuxt/Nitro codebase.

Nuxt and Nitro auto-import most framework and project symbols, so explicit imports of auto-imported symbols are usually redundant — but removal without proof breaks builds. **Never remove an import that has not been individually verified.**

**Procedure:**
1. List every file in the code changes that contains explicit imports (`git diff --name-only` scoped to the change, then scan each file's import block).
2. **Assign one sub-agent per changed file** (or per small batch). Each agent must, for every explicitly imported symbol in its file, confirm whether that exact symbol appears in the auto-import declarations:
   - `.nuxt/types/imports.d.ts` — app-side auto-imports (composables, utils, components helpers)
   - `.nuxt/types/nitro-imports.d.ts` — server/Nitro auto-imports
   - `.nuxt/types/shared-imports.d.ts` — shared-layer auto-imports
   The agent reports per symbol: auto-imported (with the declaration file that proves it) or not found. If `.nuxt/types/` is missing or stale, run the project's prepare step (e.g. `nuxi prepare` / dev server postinstall) first — verifying against stale declarations produces false removals.
3. Remove only the imports every relevant declaration file proves redundant; one edit pass per file, then re-run the project's type check and affected tests.

**Exceptions — explicit imports stay, even for auto-imported symbols:**
- **Test files.** Vitest resolves aliases through `vitest.config.ts`, not through Nuxt's auto-import pipeline; tests (and some files under `server/` exercised by the test environment) legitimately import symbols that are auto-imported at runtime.
- **Server utilities importing types via relative paths.** Nuxt does not resolve these — relative type imports in server utils are required, not redundant.
- **Globals in Nitro code.** Nitro auto-imports do not inject globals; an explicit import that supplies what would otherwise be assumed global is correct.

When in doubt, keep the import and note it — a redundant import is harmless; a missing one breaks the build.

## Step 2 — Generate the commit description

Summarize the *nature and scope* of the change — what behavior changed and where — not the implementation journey. Format:

```
{ticket-key}: {Description beginning with an uppercase letter}
```

e.g. `WBP-2971: Add dark-mode detection to repo convention mining`. Keep the subject under 100 characters.

## Step 3 — Stage and commit, integrating worktrees

**Never commit manual tests or the `test/manual` directory.** Before every commit, check `git diff --cached --name-only` for `test/manual/` paths (and the manual-test runner if it was scaffolded); unstage them with `git restore --staged <path>`.

Stage with `git add` immediately before committing — the committer reads the *staged* diff, so unstaged changes are silently excluded.

**If the work lives in git worktrees** (`git worktree list` shows more than the main checkout):
1. In each worktree: stage its changes and commit with
   ```bash
   wf issue:commit -m "WBP-1234: Describe the change"
   ```
2. From the main checkout, merge each worktree branch back into the active branch; resolve conflicts there and rerun the affected tests after each merge.
3. Delete the linked worktree branches once merged: `git worktree remove <path>`, `git branch -d <branch>`, then `git worktree prune`. A worktree with no unique commits is removed without merging.

**Otherwise**, stage and commit directly on the active branch with the same `wf issue:commit -m "{ticket-key}: {Description}"` command.

## Step 4 — Final check

- `git log --oneline -3` shows the new commit(s) on the active branch.
- `git worktree list` shows only the main checkout; no leftover worktree branches in `git branch`.
- `git status` is clean of feature-related files; `test/manual/` was never committed (`git log --stat -1` confirms).
- Type check and the project's standard test command pass after the import cleanup.
