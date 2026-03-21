# wf CLI Enhancements Design

## Goal

Three targeted enhancements to the `wf` CLI tool:

1. **E2** — Move all artifact storage from `./<platform>/` to `.wf/<platform>/` to prevent gitignore clutter
2. **E4** — Add `--prompt` to `issue:plan` with an optional `[ticket-key]`, enabling plan generation without a platform ticket
3. **E5** — Add `--plan` to `issue:implement` with an optional `[ticket-key]`, enabling implementation guidance from an explicit plan file

Enhancement E1 (HTTP progress display) was dropped — ticket payloads are too small for meaningful progress tracking. Enhancement E3 (`--repos` for `issue:generate`) was already present.

---

## Architecture

All three enhancements are implemented in a single branch in dependency order:

1. **E2 first** — introduces `resolveArtifactDir()` helper; all subsequent code uses it
2. **E4 second** — adds `--prompt` mode to `issue:plan`; uses the new artifact dir helper
3. **E5 third** — adds `--plan` mode to `issue:implement`; uses the new artifact dir helper

Additionally, `ResolutionAction` is renamed from `'implement'` to `'feature'` throughout the codebase. This is a known breaking change to existing plan artifact filenames (e.g., `WBP-123-plan-implement.json` → `WBP-123-plan-feature.json`).

---

## E2: Artifact Directory Path Change

### Helper

Add to `src/agents/utils.ts`:

```typescript
import * as path from 'path';

export const resolveArtifactDir = (baseDir: string, platformName: string): string =>
  path.join(baseDir, '.wf', platformName);
```

### Call Sites

| File | Current | Updated |
|------|---------|---------|
| `src/agents/fetcher.agent.ts` — `execute()` | `path.join(baseDir, platformName)` | `resolveArtifactDir(baseDir, platformName)` |
| `src/agents/fetcher.agent.ts` — `loadFromDisk()` | `path.join(baseDir, platformName)` | `resolveArtifactDir(baseDir, platformName)` |
| `src/commands/issue-plan.command.ts` — `run()` | `path.join(process.cwd(), platformName)` | `resolveArtifactDir(process.cwd(), platformName)` |
| `src/commands/issue-implement.command.ts` — `run()` | `path.join(process.cwd(), platformName)` | `resolveArtifactDir(process.cwd(), platformName)` |
| `src/commands/issue-generate.command.ts` — `saveTicketLocally()` | `path.join(process.cwd(), platformName)` | `resolveArtifactDir(process.cwd(), platformName)` |
| `src/commands/issue-generate.command.ts` — dry-run preview | hardcoded `platformName` path | `resolveArtifactDir(process.cwd(), platformName)` |

`PlannerAgent` and `ReviewerAgent` derive their artifact paths via `ticket.path.replace(...)` so they inherit the new path automatically — no direct changes needed.

`IssueAllCommand` delegates all path construction to `FetcherAgent` via `AgentOrchestrator` — no direct changes needed there either.

---

## ResolutionAction Rename: `'implement'` → `'feature'`

| File | Change |
|------|--------|
| `src/agents/interfaces.ts` | Union type: `'implement'` → `'feature'` |
| `src/agents/planner.agent.ts` | `actions` array literal; plan filename suffix `-plan-implement` → `-plan-feature` |
| `src/agents/implementer.agent.ts` | `DEFAULT_PREFIX_MAPPING` key `implement` → `feature` (branch prefix `feature/` unchanged) |
| `src/commands/issue-plan.command.ts` | Local `ResolutionAction` type + `validActions` array |
| `src/commands/issue-implement.command.ts` | `const action = 'implement'` → `'feature'` |
| `src/commands/issue-all.command.ts` | All `'implement'` action string literals |
| `test/manual/test-issue-all-agents.ts` | `--action implement` → `--action feature` in dry-run invocation |

---

## E4: `--prompt` for `issue:plan`

### Interface Changes

```typescript
// IssuePlanOptions
interface IssuePlanOptions {
  action: ResolutionAction;   // now required (was optional)
  prompt?: string;            // new
  platform?: string;
  forceRecreate?: boolean;
  format?: OutputFormat;
  repos: string[];
  dryRun?: boolean;
}
```

### Command Changes

```
arguments: '[ticket-key]'    # was '<ticket-key>'
-a, --action <action>        # required: true (was optional)
--prompt <text>              # new
```

`--ticket-key` and `--prompt` are mutually exclusive — providing both is an error.

### Mnemonic Filename Generator

When no `<ticket-key>` is provided, the plan filename is:

```
{adjective}-{verb}-{noun}-{action}.json
```

Examples: `merry-tinkering-pine-feature.json`, `bold-jumping-wave-fix.json`

Implemented as three small static word arrays in the command file. No external dependency.

```typescript
const ADJECTIVES = ['bold', 'calm', 'dark', 'fast', 'hard', 'keen', 'late',
  'loud', 'merry', 'neat', 'pale', 'pure', 'rare', 'rich', 'safe', 'slim',
  'soft', 'tall', 'warm', 'wise'];
const VERBS = ['building', 'chasing', 'diving', 'driving', 'flying', 'forging',
  'jumping', 'lifting', 'moving', 'paving', 'rolling', 'running', 'shifting',
  'tinkering', 'tracing', 'turning', 'walking', 'weaving', 'wiring', 'writing'];
const NOUNS = ['axe', 'bridge', 'cloud', 'coast', 'creek', 'dune', 'flame',
  'forge', 'grove', 'hill', 'lake', 'lane', 'leaf', 'peak', 'pine', 'reef',
  'ridge', 'river', 'stone', 'wave'];
```

### Run Logic

```
if ticketKey provided AND --prompt provided
  → error: "--prompt cannot be used with <ticket-key>"

if ticketKey provided
  → existing behaviour (fetch or load from disk, then generate plan)
  → planPath = resolveArtifactDir(cwd, platform) / {ticketKey}-plan-{action}.json

if --prompt provided (no ticketKey)
  → skip fetch entirely
  → use --prompt text as ticketContent
  → generate mnemonic filename
  → planPath = resolveArtifactDir(cwd, platform) / {mnemonic}-{action}.json
  → generate plan via ClaudeService.generatePlan()
  → save plan to planPath

if neither ticketKey nor --prompt
  → error: "provide <ticket-key> or --prompt <text>"
```

---

## E5: `--plan` for `issue:implement`

### Interface Changes

```typescript
// IssueImplementOptions
interface IssueImplementOptions {
  plan?: string;              // new: explicit path to a plan JSON file
  platform?: string;
  forceRecreate?: boolean;
  format?: OutputFormat;
  repos: string[];
  dryRun?: boolean;
}
```

### Command Changes

```
arguments: '[ticket-key]'    # was '<ticket-key>'
--plan <path>                # new: explicit path to plan JSON file
```

### Run Logic

```
if neither ticketKey nor --plan
  → error: "provide <ticket-key> or --plan <path>"

if ticketKey provided AND --plan provided
  → use --plan path (overrides auto-discovery for that ticket)

if ticketKey provided (no --plan)
  → existing behaviour: auto-discover plan from
    resolveArtifactDir(cwd, platform)/{ticketKey}-plan-feature.json

if --plan provided (no ticketKey)
  → load plan from --plan path
  → skip branch name generation entirely
  → print implementation steps, files to modify, and repositories affected
  → no "Branch:" or "git checkout -b ..." block in output
  → status message: "Ready to implement — create your branch before starting"
```

### Output when no ticket key

```
🔧 Implementation Guide
──────────────────────────────────────────────────────────────────────
  Steps:
    1. <step from plan>
    2. ...

  Files to modify:
    - <file>

  Repositories affected:
    - <repo>

  Status:
    Ready to implement — create your branch before starting
```

---

## Error Handling

| Condition | Error message |
|-----------|---------------|
| `issue:plan`: both `<ticket-key>` and `--prompt` given | `"--prompt cannot be used together with <ticket-key>"` |
| `issue:plan`: neither `<ticket-key>` nor `--prompt` given | `"Provide a <ticket-key> or use --prompt <text> for a freeform plan"` |
| `issue:implement`: neither `<ticket-key>` nor `--plan` given | `"Provide a <ticket-key> or use --plan <path> to load a plan directly"` |
| `issue:implement`: `--plan` path does not exist | `"Plan file not found: <path>"` |
| `issue:plan`: `--action` not provided | nest-commander required-option error (no explicit guard needed) |

---

## Testing

Each enhancement gets a manual test entry added to the existing `test/manual/` pattern:

- `test/manual/test-enhancements.ts` — covers:
  - Artifact paths resolve to `.wf/<platform>/` (E2)
  - `wf issue:plan --prompt "..." --action feature --repos test-repo --dry-run` exits 0 and produces a mnemonic filename (E4)
  - `wf issue:implement --plan <path> --repos test-repo --dry-run` exits 0 and shows steps without a branch block (E5)
  - `wf issue:implement --plan <nonexistent> --repos test-repo` exits non-zero with "Plan file not found" (E5 error path)
  - `wf issue:plan --prompt "foo" WBP-0001 --action feature --repos test-repo` exits non-zero with mutual-exclusion error (E4 guard)
