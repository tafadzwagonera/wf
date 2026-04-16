# Consolidated Artifact Hashing And Resolution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate all filename hash generation and local artifact lookup logic into shared utilities so `issue:generate`, `issue:plan`, `issue:implement`, and other artifact-resolving code paths use the same rules.

**Architecture:** Add a shared artifact utility layer for hash generation, filename construction, reversible lookup through metadata, and fallback scans. Standardize plan filenames to `<hash>-<action>-plan.<ext>`, keep legacy lookup during migration, and delete legacy artifacts only after the hashed path is confirmed.

**Tech Stack:** NestJS, Jest, TypeScript, nest-commander

---

### Task 1: Add shared artifact utility tests

**Files:**
- Create or modify shared artifact utility tests under `src/shared/utils/`

- [ ] Write failing tests for plan hash generation, filename construction, manifest/index round-trip resolution, and legacy fallback scanning
- [ ] Run targeted tests and verify they fail for missing shared helpers
- [ ] Implement the minimal shared utility surface needed to pass those tests
- [ ] Re-run targeted tests and verify they pass

### Task 2: Rewire plan generation and lookup to the shared helpers

**Files:**
- Modify `src/commands/issue-plan.command.ts`
- Modify `src/workflows/stages/plan-stage.service.ts`
- Modify `src/commands/issue-implement.command.ts`
- Modify `src/commands/issue.command.ts`
- Modify relevant shared utility files under `src/shared/utils/`

- [ ] Add failing tests that assert hashed plan filenames and shared lookup behavior in standard and custom plan flows
- [ ] Run targeted tests and verify they fail for current hard-coded filename logic
- [ ] Implement shared filename creation, shared resolution, and action validation
- [ ] Re-run targeted tests and verify they pass

### Task 3: Migrate legacy artifacts and remove them after validation

**Files:**
- Modify migration and lookup helpers
- Modify any tests covering artifact migration and cleanup

- [ ] Add failing tests for migration confirmation, legacy fallback, and legacy deletion after successful hashed migration
- [ ] Run targeted tests and verify they fail for the current behavior
- [ ] Implement the migration/cleanup path with explicit success confirmation
- [ ] Re-run targeted tests and verify they pass

### Task 4: Verify formatting and regression safety

**Files:**
- Modify `src/shared/utils/*.ts`
- Modify `src/commands/*.ts`
- Modify `src/workflows/stages/*.ts`

- [ ] Run targeted Jest suites for shared utilities, commands, and stage services
- [ ] Run `npm run format`
- [ ] Run `npm run lint`
- [ ] Fix any failures and re-run until clean

### Notes

- The current shared generated-ticket hash helper already uses truncated `sha256`; keep the hash algorithm isolated in shared code so it can be swapped later without touching command logic.
- “Decodable” means resolvable through shared metadata, not mathematically reversible from the hash string alone.
- Plan artifact migration should preserve legacy lookup only until the hashed artifact has been written, validated, and verified.
