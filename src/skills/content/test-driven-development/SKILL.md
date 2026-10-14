---
name: test-driven-development
description: Test-driven development methodology grounded in wf's verification pipeline.
---

**Category:** Methodology skill.

## The Iron Law

Write the failing test first. If production code was written before the test, delete it and start over.

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

## Red-Green-Refactor

**RED** — Write one minimal test for one behavior. Run `yarn test src/path/to/file.spec.ts`. Confirm it fails because the feature is absent — not because of a syntax error or import issue.

**GREEN** — Write the smallest implementation that makes the test pass. Run again to confirm.

**REFACTOR** — Clean up names and duplication while tests stay green. Add no behavior.

## Good Tests

- Name the production change that would make the test fail — before writing the test.
- Assert on real output values; when you inspect a mocked collaborator's arguments, also assert it was called.
- One behavior per test; if the name contains "and", split it.
- Use `jest.restoreAllMocks()` in `afterEach`.

```typescript
it('returns null when SKILL.md cannot be read', async () => {
  mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  const result = await readSkillContent('missing-skill');
  expect(result).toBeNull();
});
```

## wf Mechanics

- **Test framework**: Jest 30; spec files co-located as `*.spec.ts` alongside their source in `src/`.
- **Target-repo detection**: `detect-test-infra.ts` detects `fileSuffix`, `mockCleanup`, and `mockFactoryPrefix` per target repo. These drive conventions in code generated *for* target repos — not in wf's own specs.
- **No internal test runner**: The implementing agent runs allowlisted verification commands itself. wf does not execute tests internally.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. The test takes 30 seconds. |
| "I already manually tested it" | Manual is ad hoc, has no record, and cannot be re-run when the code changes. |
| "Tests after achieve the same goals" | Tests written after are biased by the code already written. They verify what was built, not what should have been built. You never watched the test fail, so you never proved it can catch the bug. |
| "TDD will slow me down" | TDD catches bugs before commit, prevents regressions, and lets you refactor without fear. |

## Red Flags

Stop and reassess when you notice:

- Production code written before the test.
- A test that passes immediately with no implementation.
- Inability to explain why a test failed.
- Rationalizing an exception for this one case.
- "I'll write the tests after" or "I already tested it manually."

## Verification Checklist

Before marking work complete:

- [ ] Every new function has a test.
- [ ] Each test was watched failing before writing the implementation.
- [ ] Each test failed because the feature was absent (not a typo or import error).
- [ ] Minimal code was written to make each test pass.
- [ ] All tests pass with no warnings in the output.

## Planning

When writing a plan, order steps test-first:

- For each behavior, the step that writes its failing spec immediately precedes the step that implements it.
- Declare each spec's run command under `verification.targeted`.
- Plan steps never run commands: writing a spec file is a file change; running it belongs in `verification.targeted`.
