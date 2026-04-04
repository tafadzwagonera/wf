# Issue Stage Services Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize reusable standalone `issue:*` stage logic in explicit workflow stage services so commands keep CLI concerns and agents keep orchestration concerns.

**Architecture:** Add `src/workflows/stages/*` services for fetch, plan, review, and commit shared logic. Standalone commands become thin adapters over those services, and the corresponding agents delegate to the same stage services for shared behavior without absorbing command-only options.

**Tech Stack:** NestJS, Jest, TypeScript, nest-commander

---

### Task 1: Add explicit stage-service module and fetch/plan service tests

**Files:**
- Create: `src/workflows/stages/workflow-stages.module.ts`
- Create: `src/workflows/stages/fetch-stage.service.ts`
- Create: `src/workflows/stages/fetch-stage.service.spec.ts`
- Create: `src/workflows/stages/plan-stage.service.ts`
- Create: `src/workflows/stages/plan-stage.service.spec.ts`

- [ ] Write failing service tests for fetch and plan shared behavior
- [ ] Run targeted tests and verify they fail for missing services
- [ ] Implement minimal services and module exports
- [ ] Re-run targeted tests and verify they pass

### Task 2: Rewire fetch/planner agents and standalone commands

**Files:**
- Modify: `src/agents/fetcher.agent.ts`
- Modify: `src/agents/planner.agent.ts`
- Modify: `src/commands/issue-fetch.command.ts`
- Modify: `src/commands/issue-plan.command.ts`
- Modify: `src/commands/issue-fetch.command.spec.ts`
- Modify: `src/commands/issue-plan.command.spec.ts`
- Modify: `src/agents/agents.module.ts`
- Modify: `src/commands/commands.module.ts`

- [ ] Add failing command/agent tests asserting commands and agents delegate through shared services
- [ ] Run targeted tests and verify they fail for current inline implementations
- [ ] Implement command and agent delegation while preserving CLI-only behavior
- [ ] Re-run targeted tests and verify they pass

### Task 3: Extract review shared core with service tests

**Files:**
- Create: `src/workflows/stages/review-stage.service.ts`
- Create: `src/workflows/stages/review-stage.service.spec.ts`
- Modify: `src/agents/reviewer.agent.ts`
- Modify: `src/commands/issue-review.command.ts`
- Modify: `src/commands/issue-review.command.spec.ts`

- [ ] Write failing tests for review core behavior used by both command and agent
- [ ] Run targeted tests and verify they fail
- [ ] Implement review stage service and delegate command/agent shared logic to it
- [ ] Re-run targeted tests and verify they pass

### Task 4: Extract commit shared core with service tests

**Files:**
- Create: `src/workflows/stages/commit-stage.service.ts`
- Create: `src/workflows/stages/commit-stage.service.spec.ts`
- Modify: `src/agents/committer.agent.ts`
- Modify: `src/commands/issue-commit.command.ts`
- Modify: `src/commands/issue-commit.command.spec.ts`

- [ ] Write failing tests for commit message and preflight shared behavior
- [ ] Run targeted tests and verify they fail
- [ ] Implement commit stage service and delegate command/agent shared logic to it
- [ ] Re-run targeted tests and verify they pass

### Task 5: Verify formatting and regression safety

**Files:**
- Modify: `src/workflows/stages/*.ts`
- Modify: `src/agents/*.ts`
- Modify: `src/commands/*.ts`

- [ ] Run targeted Jest suites for commands, agents, and new stage services
- [ ] Run `npm run format`
- [ ] Run `npm run lint`
- [ ] Fix any failures and re-run until clean
