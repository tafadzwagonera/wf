---
name: run-manual-tests
description: Run the newly generated manual smoke tests until they all pass. Use after manual tests have been written (e.g. from draft-manual-tests prompts) to verify the change. Deleting manual tests is out of scope — that is run-and-prune-manual-tests' job.
---

**Category:** Methodology skill.

## Purpose

Execute every newly generated smoke test in the current project's `test/manual` through the real runner until each one passes. Pre-existing manual tests are not run, and nothing is deleted — pruning and teardown belong to the `run-and-prune-manual-tests` skill.

This skill is the companion to `draft-manual-tests`, which produced the prompts the tests were implemented from.

## Run until green

1. **Identify the generated tests before running anything.** Capture `git status --porcelain` for `test/manual/`, the runner (`run-manual-test.ts`), and `package.json`. Untracked or newly added `test/manual/*.smoke.ts` files are the run set; tracked, pre-existing tests are not — leave them alone.
2. **Build first.** If the CLI under test runs from compiled output, rebuild (`nest build`, `nr build`, or the project's equivalent) before every run that follows a source change — manual tests exercising `dist/` silently test stale code otherwise.
3. **Run each generated test individually** via the project's runner script, e.g. `nr test:manual {feature}.smoke`, using the package manager the lockfile dictates. Do not batch: one test per invocation keeps failures attributable.
4. **Order by cost.** Run offline tests first. Tests suffixed `-live` call real providers or APIs and cost money and time — run them last, one at a time, only once the offline tests pass.
5. **On failure, diagnose before editing.** Read the reporter's `FAIL` lines and decide which is broken:
   - *The product* — the test exposed a real defect in the change. Fix the production code, rebuild, rerun.
   - *The test* — a wrong assertion, stale CLI flag, or bad wire-up. Fix the test to match the intended observable behavior.
   Never weaken an assertion, broaden a match, or swallow an exit code just to make a test pass — a green run earned that way verifies nothing.
6. **Two failed fix attempts on the same test means stop iterating.** Re-examine the hypothesis, state what was tried and why it failed, and ask before continuing — repeated blind reruns of live tests burn real API spend.
7. **Exit criterion:** every generated smoke test prints its pass summary and exits 0 in a single final run per test, with the production code in its finished state.

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
