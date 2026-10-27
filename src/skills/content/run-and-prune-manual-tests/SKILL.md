---
name: run-and-prune-manual-tests
description: Generate manual smoke tests from draft-manual-tests prompts when none exist yet, run the live smoke tests related to a change until they pass, prune redundant ones, then remove everything the workflow generated (tests, runner, script, config, docs) so the codebase returns to its state before draft-manual-tests ran. Use to verify a change with throwaway live smoke tests.
---

**Category:** Methodology skill.

## Purpose

Verification pass that leaves no trace: generate the drafted manual smoke tests (if none exist), prove the change works by running the related live tests to green, prune redundant tests, then tear down all generated test infrastructure so the working tree matches its pre-`draft-manual-tests` state. Production fixes made while getting to green are the one thing kept.

Only generated artifacts are removed. Manual-test infrastructure or tests that already existed at the baseline (tracked in `HEAD`, or untracked before this run) are never touched.

## Phase 0 — Generate from drafts if none exist

Before writing anything, record the baseline: `git status --porcelain`, whether `run-manual-test.ts`, `test/manual/`, and a `test:manual` script already exist, and the current content of every tracked config file you may edit (`package.json`, `tsconfig*.json`, `README.md`). Phase 3 restores to this baseline, so keep the list of every file you create or edit as you go.

Check `git status --porcelain` for `test/manual/` before starting Phase 1. If untracked or newly added `test/manual/*.smoke.ts` files already exist, skip straight to Phase 1 — someone already implemented the drafts.

If none exist, look for `draft-manual-tests` prompts to implement:

- Prompts produced earlier in this conversation — implement each one as written.
- Otherwise ask the user for the prompts, or run `draft-manual-tests` first; do not invent test scenarios that weren't drafted.

For each prompt, write `test/manual/{feature}.smoke.ts` following the reference implementation and conventions documented in the `draft-manual-tests` skill (docs header, reporter helpers, compiled-path entry via `dist/`, single `summarise(counts)` call). If `test/manual` or its runner infrastructure (`run-manual-test.ts`, `test/manual/support/reporter.ts`, the `test:manual` script in `package.json`) doesn't exist yet, scaffold it per that same reference before writing the first test. Once every prompt has a matching test file, continue to Phase 1.

## Phase 1 — Run related live tests until green

1. **Scope to the change.** A test is *related* when its docs header (`Verifies:` list) or filename names a behavior the change touched. Build the list from the diff, not from the whole directory — running unrelated live tests burns API spend for no signal.
2. **Build first.** Rebuild compiled output (`nest build`, `nr build`, or the project's equivalent) before every run that follows a source change; manual tests exercising `dist/` silently test stale code otherwise.
3. **Run one test per invocation** via the project's runner, e.g. `nr test:manual {feature}.smoke`, with the package manager the lockfile dictates. Run related offline tests first; `-live` suffixed tests last, one at a time.
4. **On failure, diagnose before editing:** a product defect means fix the production code, rebuild, rerun; a test defect (stale flag, wrong assertion, bad wire-up) means fix the test to match intended observable behavior. Never weaken an assertion or swallow an exit code to force a pass.
5. **Two failed fix attempts on the same test means stop iterating** — state what was tried and why it failed, and ask before spending further live-API runs.
6. **Exit criterion:** every related test passes (exit 0) in a final clean run against the finished production code.

## Phase 2 — Remove redundant manual tests

Only after Phase 1 is green.

### What counts as redundant

A manual test is redundant when **every one of its observable assertions is already covered elsewhere**:

- **Manual-vs-manual overlap:** another manual test enters through the same user-facing surface and asserts a superset of its checks. Keep the broader test; delete the subset.
- **Manual-vs-framework overlap:** the test never crosses a user-facing surface — it imports an exported function, service, or schema and asserts on its return value — and a framework spec (`*.spec.ts` or the project's unit/integration suite) already covers that same code path. Internals belong to the framework suite; delete the manual duplicate.

A test is **not** redundant when even one assertion is unique, when it exercises the compiled/user-facing path for behavior specs only cover in-process (dist-only failures are exactly what manual tests exist to catch), or when it is the sole live-provider check for an integration.

### Procedure

1. **Inventory by docs header.** Every manual test opens with a `Verifies:` list — collect these per file and group by behavior/entry point. Filenames sharing a feature prefix (e.g. `issue-commit-*`) are the first overlap candidates.
2. **Diff assertion lists pairwise within each group.** For each candidate, name the surviving test (or spec file) that covers each of its assertions. No full mapping, no deletion.
3. **Check the framework suite** for each manual test that calls internals directly: search the specs co-located with the code under test for the same assertions.
4. **Partial overlap: merge, don't delete.** If a candidate has one unique assertion among duplicates, move that assertion into the surviving test, rerun the survivor to green, then delete the candidate.
5. **Delete with a stated justification.** These are tracked files — record, per removed test, which surviving test or spec covers each assertion (commit message or summary). If coverage is ambiguous, keep the test.
6. **Verify the end state:** each remaining manual test holds at least one assertion nothing else covers; every survivor that was edited still passes; `git status` shows only intended deletions and merges.

### Worked example

`issue-commit-ticket-key-flag.smoke.ts` asserts, via `node dist/main.js issue:commit --help`:

1. help shows `-k, --ticket-key`
2. help shows no `[ticket-key]` positional
3. options are alphabetically ordered

A later `options-alphabetical-order.smoke.ts` asserts, via the same `--help` surface, only that `issue:commit` options are alphabetically ordered — a strict subset of assertion 3 on the identical entry point. It is redundant: delete it, citing `issue-commit-ticket-key-flag.smoke.ts` assertion 3 as the surviving coverage. (Had it swept *every* command's help for ordering, it would be the broader test — then the right move is deleting assertion 3 from the flag test instead, or keeping both and noting the overlap.)

Framework-overlap variant: a manual test that imports `commitOptionsSchema` and asserts `parse` rejects an empty ticket key duplicates the co-located `commit-options.schema.spec.ts` — it never leaves the process, so it adds nothing a spec doesn't already pin. Delete it; the schema's observable effect, the CLI rejecting the flag value with a readable error, belongs in a manual test that invokes the CLI.

## Phase 3 — Tear down generated infrastructure

Only after Phase 2 and a green final run. The goal is a working tree identical to the Phase 0 baseline, apart from production fixes. Do this automatically; do not ask.

1. **Stop leftovers.** Kill any gateway or stub process the tests spawned and confirm the ports are free.
2. **Delete generated files** — only those absent from the baseline: the tests in `test/manual/`, `test/manual/support/`, the runner (`run-manual-test.ts`), and any scratch output. Remove `test/manual/` itself if it did not exist at the baseline and is now empty. Use `git rm -rf` for staged files, `rm` for untracked ones, and never touch a file that was in the baseline.
3. **Revert generated edits to tracked files** by removing only the hunks this workflow added — the `test:manual` script in `package.json`, the runner entry in a `tsconfig*.json` exclude, any manual-test section in `README.md` or other docs. Check `git diff` for each file first: if it also holds unrelated changes (the user's or the production fix), edit those hunks out by hand and leave the rest. Use `git restore` on a file only when the diff shows nothing but generated changes.
4. **Keep production fixes** made in Phase 1 (changes under `src/`), along with their framework specs. They are the deliverable, not infrastructure.
5. **Verify the end state:** a search for `test:manual`, `run-manual-test`, and `test/manual` over the repo (excluding `node_modules`, `dist`, `.git`) returns nothing that was not in the baseline; `git status` matches the baseline plus intended production changes; the project's build and lint still pass.
6. **Report** what was removed and what was kept, in a short list.
