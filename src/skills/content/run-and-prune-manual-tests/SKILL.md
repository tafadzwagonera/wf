---
name: run-and-prune-manual-tests
description: Run the live smoke tests related to a change until they pass, then remove redundant manual tests whose observable coverage duplicates other manual tests or existing framework tests. Use to verify a change and curate the manual test suite.
---

**Category:** Methodology skill.

## Purpose

Two-phase finishing pass over the current project's `test/manual` suite: first prove the change works by running its related live smoke tests to green, then shrink the suite by deleting tests that assert nothing another test doesn't already assert — whether that other test is a manual test or a framework test (unit/integration specs, e.g. co-located `*.spec.ts` Jest files).

Unlike a full teardown, this keeps the manual test infrastructure and every test that earns its place. Only redundancy is removed.

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
