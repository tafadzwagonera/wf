# Design: `issue:implement` — Require Pre-existing Plan Artifact

**Date:** 2026-03-23
**Status:** Approved

---

## Background

`issue:implement` currently supports three modes:

| Mode | Invocation | Behaviour |
|------|-----------|-----------|
| A | `--plan plan.json` (no ticket key) | Load plan from provided path, run implementer |
| B | `<ticketKey> --plan plan.json -r repo` | Load ticket from disk, load plan from provided path, run implementer |
| C | `<ticketKey> -r repo` (no `--plan`) | Auto-fetch ticket if missing, generate plan via AI, run implementer |

Mode C also supports `--force-recreate` to bypass the local ticket artifact cache.

The auto-fetch + AI-plan-generation path in Mode C couples too many responsibilities into a single command, and `--force-recreate` is a footgun. The intended workflow is:

```
issue:fetch → issue:plan → issue:implement
```

Each command should own one stage.

---

## Goal

- Remove `--force-recreate` from `issue:implement`.
- Change Mode C so it **requires** both the ticket artifact and the plan artifact to pre-exist on disk. If either is missing, the command fails with a targeted, actionable error message.
- Remove all auto-fetch and AI plan-generation logic from Mode C.

---

## Modes After This Change

| Mode | Invocation | Behaviour |
|------|-----------|-----------|
| A | `--plan plan.json` (no ticket key) | **Unchanged** |
| B | `<ticketKey> --plan plan.json -r repo` | **Unchanged** |
| C | `<ticketKey> -r repo` (no `--plan`) | **Changed**: preflight-check both artifacts; fail fast with targeted errors if either is missing; load and execute plan from disk |

---

## Mode C: Preflight Checks (sequential)

`--platform` (or the configured primary platform) continues to drive `resolveArtifactDir` to locate the artifact directory on disk. No change to the `--platform` option or its parsing is required.

### Check 1 — Ticket artifact

```
ticketPath = <artifactDir>/<ticketKey>.md
```

If `ticketPath` does not exist, call `process.exit(1)` (consistent with existing guards) after printing:

```
Error: Ticket artifact not found: <ticketPath>
Run:   wf issue:fetch <ticketKey> [--repos <repos>]
```

### Check 2 — Plan artifact

Use the existing `discoverPlanAction(platformDir, ticketKey)` helper, which picks the most recently modified file across `['investigate', 'feature', 'fix']`. **Note:** `discoverPlanAction` always returns a struct — it never returns `null` or signals absence. Internally it filters candidates with `fs.existsSync`; when no candidate exists the filter produces an empty array and the helper returns a synthesised fallback (`<ticketKey>-plan-feature.json`) without verifying that file's existence. The caller's own `fs.existsSync` check is therefore the only existence gate:

```ts
const discovered = discoverPlanAction(platformDir, ticketKey);
const planExists = fs.existsSync(discovered.filePath);
```

If `planExists` is `false`, call `process.exit(1)` after printing:

```
Error: No plan artifact found for <ticketKey>.
Run:   wf issue:plan <ticketKey> --action <feature|fix|investigate> [--repos <repos>]
Then:  wf issue:implement <ticketKey> [--repos <repos>]
```

### Happy path

Both artifacts exist:
1. Read ticket content from disk:
   ```ts
   const ticketContent = await fs.promises.readFile(ticketPath, 'utf-8');
   const ticketArtifact: TicketArtifact = { ticketKey, content: ticketContent, path: ticketPath };
   ```
2. Load plan JSON from `discovered.filePath` via `loadPlanFile` → construct `PlanArtifact`:
   ```ts
   const plan = loadPlanFile(discovered.filePath) as ResolutionPlan;
   const planArtifact: PlanArtifact = {
     plan,
     // `action` is not declared on ResolutionPlan; the `as any` cast is intentional
     // and mirrors the same defensive pattern already used in Mode B.
     action: ((plan as any).action ?? discovered.action) as ResolutionAction,
     path: discovered.filePath,
   };
   ```
3. Pass both to `orchestrator.implementer.execute`. No AI call for plan generation.

For `investigate` plans, findings generation is handled inside `ImplementerAgent.executeInvestigation` — no special casing is required in `IssueImplementCommand`.

---

## Dry-Run Changes (Mode C)

The same preflight checks apply during `--dry-run`. If either artifact is missing, the command prints the same error message and calls `process.exit(1)` — it does not render a partial preview.

When both artifacts exist, the dry-run no longer previews an AI plan-generation API call. Instead it previews:

1. File-read: ticket artifact
2. File-read: discovered plan artifact
3. Implementation summary (same format as current Mode B dry-run)

**Replacement `showSummary` counts for Mode C:**

| Scenario | `apiCallCount` | `fileCreatedCount` |
|----------|---------------|-------------------|
| `feature` or `fix` plan | `0` | `0` |
| `investigate` plan | `1` (findings generation) | `1` (findings file) |

---

## Removals

| Item | Location |
|------|----------|
| `parseForceRecreate()` option method | `IssueImplementCommand` |
| `forceRecreate` field | `IssueImplementOptions` |
| `options?.forceRecreate` reference (currently feeds `needsFetch`) | `run()` — Mode B/C path |
| `needsFetch` variable, the live fetch block (lines ~578–609), the `options?.forceRecreate` branch inside that block, and the dry-run fetch-preview `if (needsFetch)` block and its `else` branch previewing AI plan-generation (lines ~416–497) | `run()` — Mode B/C path |
| `--force-recreate` mention and the "If a local artifact is not found, the command will attempt to fetch it from the primary platform" sentence in `@Command` description | `@Command` decorator |

**Replacement `@Command` description:**
```
'Carry out an implementation plan for a ticket. ' +
'Requires a local ticket artifact (<ticketKey>.md) and a plan artifact ' +
'(<ticketKey>-plan-<action>.json). ' +
'Run issue:fetch then issue:plan before calling this command.'
```

---

## Non-Goals

- No changes to Mode A or Mode B.
- No changes to `discoverPlanAction` or `loadPlanFile`.
- No changes to `issue:fetch`, `issue:plan`, or any other command.
- No changes to the `--platform` option.
- Mode B does not get preflight checks (it is an explicit/advanced invocation; a missing ticket surfaces as a file-not-found error, which is acceptable).
