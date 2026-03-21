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

Add to `src/agents/utils.ts` (also add `import * as path from 'path'` at the top if not already present):

```typescript
export const resolveArtifactDir = (baseDir: string, platformName: string): string =>
  path.join(baseDir, '.wf', platformName);
```

### Import Required in Every Command File

`resolveArtifactDir` must be imported in every command file that constructs an artifact directory:

```typescript
import { resolveArtifactDir } from '../agents/utils';
```

Files requiring this new import:
- `src/commands/issue-plan.command.ts`
- `src/commands/issue-implement.command.ts`
- `src/commands/issue-generate.command.ts`

`src/agents/fetcher.agent.ts` already imports from `./utils` — add `resolveArtifactDir` to that import.

### Call Sites

Every `path.join(..., platformName)` that constructs an artifact directory must be replaced with `resolveArtifactDir(...)`. The function signature of callers does not change — only the one internal `path.join` expression changes at each call site.

| File | Method | Current expression | Updated expression |
|------|--------|-------------------|-------------------|
| `src/agents/fetcher.agent.ts` | `execute()` | `path.join(options.baseDir ?? process.cwd(), options.platformName)` | `resolveArtifactDir(options.baseDir ?? process.cwd(), options.platformName)` |
| `src/agents/fetcher.agent.ts` | `loadFromDisk()` | `path.join(baseDir, platformName, ...)` | `resolveArtifactDir(baseDir, platformName)` then append `/${ticketKey}.md` |
| `src/commands/issue-plan.command.ts` | `run()` | `path.join(process.cwd(), platformName)` | `resolveArtifactDir(process.cwd(), platformName)` |
| `src/commands/issue-implement.command.ts` | `run()` | `path.join(process.cwd(), platformName)` (used for both `platformDir` and derived `planPath`) | `resolveArtifactDir(process.cwd(), platformName)` |
| `src/commands/issue-generate.command.ts` | `saveTicketLocally()` | `path.join(process.cwd(), platformName)` | `resolveArtifactDir(process.cwd(), platformName)` |
| `src/commands/issue-generate.command.ts` | `run()` dry-run block | `path.join(process.cwd(), platformName, ...)` in `filePath` construction | `resolveArtifactDir(process.cwd(), platformName)` |
| `src/commands/issue-all.command.ts` | `run()` dry-run block | `path.join(repoBaseDir, platformName)` (and all derived `ticketPath`/`planPath`/`reviewPath` in the dry-run preview) | `resolveArtifactDir(repoBaseDir, platformName)` |

**Note:** `PlannerAgent` and `ReviewerAgent` derive their artifact paths via `ticket.path.replace(...)`, so they inherit the new path automatically once `FetcherAgent` uses the updated helper. No direct changes needed in those agents.

**Note:** `IssueAllCommand`'s live (non-dry-run) code delegates path construction to `FetcherAgent` via `AgentOrchestrator`, so it inherits the fix automatically. Only the dry-run preview block constructs paths directly and must be updated.

---

## ResolutionAction Rename: `'implement'` → `'feature'`

This rename touches every file that contains the string literal `'implement'` as a `ResolutionAction` value. All occurrences are enumerated below by file and method to prevent any from being missed.

| File | Method / location | Change |
|------|------------------|--------|
| `src/agents/interfaces.ts` | Union type declaration | `'implement'` → `'feature'` in the union |
| `src/agents/planner.agent.ts` | `execute()` — `planPath` suffix | `-plan-implement` → `-plan-feature` |
| `src/agents/planner.agent.ts` | `discoverPlan()` — `actions` array (line ~122) | `'implement'` → `'feature'` |
| `src/agents/planner.agent.ts` | `discoverPlan()` — error message string | `<implement\|fix\|investigate>` → `<feature\|fix\|investigate>` |
| `src/agents/planner.agent.ts` | `loadFromDisk()` — error message string | same pattern update |
| `src/agents/implementer.agent.ts` | `DEFAULT_PREFIX_MAPPING` | key `implement` → `feature` (branch prefix `feature/` is unchanged) |
| `src/commands/issue-plan.command.ts` | local `ResolutionAction` type + `validActions` array | `'implement'` → `'feature'` |
| `src/commands/issue-implement.command.ts` | `run()` — `const action = 'implement'` | `'implement'` → `'feature'` |
| `src/commands/issue-all.command.ts` | `getStagesToRun()` or any `validActions` array | `'implement'` → `'feature'` |
| `src/commands/issue-all.command.ts` | `checkArtifactExists()` — local `actions` array | `'implement'` → `'feature'` |
| `src/commands/issue-all.command.ts` | dry-run preview block — any `'implement'` fallback literal | `'implement'` → `'feature'` |
| `src/commands/issue-all.command.ts` | `WorkflowStage` enum value `IMPLEMENT = 'implement'` | **DO NOT rename** — this is a stage identifier, not a `ResolutionAction` value |
| `test/manual/test-issue-all-agents.ts` | Part 4 — `loadFromDisk(..., 'implement')` direct call | `'implement'` → `'feature'` |
| `test/manual/test-issue-all-agents.ts` | Part 5 dry-run CLI invocation | `--action implement` → `--action feature` |

---

## E4: `--prompt` for `issue:plan`

### Interface Changes

```typescript
interface IssuePlanOptions {
  action: ResolutionAction;   // now required (was optional with default 'implement')
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
arguments: '[ticket-key]'       # was '<ticket-key>'
-a, --action <action>           # required: true (was optional)
--prompt <text>                 # new
```

### Mutual Exclusion

`<ticket-key>` and `--prompt` are mutually exclusive. `--force-recreate` is silently ignored when `--prompt` is supplied (there is no ticket to re-fetch).

### Platform in `--prompt` Mode

`--platform` remains optional in `--prompt` mode. The artifact is saved under `resolveArtifactDir(process.cwd(), platformName)` where `platformName` falls back to the config default (`'jira'`) if `--platform` is not supplied. This is the same behaviour as the existing ticket-key flow.

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

const generateMnemonic = (): string => {
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(ADJECTIVES)}-${pick(VERBS)}-${pick(NOUNS)}`;
};
```

### Run Logic

```
if ticketKey provided AND --prompt provided
  → error: "--prompt cannot be used together with <ticket-key>"

if ticketKey provided (no --prompt)
  → existing behaviour: fetch or load ticket from disk, then generate plan
  → planPath = resolveArtifactDir(cwd, platform) / {ticketKey}-plan-{action}.json
  → --force-recreate works as before

if --prompt provided (no ticketKey)
  → silently ignore --force-recreate (nothing to re-fetch)
  → use --prompt text directly as ticketContent (no fetch, no disk read)
  → planFilename = `${generateMnemonic()}-${action}.json`   ← caller appends action
  → planPath = path.join(resolveArtifactDir(cwd, platform), planFilename)
  → generate plan via ClaudeService.generatePlan(action, ticketContent, { summary: ticketContent.slice(0, 80) })
  → save plan to planPath

if neither ticketKey nor --prompt
  → error: "Provide a <ticket-key> or use --prompt <text> for a freeform plan"
```

### Dry-Run for `--prompt` Mode

In dry-run mode with `--prompt`:
- Skip the API fetch preview (no ticket to fetch).
- Show the Claude API call preview (plan generation).
- Show a file-write preview for `planPath` using the mnemonic filename pattern (use a fixed placeholder like `{mnemonic}-{action}.json` since the actual mnemonic is generated at runtime).

---

## E5: `--plan` for `issue:implement`

### Interface Changes

```typescript
interface IssueImplementOptions {
  plan?: string;              // new: user-supplied path to a plan JSON file
  platform?: string;
  forceRecreate?: boolean;
  format?: OutputFormat;
  repos?: string[];           // now optional when --plan is supplied without ticketKey
  dryRun?: boolean;
}
```

`--repos` is made optional at the decorator level (`required: false`) to support the keyless mode. When `<ticket-key>` is provided, an explicit guard in `run()` enforces repos where needed:

```
if ticketKey && platformName === 'bitbucket' && !options.repos?.length
  → error: "--repos is required for Bitbucket ticket fetching"
```

`repos` remains used (when present) to pass `affectedRepositories` into plan generation for both Jira and Bitbucket paths. This guard replaces the nest-commander `required: true` decorator and keeps the option available for keyless mode without crashing.

### Command Changes

```
arguments: '[ticket-key]'       # was '<ticket-key>'
--plan <path>                   # new: explicit path to plan JSON file
```

### `--plan` Path Resolution

`--plan` accepts a user-supplied path (absolute or relative). It is resolved via `path.resolve(options.plan)` relative to `process.cwd()`. `resolveArtifactDir` is **not** applied to `--plan` — the user controls where the file lives.

### Run Logic

```
if neither ticketKey nor --plan
  → error: "Provide a <ticket-key> or use --plan <path> to load a plan directly"

if ticketKey provided AND --plan provided
  → load plan from path.resolve(options.plan) instead of auto-discovering from disk
  → ticket is fetched or loaded from disk as usual (existing behaviour)
  → plan generation (generatePlan) is SKIPPED — plan is loaded from the file
  → display implementation guide (branch name + steps + files + repos)

if ticketKey provided (no --plan)
  → existing behaviour: fetch/load ticket, auto-discover plan, display guide

if --plan provided (no ticketKey)
  → load plan from path.resolve(options.plan)
  → skip ticket fetch entirely
  → skip branch name generation (user manages their own branch)
  → display steps, files to modify, repositories affected
  → status message: "Ready to implement — create your branch before starting"
  → --repos is not required in this mode
```

### Output When No Ticket Key

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

### Dry-Run for `--plan` Mode (No Ticket Key)

In dry-run mode with `--plan` and no `ticketKey`:
- Show a file-read preview for the plan path.
- Show the implementation guide output block (steps/files/repos) using placeholder text.
- No API call preview (no fetch, no generate).
- `showHeader('issue:implement', options.plan ?? '<plan-path>')`.

---

## Error Handling

| Condition | Error message |
|-----------|---------------|
| `issue:plan`: both `<ticket-key>` and `--prompt` given | `"--prompt cannot be used together with <ticket-key>"` |
| `issue:plan`: neither `<ticket-key>` nor `--prompt` given | `"Provide a <ticket-key> or use --prompt <text> for a freeform plan"` |
| `issue:plan`: `--action` not provided | nest-commander required-option error (enforced by `required: true` on `@Option`) |
| `issue:plan`: `--prompt` + `--force-recreate` | silently ignore `--force-recreate` (no fetch to redo) |
| `issue:implement`: neither `<ticket-key>` nor `--plan` given | `"Provide a <ticket-key> or use --plan <path> to load a plan directly"` |
| `issue:implement`: `--plan` path does not exist | `"Plan file not found: <path>"` |
| `issue:implement`: `--plan` file is not valid JSON | `"Plan file is not valid JSON: <path>"` |

---

## Testing

Each path is covered by a case in `test/manual/test-enhancements.ts`:

**E2 — Artifact path**
- `FetcherAgent.loadFromDisk()` throws with a `.wf/` path in the error message (confirms helper is applied)
- `wf issue:plan <key> --action feature --repos test-repo --dry-run` output mentions `.wf/` in file paths

**E4 — `issue:plan --prompt`**
- `wf issue:plan --prompt "add dark mode" --action feature --repos test-repo --dry-run` exits 0 and output contains a mnemonic-pattern filename (`*-feature.json`)
- `wf issue:plan WBP-0001 --prompt "add dark mode" --action feature --repos test-repo --dry-run` exits non-zero with mutual-exclusion error
- `wf issue:plan --prompt "add dark mode" --action feature --repos test-repo --force-recreate --dry-run` exits 0 (force-recreate silently ignored)
- `wf issue:plan --prompt "add dark mode" --repos test-repo --dry-run` exits non-zero (`--action` is required)

**E5 — `issue:implement --plan`**
- `wf issue:implement --plan /nonexistent/path.json --repos test-repo` exits non-zero with "Plan file not found"
- `wf issue:implement --plan <valid-plan-path> --dry-run` exits 0 and output does NOT contain "git checkout -b"
- `wf issue:implement --dry-run` (no ticket key, no plan) exits non-zero with the expected error message
- `wf issue:implement --plan <valid-plan-path> --repos test-repo --dry-run` exits 0 (no error even without ticket key — repos is optional in keyless mode)
