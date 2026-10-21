---
name: run-manual-tests
description: Run implemented manual smoke tests until they all pass, then remove the generated manual test artifacts. Use after manual tests have been written (e.g. from draft-manual-tests prompts) to verify the change and clean up.
---

**Category:** Methodology skill.

## Purpose

Drive the final phase of the manual-test workflow: execute every newly implemented smoke test in the current project's `test/manual` through the real runner until each one passes, then remove the manual test directory and the newly generated tests so no throwaway verification artifacts remain in the repo.

This skill is the companion to `draft-manual-tests`, which produced the prompts the tests were implemented from.

## Phase 1 — Run until green

1. **Record what is generated before running anything.** Capture `git status --porcelain` for `test/manual/`, the runner (`run-manual-test.ts`), and `package.json`. Untracked or newly added paths are the teardown set for Phase 2; tracked, pre-existing paths are not.
2. **Build first.** If the CLI under test runs from compiled output, rebuild (`nest build`, `nr build`, or the project's equivalent) before every run that follows a source change — manual tests exercising `dist/` silently test stale code otherwise.
3. **Run each test individually** via the project's runner script, e.g. `nr test:manual {feature}.smoke`, using the package manager the lockfile dictates. Do not batch: one test per invocation keeps failures attributable.
4. **Order by cost.** Run offline tests first. Tests suffixed `-live` call real providers or APIs and cost money and time — run them last, one at a time, only once the offline tests pass.
5. **On failure, diagnose before editing.** Read the reporter's `FAIL` lines and decide which is broken:
   - *The product* — the test exposed a real defect in the change. Fix the production code, rebuild, rerun.
   - *The test* — a wrong assertion, stale CLI flag, or bad wire-up. Fix the test to match the intended observable behavior.
   Never weaken an assertion, broaden a match, or swallow an exit code just to make a test pass — a green run earned that way verifies nothing.
6. **Two failed fix attempts on the same test means stop iterating.** Re-examine the hypothesis, state what was tried and why it failed, and ask before continuing — repeated blind reruns of live tests burn real API spend.
7. **Exit criterion:** every targeted smoke test prints its pass summary and exits 0 in a single final run per test, with the production code in its finished state.

## Phase 2 — Teardown

Only after every test passes:

1. **Delete only what Phase 1 recorded as generated.** Compare against the pre-run `git status` snapshot:
   - All newly generated `test/manual/*.smoke.ts` files.
   - The `test/manual` directory itself — including `support/` helpers and the runner (`run-manual-test.ts`) and the `test:manual` script in `package.json` — *only if the whole tree was scaffolded by this workflow*. If `test/manual` pre-existed with tracked tests, remove only the newly generated files and leave the directory, shared helpers, runner, and script untouched.
2. **Never delete tracked, pre-existing files without explicit confirmation.** `git status` is the arbiter: untracked and newly added files are fair game; anything that existed before this workflow is not.
3. **Keep the production changes.** Teardown removes test artifacts only — source fixes made during Phase 1 stay.
4. **Verify the end state:** `git status` shows no leftover generated test artifacts, and the production diff still builds and passes the project's standard checks.

## Reference run (the wf pattern)

The runner contract the tests follow — human-readable output, exit 0 on success, exit 1 on any failure:

```console
$ nr test:manual issue-commit-ticket-key-flag.smoke

 issue:commit --ticket-key flag migration

  PASS  issue:commit --help shows -k, --ticket-key
  PASS  issue:commit --help does not show [ticket-key] positional
  PASS  Options alphabetically ordered: [dry-run, help, ticket-key]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Results: ✓ 3 passed   ✗ 0 failed
✓ All tests passed!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$ echo $?
0
```

A failing run names the broken assertion and the observed value, and exits 1:

```console
  FAIL  issue:commit --help does NOT show -k, --ticket-key
    → Usage: main issue:commit [options] ...

Results: ✓ 2 passed   ✗ 1 failed
$ echo $?
1
```

And the matching teardown for a fully scaffolded tree:

```console
$ git status --porcelain
?? run-manual-test.ts
?? test/manual/
 M package.json          ← test:manual script added by scaffold
 M src/commands/...      ← production fix: keep
$ rm -rf test/manual run-manual-test.ts
$ git checkout -- package.json    # only if its sole change was the test:manual script
$ git status --porcelain
 M src/commands/...
```
