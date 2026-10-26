---
name: test-driven-development
description: Test-driven development methodology grounded in wf's verification pipeline.
---

**Category:** Methodology skill.

## The iron law

Write the failing test first, with no exceptions. A test written first specifies the behavior; a test written after only describes what the code already does. If production code was written before the test, delete it and start over.

## Red-Green-Refactor

**RED** — Write one minimal test for one behavior. Run the spec through the repo's package manager, e.g. `<pm> test src/path/to/file.spec.ts`. Confirm it fails because the feature is absent, not because of a syntax error or import issue.

**GREEN** — Write the smallest implementation that makes the test pass. Run again to confirm.

**REFACTOR** — Clean up names and duplication while tests stay green. Add no behavior.

## Good tests

- Before writing the test, name the production change that would make it fail.
- Assert on real output values. When you inspect a mocked collaborator's arguments, also assert it was called.
- Cover one behavior per test; a name that needs "and" usually means two tests.
- Use `jest.restoreAllMocks()` in `afterEach`.

```typescript
it('returns null when SKILL.md cannot be read', async () => {
  mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  const result = await readSkillContent('missing-skill');
  expect(result).toBeNull();
});
```

## wf mechanics

- **Test framework**: Jest 30; spec files co-located as `*.spec.ts` alongside their source in `src/`.
- **Target-repo detection**: `detect-test-infra.ts` detects `fileSuffix`, `mockCleanup`, and `mockFactoryPrefix` per target repo. These drive conventions in code generated *for* target repos, not in wf's own specs.
- **No internal test runner**: The implementing agent runs allowlisted verification commands itself. wf does not execute tests internally.

## Why test-first holds up

| Objection | Response |
|-----------|----------|
| "Too simple to test" | Simple code still breaks, and the test takes seconds to write. |
| "I already tested it manually" | Manual checks leave no record and cannot be re-run when the code changes. |
| "Tests after achieve the same goals" | Tests written after are shaped by the code. They verify what was built rather than what should have been built, and a test you never watched fail has not proven it can catch the bug. |
| "TDD will slow me down" | It catches bugs before commit, prevents regressions, and makes refactoring safe. |

## Stop and reassess when

- Production code exists before its test.
- A test passes immediately with no implementation.
- You cannot explain why a test failed.
- You are building a case for skipping the test just this once.

## Verification checklist

Before marking work complete:

- Every new function has a test.
- Each test was watched failing before writing the implementation.
- Each test failed because the feature was absent (not a typo or import error).
- Minimal code was written to make each test pass.
- All tests pass with no warnings in the output.

## Planning

When writing a plan, order steps test-first:

- For each behavior, the step that writes its failing spec immediately precedes the step that implements it.
- Declare each spec's run command under `verification.targeted`.
- Plan steps never run commands: writing a spec file is a file change; running it belongs in `verification.targeted`.
