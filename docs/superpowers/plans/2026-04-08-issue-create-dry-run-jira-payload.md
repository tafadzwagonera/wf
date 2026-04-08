# Issue Create Dry-Run Jira Payload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `wf issue:create --dry-run` show the real Jira payload, including the transformed ADF description, without creating a live ticket.

**Architecture:** Reuse the create-path transformation by extracting a local Jira payload builder in `JiraService`, then have `IssueCreateCommand` call that builder during dry-run. Keep the change scoped to Jira dry-run preview behavior and cover it with command and service tests.

**Tech Stack:** NestJS, Jest, TypeScript, Jira ADF conversion

---

### Task 1: Add failing dry-run coverage

**Files:**
- Modify: `src/commands/issue-create.command.spec.ts`
- Test: `src/commands/issue-create.command.spec.ts`

- [ ] **Step 1: Write the failing test**

Add a dry-run assertion that the preview payload contains Jira `fields.description` with an ADF `codeBlock` and `bulletList` when the parsed markdown ticket includes a fenced code block and bullet list.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand src/commands/issue-create.command.spec.ts`
Expected: FAIL because dry-run currently only previews placeholder ticket metadata.

- [ ] **Step 3: Write minimal implementation**

Extract a Jira payload builder in `src/integrations/jira/jira.service.ts` and use it from `src/commands/issue-create.command.ts` during Jira dry-run to preview the actual request payload.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand src/commands/issue-create.command.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/issue-create.command.spec.ts src/commands/issue-create.command.ts src/integrations/jira/jira.service.ts
git commit -m "feat: preview jira payload in issue create dry runs"
```

### Task 2: Verify Jira payload builder behavior

**Files:**
- Modify: `src/integrations/jira/jira.service.spec.ts`
- Test: `src/integrations/jira/jira.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add a service test for the new Jira payload builder that expects fenced code blocks to become ADF `codeBlock` nodes and markdown list items to become `bulletList` nodes.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand src/integrations/jira/jira.service.spec.ts`
Expected: FAIL because no reusable payload builder exists yet.

- [ ] **Step 3: Write minimal implementation**

Return the same `fields` structure used by live ticket creation, without network-dependent priority resolution.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand src/integrations/jira/jira.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/integrations/jira/jira.service.spec.ts src/integrations/jira/jira.service.ts
git commit -m "test: cover jira create payload generation"
```

### Task 3: Verify the exact dry-run workflow and finalize

**Files:**
- Modify: `src/commands/issue-create.command.ts`
- Test: `src/commands/issue-create.command.spec.ts`

- [ ] **Step 1: Run focused regression tests**

Run: `npm test -- --runInBand src/commands/issue-create.command.spec.ts src/integrations/jira/jira.service.spec.ts src/commands/issue-generate.command.spec.ts`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 3: Run the manual dry-run verification using the generated artifact**

Run: `yarn start issue:create /Users/tafadzwagonera/.wf/service-bookingv3/jira/GENERATED-2026-04-08-22b06f64.md --ticket-project WBP --dry-run`
Expected: output includes Jira payload preview with `fields.description.content` containing `codeBlock` and `bulletList`.

- [ ] **Step 4: Stage intended files**

```bash
git add src/commands/issue-create.command.ts src/commands/issue-create.command.spec.ts src/integrations/jira/jira.service.ts src/integrations/jira/jira.service.spec.ts src/commands/issue-generate.command.ts src/commands/issue-generate.command.spec.ts docs/superpowers/plans/2026-04-08-issue-create-dry-run-jira-payload.md
```

- [ ] **Step 5: Commit with repository workflow**

Run: `yarn start issue:commit -c`
Expected: commit created with the staged changes only.
