# issue:all Bugs + Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three confirmed bugs in `issue:all` (duplicate interactive-chat banner, duplicate resume log, hard failure on empty commit) and add `--force` idempotency to all `issue:*` commands.

**Architecture:** All fixes are scoped to `src/commands/issue-all.command.ts` and `src/agents/committer.agent.ts`. The duplicate banner is caused by `startInteractiveChat` printing the banner AND `ConversationService.startChatSession` calling `chatUI.displayChatIntro` which also prints the same banner. The duplicate resume log is caused by `startInteractiveChat` calling `console.log('✓ Resuming workflow...')` AND `chatUI.displayChatEnd` inside `ConversationService` also printing `✓ Resuming workflow...`. The empty-commit hard failure is caused by `committer.agent.ts` calling `this.gitService.commit(...)` even when the git status check indicates nothing to commit — the status check tests `status.files.length === 0` (modified/untracked) but `git.commit` independently re-checks staged files and throws `GitError('No changes to commit')` when they are also absent, which bubbles up through `ErrorHandler.handle` and calls `process.exit(1)`. Idempotency is added via a `--force` flag on `issue:all` that bypasses the existing `skipExisting` logic already present in each agent.

**Tech Stack:** TypeScript · NestJS · nest-commander · ts-node (manual tests) · simple-git

---

## Root Cause Analysis

### Bug 1 — Duplicate "Interactive Chat Mode" banner

The call chain is:

```
IssueAllCommand.startInteractiveChat()
  → console.log('💬 Interactive Chat Mode')           ← line 716
  → console.log('─'.repeat(70))                       ← line 717
  → console.log('You can now discuss...')             ← line 718
  → conversationService.startChatSession(...)
      → chatUI.displayChatIntro(stage, context)
          → console.log('💬 Interactive Chat Mode')   ← line 27 of chat-ui.service.ts
          → console.log('─'.repeat(70))               ← line 28
          → console.log('You can now discuss...')     ← line 29
```

`startInteractiveChat` in `issue-all.command.ts` (lines 716-718) manually prints the banner header, then delegates to `conversationService.startChatSession`, which calls `chatUI.displayChatIntro` — printing the identical banner a second time.

**Fix:** Remove lines 716-718 from `IssueAllCommand.startInteractiveChat`. The `chatUI.displayChatIntro` call inside `ConversationService.startChatSession` is the canonical banner printer and must be kept.

---

### Bug 2 — Duplicate "✓ Resuming workflow..." log

The call chain is:

```
IssueAllCommand.startInteractiveChat()
  → conversationService.startChatSession(...)
      → chatUI.displayChatEnd(filePath)
          → console.log('✓ Resuming workflow...')    ← line 258 of chat-ui.service.ts
  → console.log('✓ Resuming workflow...\n')          ← line 758 of issue-all.command.ts
```

After `startChatSession` returns, `chatUI.displayChatEnd` has already printed `✓ Resuming workflow...`. Then `startInteractiveChat` itself prints the same message at line 758.

**Fix:** Remove line 758 from `IssueAllCommand.startInteractiveChat`. `chatUI.displayChatEnd` already owns this output.

---

### Bug 3 — Hard failure on empty commit

In `CommitterAgent.execute`, `GitService.commit` throws `GitError('No changes to commit')` when there are no staged changes after auto-staging. This propagates out of `CommitterAgent.execute` uncaught, is caught by `IssueAllCommand`'s outer catch block, and `ErrorHandler.handle` calls `process.exit(1)`.

The early-exit guard checks `status.files` but does not catch the case where `status.files` contains only `.wf/**` entries (excluded from auto-stage) or where all files are already committed.

**Fix:** Wrap the `this.gitService.commit(...)` call in `CommitterAgent.execute` with a try/catch. Catch errors whose message includes `'No changes to commit'` and convert to a warning log + `return`.

---

### Feature: Idempotency via `--force`

`issue:all` already has a `--skip-existing` flag. The change makes skip-existing the **default** when `--force` is absent, and adds `--force` to bypass it.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/commands/issue-all.command.ts` | Modify | Fix Bug 1 (remove duplicate banner lines), Fix Bug 2 (remove duplicate resume log), add `--force` flag and idempotency defaults |
| `src/agents/committer.agent.ts` | Modify | Fix Bug 3 (catch empty-commit `GitError` and warn instead of throw) |
| `test/manual/test-issue-all-agents.ts` | Modify | Add tests for Bug 3 fix and idempotency behaviour |

---

## Task 1 — Fix Bug 1: Remove duplicate banner from `startInteractiveChat`

**Files:**
- Modify: `src/commands/issue-all.command.ts`

- [ ] **Step 1: Locate the duplicate lines**

  Open `src/commands/issue-all.command.ts`. Find the `startInteractiveChat` method. The method body opens with three `console.log` calls that print the "💬 Interactive Chat Mode" header:

  ```typescript
  console.log(chalk.bold.cyan('\n💬 Interactive Chat Mode'));
  console.log(chalk.gray('─'.repeat(70)));
  console.log(
    chalk.gray(
      'You can now discuss the output with Claude. Type "exit" to continue.',
    ),
  );
  ```

- [ ] **Step 2: Remove the three `console.log` lines**

  Delete these three statements. The method body should now begin with the `ConversationContext` construction.

- [ ] **Step 3: Run lint**

  ```bash
  yarn lint
  ```

  Expected: exits 0, no new errors.

---

## Task 2 — Fix Bug 2: Remove duplicate resume log from `startInteractiveChat`

**Files:**
- Modify: `src/commands/issue-all.command.ts`

- [ ] **Step 1: Locate the duplicate line**

  At the end of `startInteractiveChat`, find:

  ```typescript
  console.log(chalk.green('✓ Resuming workflow...\n'));
  ```

- [ ] **Step 2: Remove the line**

  Delete the `console.log(chalk.green('✓ Resuming workflow...\n'))` statement entirely.

- [ ] **Step 3: Run lint**

  ```bash
  yarn lint
  ```

  Expected: exits 0, no new errors.

---

## Task 3 — Fix Bug 3: Soft-fail on empty commit in `CommitterAgent`

**Files:**
- Modify: `src/agents/committer.agent.ts`

- [ ] **Step 1: Locate the commit call**

  Open `src/agents/committer.agent.ts`. Find the `execute` method's commit call:

  ```typescript
  await this.gitService.commit({ message: finalMsg, cwd: repoDir });
  console.log(chalk.green('\n✓ Changes committed'));
  ```

- [ ] **Step 2: Wrap the commit call in a try/catch**

  Replace:

  ```typescript
  await this.gitService.commit({ message: finalMsg, cwd: repoDir });
  console.log(chalk.green('\n✓ Changes committed'));
  ```

  With:

  ```typescript
  try {
    await this.gitService.commit({ message: finalMsg, cwd: repoDir });
    console.log(chalk.green('\n✓ Changes committed'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No changes to commit')) {
      console.log(chalk.yellow('⚠ Nothing to commit — skipping commit stage'));
      return;
    }
    throw err;
  }
  ```

- [ ] **Step 3: Run lint**

  ```bash
  yarn lint
  ```

  Expected: exits 0.

---

## Task 4 — Add `--force` flag and idempotency defaults to `issue:all`

**Files:**
- Modify: `src/commands/issue-all.command.ts`

- [ ] **Step 1: Add `force` to `IssueAllOptions`**

  Locate the `IssueAllOptions` interface and add the `force` field:

  ```typescript
  force?: boolean;
  ```

- [ ] **Step 2: Add the `@Option` decorator for `--force`**

  After the existing option parser methods, insert:

  ```typescript
  @Option({
    flags: '--force',
    description:
      'Re-run all stages even if artifacts already exist on disk (bypasses idempotency check)',
  })
  parseForce(): boolean {
    return true;
  }
  ```

- [ ] **Step 3: Derive the effective `skipExisting` value at the top of `run()`**

  In the `run` method, after options validation, add:

  ```typescript
  // Idempotency: by default, skip stages whose artifact already exists.
  // --force overrides this and re-runs every stage.
  const skipExisting = !options?.force;
  ```

  Replace existing `skipExisting: options?.skipExisting` references in agent calls with `skipExisting`.

- [ ] **Step 4: Add stage-level skip log before each agent delegation**

  Before each of Stage 1 (FETCH), Stage 2 (PLAN), and Stage 4 (REVIEW) agent calls, insert a pre-check using the existing `checkArtifactExists` method that logs:

  ```
  ⏭  [Stage name] already complete — skipping (path/to/artifact)
  ```

  when `skipExisting` is true and the artifact already exists on disk.

- [ ] **Step 5: Run lint**

  ```bash
  yarn lint
  ```

  Expected: exits 0.

---

## Task 5 — Add manual tests

**Files:**
- Modify: `test/manual/test-issue-all-agents.ts`

- [ ] **Step 1: Add Part 7 — CommitterAgent no-op is a warning, not a throw**

  Add a test that monkey-patches `gitService.commit` to throw `new Error('No changes to commit')` and asserts the agent does not re-throw:

  ```typescript
  assert('CommitterAgent does not throw on empty-commit error', !threw);
  ```

- [ ] **Step 2: Add Part 8 — `--force` flag is parsed as a boolean**

  Assert that `IssueAllCommand` has a `parseForce` method and that it returns `true`.

- [ ] **Step 3: Add Part 9 — `--force --dry-run` exits 0**

  Spawn a `issue:all ... --force --dry-run` invocation and assert exit code 0.

---

## Task 6 — Build and run all tests

- [ ] **Step 1: Build**

  ```bash
  yarn build
  ```

  Expected: exits 0, zero TypeScript errors.

- [ ] **Step 2: Run the agents manual test suite**

  ```bash
  nr test:manual -- test-issue-all-agents
  ```

  Expected: all assertions in Parts 1-9 pass.

  Common failure modes:
  - Part 7 fails with "threw" being true → the try/catch in `committer.agent.ts` did not land correctly, or the error message string does not match `'No changes to commit'`.
  - Part 8 fails with parseForce not found → the `@Option` decorator and method were not added.
  - Part 9 fails with non-zero exit → the `--force` flag is not registered with nest-commander.

---

## Task 7 — End-to-end manual verification

Requires `ANTHROPIC_API_KEY`, `JIRA_API_TOKEN`, `BITBUCKET_APP_PASSWORD`, and the `service-tourv3` repo cloned as a sibling directory.

- [ ] **Step 1: Verify Bug 1 and Bug 2 are fixed (interactive mode)**

  ```bash
  yarn start issue:all TAD-575 --from fetch --to plan --interactive -a feature -r service-tourv3
  ```

  Expected: "💬 Interactive Chat Mode" appears **exactly once**. After typing `exit`, "✓ Resuming workflow..." appears **exactly once**.

- [ ] **Step 2: Verify Bug 3 is fixed (no staged changes)**

  Run from a clean working tree in `service-tourv3`:

  ```bash
  yarn start issue:all TAD-575 --from commit --to commit -a feature -r service-tourv3
  ```

  Expected: logs `⚠ Nothing to commit — skipping commit stage` and exits with code 0.

- [ ] **Step 3: Verify idempotency — artifacts already present, no `--force`**

  With ticket and plan artifacts already on disk:

  ```bash
  yarn start issue:all TAD-575 --from fetch --to plan -a feature -r service-tourv3
  ```

  Expected: both FETCH and PLAN stages print `⏭  [stage] already complete — skipping`.

- [ ] **Step 4: Verify `--force` bypasses idempotency**

  ```bash
  yarn start issue:all TAD-575 --from fetch --to plan --force -a feature -r service-tourv3
  ```

  Expected: FETCH re-fetches, PLAN regenerates. No skip messages.

---

## Acceptance Criteria

- `issue:all ... --interactive` prints "💬 Interactive Chat Mode" exactly once per interactive stage.
- `issue:all ... --interactive` prints "✓ Resuming workflow..." exactly once per interactive stage.
- `issue:all ... --from commit` exits with code 0 when there is nothing to commit; logs `⚠ Nothing to commit — skipping commit stage`.
- Re-running `issue:all TAD-XXX --from fetch` when the fetch artifact exists skips FETCH and logs `⏭  Fetch already complete — skipping`.
- Running with `--force` re-executes all stages regardless of existing artifacts.
- `yarn build` completes with zero TypeScript errors.
- `nr test:manual -- test-issue-all-agents` reports all tests passed.
