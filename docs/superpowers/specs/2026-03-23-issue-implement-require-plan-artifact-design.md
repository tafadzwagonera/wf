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

### Check 1 — Ticket artifact

```
ticketPath = <artifactDir>/<ticketKey>.md
```

If `ticketPath` does not exist:

```
Error: Ticket artifact not found: <ticketPath>
Run:   wf issue:fetch <ticketKey> [--repos <repos>]
```

Exit code 1.

### Check 2 — Plan artifact

Discovered via the existing `discoverPlanAction` helper, which picks the most recently modified file across `['investigate', 'feature', 'fix']`:

```
planPath = <artifactDir>/<ticketKey>-plan-<action>.json
```

If no matching plan file exists:

```
Error: No plan artifact found for <ticketKey>.
Run:   wf issue:plan <ticketKey> --action <feature|fix|investigate> [--repos <repos>]
Then:  wf issue:implement <ticketKey> [--repos <repos>]
```

Exit code 1.

### Happy path

Both artifacts exist → load plan from disk → pass to `orchestrator.implementer.execute`. No AI call for plan generation.

---

## Dry-Run Changes (Mode C)

The dry-run no longer previews an AI plan-generation API call. Instead it previews:

1. File-read: ticket artifact
2. File-read: discovered plan artifact
3. Implementation summary (same format as current Mode B dry-run)

---

## Removals

| Item | Location |
|------|----------|
| `parseForceRecreate()` option method | `IssueImplementCommand` |
| `forceRecreate` field | `IssueImplementOptions` |
| `needsFetch` variable and fetch block | `run()` — Mode B/C path |
| `--force-recreate` mention in `@Command` description | `@Command` decorator |

---

## Non-Goals

- No changes to Mode A or Mode B.
- No changes to `discoverPlanAction` or `loadPlanFile`.
- No changes to `issue:fetch`, `issue:plan`, or any other command.
- Mode B does not get preflight checks (it is an explicit/advanced invocation; a missing ticket surfaces as a file-not-found error, which is acceptable).
