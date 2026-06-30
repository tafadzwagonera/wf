# wf CLI Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move artifact storage to `.wf/<platform>/`, rename `ResolutionAction` `'implement'` → `'feature'`, add `--prompt` to `issue:plan`, and add `--plan` to `issue:implement`.

**Architecture:** Three enhancements land in dependency order on a single branch: E2 (new `resolveArtifactDir` helper + all call sites) first, `ResolutionAction` rename second (touches agents and commands independently), E4/E5 last (each a self-contained command extension). Tasks 1–4 are pure refactors with zero user-visible behaviour change; Tasks 5–6 add the new flags.

**Tech Stack:** NestJS, TypeScript, nest-commander, chalk, `fs`, `path`, `ClaudeService`

**Spec:** `docs/superpowers/specs/2026-03-22-wf-cli-enhancements-design.md`

---

## File Map

| Action | Path | Reason |
|--------|------|--------|
| Modify | `src/agents/utils.ts` | Add `resolveArtifactDir` helper + `path` import |
| Modify | `src/agents/fetcher.agent.ts` | Use `resolveArtifactDir` in `execute()` and `loadFromDisk()` |
| Modify | `src/agents/interfaces.ts` | Rename `'implement'` → `'feature'` in `ResolutionAction` |
| Modify | `src/agents/planner.agent.ts` | Update `planPath` suffix and `discoverPlan()` actions array + error messages |
| Modify | `src/agents/implementer.agent.ts` | Update `DEFAULT_PREFIX_MAPPING` key |
| Modify | `src/commands/issue-plan.command.ts` | E2 path + rename + E4 `--prompt` logic |
| Modify | `src/commands/issue-implement.command.ts` | E2 path + rename + E5 `--plan` logic |
| Modify | `src/commands/issue-generate.command.ts` | E2 path only |
| Modify | `src/commands/issue-all.command.ts` | E2 dry-run path + rename in validActions/error messages |
| Modify | `test/manual/test-issue-all-agents.ts` | Update `'implement'` references (Part 4 + Part 5) |
| Create | `test/manual/test-enhancements.ts` | Manual tests for E2/E4/E5 |

---

## Task 1: Add `resolveArtifactDir` helper and update `FetcherAgent`

**Files:**
- Modify: `src/agents/utils.ts`
- Modify: `src/agents/fetcher.agent.ts`

- [ ] **Step 1: Add `resolveArtifactDir` to `src/agents/utils.ts`**

`utils.ts` does not yet import `path`. Add the import and the new export at the top of the file (before the existing exports):

```typescript
// src/agents/utils.ts
import * as path from 'path';

export const resolveArtifactDir = (baseDir: string, platformName: string): string =>
  path.join(baseDir, '.wf', platformName);

// ... existing extractSummary and slugify exports unchanged
```

- [ ] **Step 2: Update `FetcherAgent.execute()` to use `resolveArtifactDir`**

In `src/agents/fetcher.agent.ts`, the existing import line is:
```typescript
import { TicketArtifact, FetcherOptions } from './interfaces';
```

Change it to also import `resolveArtifactDir`:
```typescript
import { TicketArtifact, FetcherOptions } from './interfaces';
import { resolveArtifactDir } from './utils';
```

Then in `execute()` (lines 29–32), replace:
```typescript
const platformDir = path.join(
  options.baseDir ?? process.cwd(),
  options.platformName,
);
```
with:
```typescript
const platformDir = resolveArtifactDir(
  options.baseDir ?? process.cwd(),
  options.platformName,
);
```

- [ ] **Step 3: Update `FetcherAgent.loadFromDisk()` to use `resolveArtifactDir`**

In `loadFromDisk()` (line 85), replace:
```typescript
const ticketPath = path.join(baseDir, platformName, `${ticketKey}.md`);
```
with:
```typescript
const ticketPath = path.join(resolveArtifactDir(baseDir, platformName), `${ticketKey}.md`);
```

- [ ] **Step 4: Run lint on changed files**

```bash
npx eslint src/agents/utils.ts src/agents/fetcher.agent.ts --fix
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/utils.ts src/agents/fetcher.agent.ts
git commit -m "feat(e2): add resolveArtifactDir helper and update FetcherAgent to use .wf/ path"
```

---

## Task 2: Update E2 call sites in command files

**Files:**
- Modify: `src/commands/issue-plan.command.ts`
- Modify: `src/commands/issue-implement.command.ts`
- Modify: `src/commands/issue-generate.command.ts`
- Modify: `src/commands/issue-all.command.ts`

- [ ] **Step 1: Update `issue-plan.command.ts`**

Add `resolveArtifactDir` to the imports block at the top (no `../agents/utils` import exists yet — add a new line):
```typescript
import { resolveArtifactDir } from '../agents/utils';
```

In `run()` (line 135), replace:
```typescript
const platformDir = path.join(process.cwd(), platformName);
```
with:
```typescript
const platformDir = resolveArtifactDir(process.cwd(), platformName);
```

- [ ] **Step 2: Update `issue-implement.command.ts`**

Add import (same pattern — new line at top):
```typescript
import { resolveArtifactDir } from '../agents/utils';
```

In `run()` (line 113), replace:
```typescript
const platformDir = path.join(process.cwd(), platformName);
```
with:
```typescript
const platformDir = resolveArtifactDir(process.cwd(), platformName);
```

`planPath` is derived from `platformDir` and needs no separate change.

- [ ] **Step 3: Update `issue-generate.command.ts`**

Add import:
```typescript
import { resolveArtifactDir } from '../agents/utils';
```

In `saveTicketLocally()` (line 493), replace:
```typescript
const platformDir = path.join(process.cwd(), platformName);
```
with:
```typescript
const platformDir = resolveArtifactDir(process.cwd(), platformName);
```

In the dry-run block (line 145), replace:
```typescript
const filePath = path.join(
  process.cwd(),
  platformName,
  `GENERATED-${timestamp}-preview.${format}`,
);
```
with:
```typescript
const filePath = path.join(
  resolveArtifactDir(process.cwd(), platformName),
  `GENERATED-${timestamp}-preview.${format}`,
);
```

- [ ] **Step 4: Update `issue-all.command.ts`**

Add `resolveArtifactDir` to the existing `../agents/interfaces` import block or as a separate import:
```typescript
import { resolveArtifactDir } from '../agents/utils';
```

In the dry-run block (line 241), replace:
```typescript
const platformDir = path.join(repoBaseDir, platformName);
```
with:
```typescript
const platformDir = resolveArtifactDir(repoBaseDir, platformName);
```

In `checkArtifactExists()` (line 565), replace:
```typescript
const platformDir = path.join(baseDir, platformName);
```
with:
```typescript
const platformDir = resolveArtifactDir(baseDir, platformName);
```

- [ ] **Step 5: Run lint**

```bash
npx eslint src/commands/issue-plan.command.ts src/commands/issue-implement.command.ts src/commands/issue-generate.command.ts src/commands/issue-all.command.ts --fix
```

Expected: no errors.

- [ ] **Step 6: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/commands/issue-plan.command.ts src/commands/issue-implement.command.ts src/commands/issue-generate.command.ts src/commands/issue-all.command.ts
git commit -m "feat(e2): update all command call sites to use .wf/<platform>/ artifact path"
```

---

## Task 3: Rename `ResolutionAction` `'implement'` → `'feature'` in agents layer

**Files:**
- Modify: `src/agents/interfaces.ts`
- Modify: `src/agents/planner.agent.ts`
- Modify: `src/agents/implementer.agent.ts`

**IMPORTANT:** `WorkflowStage.IMPLEMENT = 'implement'` in `issue-all.command.ts` is a stage identifier — do **not** rename it. Only `ResolutionAction` values are being renamed.

- [ ] **Step 1: Update `interfaces.ts`**

Change line 4:
```typescript
// Before
export type ResolutionAction = 'implement' | 'fix' | 'investigate';

// After
export type ResolutionAction = 'feature' | 'fix' | 'investigate';
```

- [ ] **Step 2: Update `planner.agent.ts` — three locations**

**Location 1** — `execute()` plan filename suffix (line 33):
```typescript
// Before
const planPath = ticket.path.replace('.md', `-plan-${options.action}.json`);

// After — no change needed: the path uses `options.action` which is now 'feature'
// The filename will naturally become WBP-123-plan-feature.json
```
*(This line needs no source edit — it already uses the variable. Confirm by running:)*
```bash
grep -n 'plan-implement' src/agents/planner.agent.ts
```
*(Expected: no output. If any matches appear, replace the hardcoded string with `options.action`.)*

**Location 2** — `discoverPlan()` actions array (line 122):
```typescript
// Before
const actions: ResolutionAction[] = ['implement', 'fix', 'investigate'];

// After
const actions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
```

**Location 3** — `discoverPlan()` error message (line 139):
```typescript
// Before
'No plan file found for ticket.\nRun with --from plan --action <implement|fix|investigate> first.',

// After
'No plan file found for ticket.\nRun with --from plan --action <feature|fix|investigate> first.',
```

**Location 4** — `loadFromDisk()` error message (line ~93):
```typescript
// Before
`Plan file not found: ${path.basename(planPath)}\nRun with --from plan --action ${action} first.`

// After — no change needed: already uses the `action` variable, not a hardcoded string
```
*(Confirm by running:)*
```bash
grep -n 'implement|fix|investigate' src/agents/planner.agent.ts
```
*(If any match appears in `loadFromDisk()` — i.e., a hardcoded list — update it to `<feature|fix|investigate>`. Line 139's `discoverPlan()` error is handled in Location 3 above.)*

- [ ] **Step 3: Update `implementer.agent.ts` — `DEFAULT_PREFIX_MAPPING`**

Lines 14–18:
```typescript
// Before
const DEFAULT_PREFIX_MAPPING: Record<ResolutionAction, string> = {
  implement: 'feature',
  fix: 'bugfix',
  investigate: 'chore',
};

// After
const DEFAULT_PREFIX_MAPPING: Record<ResolutionAction, string> = {
  feature: 'feature',
  fix: 'bugfix',
  investigate: 'chore',
};
```

- [ ] **Step 4: Run lint and type-check**

```bash
npx eslint src/agents/interfaces.ts src/agents/planner.agent.ts src/agents/implementer.agent.ts --fix
npx tsc --noEmit
```

Expected: no errors. If the type system flags `'implement'` anywhere in the agents layer, fix those occurrences now.

- [ ] **Step 5: Commit**

```bash
git add src/agents/interfaces.ts src/agents/planner.agent.ts src/agents/implementer.agent.ts
git commit -m "feat(rename): rename ResolutionAction 'implement' → 'feature' in agents layer"
```

---

## Task 4: Rename `'implement'` → `'feature'` in commands layer and test file

**Files:**
- Modify: `src/commands/issue-plan.command.ts`
- Modify: `src/commands/issue-implement.command.ts`
- Modify: `src/commands/issue-all.command.ts`
- Modify: `test/manual/test-issue-all-agents.ts`

- [ ] **Step 1: Update `issue-plan.command.ts`**

Local type declaration (line 14):
```typescript
// Before
type ResolutionAction = 'implement' | 'fix' | 'investigate';

// After
type ResolutionAction = 'feature' | 'fix' | 'investigate';
```

`validActions` array in `parseAction()` (line 51–55):
```typescript
// Before
const validActions: ResolutionAction[] = ['implement', 'fix', 'investigate'];

// After
const validActions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
```

Default fallback (line 129):
```typescript
// Before
const action = options?.action || 'implement';

// After — action is now required, so this line will be removed in Task 5
// For now, change the fallback to silence type errors:
const action = options?.action || 'feature';
```

- [ ] **Step 2: Update `issue-implement.command.ts`**

Line 110:
```typescript
// Before
const action = 'implement';

// After
const action = 'feature';
```

- [ ] **Step 3: Update `issue-all.command.ts` — four locations**

**Location 1 & 2** — both `validActions` arrays (lines 209–213 and 222–226):
```typescript
// Before
const validActions: ResolutionAction[] = ['implement', 'fix', 'investigate'];

// After (both occurrences)
const validActions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
```

**Location 3** — error message (line 204–206):
```typescript
// Before
'Error: --action is required when running PLAN stage.\n' +
  'Specify: --action <implement|fix|investigate>',

// After
'Error: --action is required when running PLAN stage.\n' +
  'Specify: --action <feature|fix|investigate>',
```

**Location 4** — three dry-run preview block fallback literals (lines 287, 297, 300, 314):
```typescript
// Before (lines 287, 300, 314 — each instance)
`${ticketKey}-plan-implement.json`
`Generate ${action || 'implement'} plan`
`"action": "${action || 'implement'}",`

// After
`${ticketKey}-plan-feature.json`
`Generate ${action || 'feature'} plan`
`"action": "${action || 'feature'}",`
```

**Location 5** — `checkArtifactExists()` actions array (lines 576–580):
```typescript
// Before
const actions: ResolutionAction[] = ['implement', 'fix', 'investigate'];

// After
const actions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
```

- [ ] **Step 4: Update `test/manual/test-issue-all-agents.ts`**

**Part 4** (line ~116) — `loadFromDisk` direct call:
```typescript
// Before
orchestrator.planner.loadFromDisk('/nonexistent/FAKE-9999.md', 'implement');

// After
orchestrator.planner.loadFromDisk('/nonexistent/FAKE-9999.md', 'feature');
```

**Part 5** (line ~136) — CLI dry-run invocation:
```typescript
// Before
`...issue:all ${ticketKey} --from fetch --to commit --action implement --repos test-repo --dry-run`

// After
`...issue:all ${ticketKey} --from fetch --to commit --action feature --repos test-repo --dry-run`
```

- [ ] **Step 5: Run lint and type-check**

```bash
npx eslint src/commands/issue-plan.command.ts src/commands/issue-implement.command.ts src/commands/issue-all.command.ts test/manual/test-issue-all-agents.ts --fix
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run existing manual test to confirm no regressions**

```bash
nr test:manual -- test-issue-all-agents
```

Expected: All 22 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/commands/issue-plan.command.ts src/commands/issue-implement.command.ts src/commands/issue-all.command.ts test/manual/test-issue-all-agents.ts
git commit -m "feat(rename): rename ResolutionAction 'implement' → 'feature' in commands layer and tests"
```

---

## Task 5: E4 — Add `--prompt` to `issue:plan`

**Files:**
- Modify: `src/commands/issue-plan.command.ts`

- [ ] **Step 1: Write the failing manual test cases for E4**

Create `test/manual/test-enhancements.ts` with just the E4 test cases (E2 and E5 cases will be added in later tasks):

```typescript
// test/manual/test-enhancements.ts
import chalk from 'chalk';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean) => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}`));
    failed++;
  }
};

const run = (cmd: string): { output: string; exitCode: number } => {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30_000,
    });
    return { output, exitCode: 0 };
  } catch (err: unknown) {
    const spawnErr = err as { stdout?: string; stderr?: string; status?: number };
    return {
      output: (spawnErr.stdout ?? '') + (spawnErr.stderr ?? ''),
      exitCode: spawnErr.status ?? 1,
    };
  }
};

const CLI = 'npx ts-node -r tsconfig-paths/register src/main.ts';

async function main() {
  // ── E2: Artifact path ──────────────────────────────────────────────────
  console.log(chalk.bold.cyan('\n🧪 E2: Artifact Path (.wf/)'));
  console.log(chalk.gray('─'.repeat(60)));

  const { output: planDryRun } = run(
    `${CLI} issue:plan WBP-0001 --action feature --repos test-repo --dry-run`,
  );
  assert('issue:plan dry-run output mentions .wf/ path', planDryRun.includes('.wf/'));

  // ── E4: --prompt for issue:plan ────────────────────────────────────────
  console.log(chalk.bold.cyan('\n🧪 E4: issue:plan --prompt'));
  console.log(chalk.gray('─'.repeat(60)));

  // Happy path: --prompt dry-run exits 0 and output contains a mnemonic filename
  const { output: promptOut, exitCode: promptCode } = run(
    `${CLI} issue:plan --prompt "add dark mode toggle" --action feature --repos test-repo --dry-run`,
  );
  assert('--prompt dry-run exits 0', promptCode === 0);
  assert(
    '--prompt dry-run output contains mnemonic-feature.json pattern',
    /[a-z]+-[a-z]+-[a-z]+-feature\.json/.test(promptOut),
  );

  // Mutual exclusion: ticket-key + --prompt → non-zero exit
  const { exitCode: mutualCode, output: mutualOut } = run(
    `${CLI} issue:plan WBP-0001 --prompt "foo" --action feature --repos test-repo --dry-run`,
  );
  assert('ticket-key + --prompt exits non-zero', mutualCode !== 0);
  assert(
    'mutual-exclusion error message mentions --prompt',
    mutualOut.includes('--prompt'),
  );

  // force-recreate is silently ignored with --prompt
  const { exitCode: forceCode } = run(
    `${CLI} issue:plan --prompt "add dark mode" --action feature --repos test-repo --force-recreate --dry-run`,
  );
  assert('--prompt + --force-recreate exits 0 (force-recreate silently ignored)', forceCode === 0);

  // Missing --action → non-zero
  const { exitCode: noActionCode } = run(
    `${CLI} issue:plan --prompt "add dark mode" --repos test-repo --dry-run`,
  );
  assert('--prompt without --action exits non-zero', noActionCode !== 0);

  // ── E5: --plan for issue:implement ────────────────────────────────────
  console.log(chalk.bold.cyan('\n🧪 E5: issue:implement --plan'));
  console.log(chalk.gray('─'.repeat(60)));

  // Non-existent plan → "Plan file not found"
  const { exitCode: missingPlanCode, output: missingPlanOut } = run(
    `${CLI} issue:implement --plan /nonexistent/path.json`,
  );
  assert('--plan /nonexistent exits non-zero', missingPlanCode !== 0);
  assert('error mentions "Plan file not found"', missingPlanOut.includes('Plan file not found'));

  // No ticketKey, no --plan → non-zero
  const { exitCode: noArgsCode } = run(`${CLI} issue:implement --dry-run`);
  assert('no args exits non-zero', noArgsCode !== 0);

  // --plan keyless dry-run: exits 0, no "git checkout -b"
  // Create a minimal valid plan JSON for the test
  const tmpPlan = path.join(process.cwd(), '.wf', 'jira', 'test-plan-feature.json');
  fs.mkdirSync(path.dirname(tmpPlan), { recursive: true });
  fs.writeFileSync(
    tmpPlan,
    JSON.stringify({
      action: 'feature',
      summary: 'Test plan',
      estimatedComplexity: 'low',
      steps: ['Step one', 'Step two'],
      filesAffected: ['src/foo.ts'],
      affectedRepositories: ['test-repo'],
    }),
  );

  const { exitCode: planKeylessCode, output: planKeylessOut } = run(
    `${CLI} issue:implement --plan ${tmpPlan} --dry-run`,
  );
  assert('--plan keyless dry-run exits 0', planKeylessCode === 0);
  assert(
    '--plan keyless output does NOT contain "git checkout -b"',
    !planKeylessOut.includes('git checkout -b'),
  );

  // --plan keyless without --repos exits 0 (repos is optional in keyless mode)
  const { exitCode: noReposCode } = run(
    `${CLI} issue:implement --plan ${tmpPlan} --dry-run`,
  );
  assert('--plan without --repos exits 0 (repos optional in keyless mode)', noReposCode === 0);

  // Cleanup
  try { fs.unlinkSync(tmpPlan); } catch { /* ignore */ }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(chalk.gray('\n' + '─'.repeat(60)));
  if (failed === 0) {
    console.log(chalk.bold.green(`\n✅ All ${passed} tests passed\n`));
  } else {
    console.log(chalk.bold.red(`\n✗ ${failed} of ${passed + failed} tests failed\n`));
    process.exit(1);
  }
}

void main();
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
nr test:manual -- test-enhancements
```

Expected: several test failures (E4 and E5 features not yet implemented). Specifically:
- `--prompt dry-run exits 0` should FAIL (option not yet declared)
- `--plan keyless dry-run exits 0` should FAIL (option not yet declared)

- [ ] **Step 3: Implement `--prompt` in `issue-plan.command.ts`**

**3a. Update `IssuePlanOptions` interface** (lines 17–24):

```typescript
interface IssuePlanOptions {
  action: ResolutionAction;   // now required
  prompt?: string;            // new
  platform?: string;
  forceRecreate?: boolean;
  format?: OutputFormat;
  repos?: string[];           // now optional
  dryRun?: boolean;
}
```

**3b. Change `arguments`** in `@Command` decorator (line 33):
```typescript
// Before
arguments: '<ticket-key>',

// After
arguments: '[ticket-key]',
```

**3c. Add mnemonic word arrays** (add before the `@Injectable()` decorator, after the imports):

```typescript
const ADJECTIVES = [
  'bold', 'calm', 'dark', 'fast', 'hard', 'keen', 'late', 'loud', 'merry',
  'neat', 'pale', 'pure', 'rare', 'rich', 'safe', 'slim', 'soft', 'tall',
  'warm', 'wise',
];
const VERBS = [
  'building', 'chasing', 'diving', 'driving', 'flying', 'forging', 'jumping',
  'lifting', 'moving', 'paving', 'rolling', 'running', 'shifting', 'tinkering',
  'tracing', 'turning', 'walking', 'weaving', 'wiring', 'writing',
];
const NOUNS = [
  'axe', 'bridge', 'cloud', 'coast', 'creek', 'dune', 'flame', 'forge',
  'grove', 'hill', 'lake', 'lane', 'leaf', 'peak', 'pine', 'reef', 'ridge',
  'river', 'stone', 'wave',
];

const generateMnemonic = (): string => {
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(ADJECTIVES)}-${pick(VERBS)}-${pick(NOUNS)}`;
};
```

**3d. Add `parsePrompt` option method** (after the `parseDryRun` method):

```typescript
@Option({
  flags: '--prompt <text>',
  description: 'Freeform prompt text to use as ticket content (mutually exclusive with <ticket-key>)',
})
parsePrompt(val: string): string {
  return val;
}
```

**3e. Change `--action` to `required: true`** (lines 46–62):

```typescript
@Option({
  flags: '-a, --action <action>',
  description: 'Resolution action (feature|fix|investigate)',
  required: true,
})
parseAction(action: string): ResolutionAction {
  const validActions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
  if (!validActions.includes(action as ResolutionAction)) {
    throw new Error(
      `Invalid action: ${action}. Valid actions: ${validActions.join(', ')}`,
    );
  }
  return action as ResolutionAction;
}
```

**3f. Change `--repos` to `required: false`** (lines 100–111):

```typescript
@Option({
  flags: '-r, --repos <repos>',
  description:
    'Comma-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
  required: false,
})
parseRepos(val: string): string[] {
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
```

**3g. Update `run()` method signature and add dispatch logic**

Change the signature to accept optional `ticketKey`:

```typescript
async run([ticketKey]: [string | undefined], options?: IssuePlanOptions): Promise<void> {
```

Replace the body of `run()` with the following (keeping only the `try/catch` wrapper and all existing logic, adding new guards at the top):

```typescript
async run([ticketKey]: [string | undefined], options?: IssuePlanOptions): Promise<void> {
  try {
    // Mutual exclusion guard
    if (ticketKey && options?.prompt) {
      console.error(chalk.red('Error: --prompt cannot be used together with <ticket-key>'));
      process.exit(1);
    }

    if (!ticketKey && !options?.prompt) {
      console.error(
        chalk.red('Error: Provide a <ticket-key> or use --prompt <text> for a freeform plan'),
      );
      process.exit(1);
    }

    const platformName =
      options?.platform ||
      this.configService.get<string>('platforms.primary', 'jira');

    // Bitbucket + ticket-key requires --repos
    if (ticketKey && platformName === 'bitbucket' && !options?.repos?.length) {
      console.error(chalk.red('Error: --repos is required for Bitbucket ticket fetching'));
      process.exit(1);
    }

    const action = options!.action;  // guaranteed by required: true
    const format = options?.format || 'json';
    const platformDir = resolveArtifactDir(process.cwd(), platformName);

    // ── PROMPT MODE ──────────────────────────────────────────────────────
    if (options?.prompt) {
      const planFilename = `${generateMnemonic()}-${action}.json`;
      const planPath = path.join(platformDir, planFilename);

      if (options.dryRun) {
        this.dryRunPreview.showHeader('issue:plan', `--prompt (${action})`);
        this.dryRunPreview.previewApiCall({
          method: 'POST',
          endpoint: '/v1/messages',
          platform: 'Anthropic Claude',
          description: `Generate ${action} plan from prompt`,
          estimatedResponse: [
            '{',
            `  "action": "${action}",`,
            '  "estimatedComplexity": "medium",',
            '  "steps": ["<step 1>", "..."],',
            '  "filesAffected": ["<file>", "..."]',
            '}',
          ].join('\n'),
        });
        this.dryRunPreview.previewFileWrite({
          filePath: path.join(platformDir, `{mnemonic}-${action}.json`),
          operation: 'create',
          sizeEstimate: '2–8 KB',
          format,
          contentPreview: `{ "action": "${action}", "estimatedComplexity": "medium", ... }`,
        });
        this.dryRunPreview.showSummary({
          apiCallCount: 1,
          fileCreatedCount: 1,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          terminalOutputLines: [
            `✓ Plan saved to: <artifact-dir>/${planFilename}`,
            '',
            `  Action: ${action}`,
            '  Complexity: <medium|high|low>',
          ],
        });
        this.dryRunPreview.showValidationResult();
        return;
      }

      this.logger.info(`Generating freeform ${action} plan from prompt...`);

      if (!fs.existsSync(platformDir)) {
        fs.mkdirSync(platformDir, { recursive: true });
      }

      const plan = await this.claudeService.generatePlan(
        action,
        options.prompt,
        { summary: options.prompt.slice(0, 80) },
      );

      let planContent: string;
      if (format === 'json') {
        planContent = JSON.stringify(plan, null, 2);
      } else if (format === 'yaml') {
        const YAML = await import('yaml');
        planContent = YAML.stringify(plan);
      } else {
        planContent = this.formatPlanAsMarkdown(plan);
      }

      await fs.promises.writeFile(planPath, planContent, 'utf-8');
      this.logger.success(`✓ Plan saved to: ${planPath}`);
      this.logger.info(`\nPlan Summary:`);
      this.logger.info(`  Action: ${plan.action}`);
      this.logger.info(`  Complexity: ${plan.estimatedComplexity}`);
      this.logger.info(`  Steps: ${plan.steps?.length || 0}`);
      this.logger.info(`  Files affected: ${plan.filesAffected?.length || 0}`);
      return;
    }

    // ── TICKET-KEY MODE (existing behaviour) ─────────────────────────────
    const ticketPath = path.join(platformDir, `${ticketKey}.md`);
    const planPath = path.join(platformDir, `${ticketKey}-plan-${action}.${format}`);
    const ticketExists = fs.existsSync(ticketPath);
    const needsFetch = options?.forceRecreate || !ticketExists;

    // ... rest of existing run() logic unchanged (dry-run block, fetch, generatePlan, save)
```

Keep the rest of the existing `run()` body (dry-run block, fetch logic, `generatePlan` call, file save) exactly as-is after the prompt-mode early return.

Also remove the `|| 'feature'` fallback for `action` since it is now required:
```typescript
// Before
const action = options?.action || 'feature';

// After (action guaranteed by required: true)
const action = options!.action;
```

- [ ] **Step 4: Run lint**

```bash
npx eslint src/commands/issue-plan.command.ts --fix
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Run the manual test**

```bash
nr test:manual -- test-enhancements
```

Expected: all E4 assertions pass. E5 assertions still fail (not yet implemented).

- [ ] **Step 6: Commit**

```bash
git add src/commands/issue-plan.command.ts test/manual/test-enhancements.ts
git commit -m "feat(e4): add --prompt option to issue:plan for freeform plan generation"
```

---

## Task 6: E5 — Add `--plan` to `issue:implement`

**Files:**
- Modify: `src/commands/issue-implement.command.ts`

- [ ] **Step 1: Update `IssueImplementOptions` interface** (lines 16–22):

```typescript
interface IssueImplementOptions {
  plan?: string;              // new
  platform?: string;
  forceRecreate?: boolean;
  format?: OutputFormat;
  repos?: string[];           // now optional
  dryRun?: boolean;
}
```

- [ ] **Step 2: Change `arguments`** in `@Command` decorator (line 31):

```typescript
// Before
arguments: '<ticket-key>',

// After
arguments: '[ticket-key]',
```

- [ ] **Step 3: Change `--repos` to `required: false`** (lines 80–91):

```typescript
@Option({
  flags: '-r, --repos <repos>',
  description:
    'Comma-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
  required: false,
})
parseRepos(val: string): string[] {
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
```

- [ ] **Step 4: Add `parsePlan` option method** (after `parseDryRun`):

```typescript
@Option({
  flags: '--plan <path>',
  description: 'Path to an existing plan JSON file (omit <ticket-key> to skip ticket fetch and branch generation)',
})
parsePlan(val: string): string {
  return val;
}
```

- [ ] **Step 5: Update `run()` method signature and add dispatch logic**

Change signature:
```typescript
async run(
  [ticketKey]: [string | undefined],
  options?: IssueImplementOptions,
): Promise<void> {
```

Add guards and keyless-plan branch at the top of `run()`:

```typescript
async run(
  [ticketKey]: [string | undefined],
  options?: IssueImplementOptions,
): Promise<void> {
  try {
    if (!ticketKey && !options?.plan) {
      console.error(
        chalk.red(
          'Error: Provide a <ticket-key> or use --plan <path> to load a plan directly',
        ),
      );
      process.exit(1);
    }

    const platformName =
      options?.platform ||
      this.configService.get<string>('platforms.primary', 'jira');

    // Bitbucket + ticket-key requires --repos
    if (ticketKey && platformName === 'bitbucket' && !options?.repos?.length) {
      console.error(chalk.red('Error: --repos is required for Bitbucket ticket fetching'));
      process.exit(1);
    }

    // ── KEYLESS --plan MODE ──────────────────────────────────────────────
    if (!ticketKey && options?.plan) {
      const planFilePath = path.resolve(options.plan);

      if (!fs.existsSync(planFilePath)) {
        console.error(chalk.red(`Error: Plan file not found: ${planFilePath}`));
        process.exit(1);
      }

      let plan: Record<string, unknown>;
      try {
        plan = JSON.parse(fs.readFileSync(planFilePath, 'utf-8')) as Record<string, unknown>;
      } catch {
        console.error(chalk.red(`Error: Plan file is not valid JSON: ${planFilePath}`));
        process.exit(1);
      }

      if (options.dryRun) {
        this.dryRunPreview.showHeader('issue:implement', options.plan);
        this.dryRunPreview.previewFileRead({
          filePath: planFilePath,
          exists: true,
          sizeInKb: (fs.statSync(planFilePath).size / 1024).toFixed(2),
        });
        this.dryRunPreview.showSummary({
          apiCallCount: 0,
          fileCreatedCount: 0,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          terminalOutputLines: [
            '🔧 Implementation Guide',
            '  Steps:',
            '    1. <step from plan>',
            '    2. ...',
            '',
            '  Files to modify:',
            '    - <file>',
            '',
            '  Status:',
            '    Ready to implement — create your branch before starting',
          ],
        });
        this.dryRunPreview.showValidationResult();
        return;
      }

      console.log(chalk.bold.yellow('\n🔧 Implementation Guide'));
      console.log(chalk.gray('─'.repeat(70)));

      const steps = plan.steps as string[] | undefined;
      const filesAffected = plan.filesAffected as string[] | undefined;
      const affectedRepositories = plan.affectedRepositories as string[] | undefined;

      if (steps?.length) {
        console.log(chalk.bold('\n  Steps:'));
        steps.forEach((step, i) => console.log(chalk.white(`    ${i + 1}. ${step}`)));
      }

      if (filesAffected?.length) {
        console.log(chalk.bold('\n  Files to modify:'));
        filesAffected.forEach((file) => console.log(chalk.gray(`    - ${file}`)));
      }

      if (affectedRepositories?.length) {
        console.log(chalk.bold('\n  Repositories affected:'));
        affectedRepositories.forEach((repo) => console.log(chalk.gray(`    - ${repo}`)));
      }

      console.log(chalk.bold('\n  Status:'));
      console.log(chalk.white('    Ready to implement — create your branch before starting'));
      return;
    }

    // ── TICKET-KEY MODE (existing behaviour, optionally overriding plan path) ──
    const action = 'feature';
    const format = options?.format || 'json';
    const platformDir = resolveArtifactDir(process.cwd(), platformName);
    const ticketPath = path.join(platformDir, `${ticketKey}.md`);
    const planPath = options?.plan
      ? path.resolve(options.plan)
      : path.join(platformDir, `${ticketKey!}-plan-${action}.${format}`);
    const ticketExists = fs.existsSync(ticketPath);
    const needsFetch = options?.forceRecreate || !ticketExists;

    // Validate --plan path early (before any fetch)
    if (options?.plan && !fs.existsSync(planPath)) {
      console.error(chalk.red(`Error: Plan file not found: ${planPath}`));
      process.exit(1);
    }

    if (options?.dryRun) {
      // ... existing dry-run block unchanged
    }

    // Fetch or load ticket (same as existing flow)
    let ticketContent: string;
    if (needsFetch) {
      const ticketReference =
        platformName === 'bitbucket'
          ? this.formatBitbucketReference(ticketKey!, options?.repos?.[0] ?? '', this.configService)
          : ticketKey!;
      const adapter = this.platformService.getAdapter(platformName);
      const ticket = await adapter.getTicket(ticketReference);
      if (!fs.existsSync(platformDir)) {
        fs.mkdirSync(platformDir, { recursive: true });
      }
      ticketContent = this.formatTicketAsMarkdown(ticket);
      await fs.promises.writeFile(ticketPath, ticketContent, 'utf-8');
      this.logger.success(`✓ Ticket saved to: ${ticketPath}`);
    } else {
      this.logger.info(`Using local artifact: ${ticketPath}`);
      ticketContent = await fs.promises.readFile(ticketPath, 'utf-8');
    }

    const summary = this.extractSummary(ticketContent);

    // Load plan from file (--plan) or generate via Claude (existing path)
    let plan: Record<string, unknown>;
    if (options?.plan) {
      try {
        plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        console.error(chalk.red(`Error: Plan file is not valid JSON: ${planPath}`));
        process.exit(1);
      }
    } else {
      plan = await this.claudeService.generatePlan(
        action,
        ticketContent,
        { ticketKey: ticketKey!, summary, affectedRepositories: options?.repos },
      ) as unknown as Record<string, unknown>;

      let planContent: string;
      if (format === 'json') {
        planContent = JSON.stringify(plan, null, 2);
      } else if (format === 'yaml') {
        planContent = YAML.stringify(plan);
      } else {
        planContent = this.formatPlanAsMarkdown(plan as any);
      }
      await fs.promises.writeFile(planPath, planContent, 'utf-8');
      this.logger.success(`✓ Plan saved to: ${planPath}`);
    }

    // Display plan summary (same for both paths)
    this.logger.info(`\nPlan Summary:`);
    this.logger.info(`  Action: ${String(plan.action ?? action)}`);
    this.logger.info(`  Complexity: ${String(plan.estimatedComplexity ?? 'N/A')}`);
    this.logger.info(`  Steps: ${Array.isArray(plan.steps) ? plan.steps.length : 0}`);
    this.logger.info(`  Files affected: ${Array.isArray(plan.filesAffected) ? plan.filesAffected.length : 0}`);
    this.logger.info(`  Repositories affected: ${Array.isArray(plan.affectedRepositories) ? plan.affectedRepositories.length : 0}`);
```

- [ ] **Step 6: Run lint and type-check**

```bash
npx eslint src/commands/issue-implement.command.ts --fix
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Run the full manual test suite**

```bash
nr test:manual -- test-enhancements
```

Expected: all assertions pass (0 failures).

Also confirm no regression in the original test:

```bash
nr test:manual -- test-issue-all-agents
```

Expected: all 22 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/commands/issue-implement.command.ts
git commit -m "feat(e5): add --plan option to issue:implement for plan-file-driven implementation guide"
```

---

## Task 7: Run final format + lint across all changed files

- [ ] **Step 1: Format**

```bash
nr format
```

Expected: all changed files reformatted, no errors.

- [ ] **Step 2: Lint changed files**

```bash
npx eslint src/agents/utils.ts src/agents/interfaces.ts src/agents/fetcher.agent.ts src/agents/planner.agent.ts src/agents/implementer.agent.ts src/commands/issue-plan.command.ts src/commands/issue-implement.command.ts src/commands/issue-generate.command.ts src/commands/issue-all.command.ts test/manual/test-issue-all-agents.ts test/manual/test-enhancements.ts
```

Expected: 0 errors.

- [ ] **Step 3: Run both manual tests one final time**

```bash
nr test:manual -- test-issue-all-agents
nr test:manual -- test-enhancements
```

Expected: 22 + all enhancements test pass, 0 failures.

- [ ] **Step 4: Commit test file**

```bash
git add test/manual/test-enhancements.ts
git commit -m "test(enhancements): add manual tests for E2 artifact path, E4 --prompt, E5 --plan"
```

---

## Verification Checklist

1. `FetcherAgent.loadFromDisk()` error message contains `.wf/` in the path (E2 confirmed in agent layer)
2. `wf issue:plan WBP-0001 --action feature --repos test-repo --dry-run` shows `.wf/jira/` path (E2 confirmed in command layer)
3. `wf issue:plan --prompt "..." --action feature --repos test-repo --dry-run` exits 0, output matches `*-feature.json` pattern (E4)
4. `wf issue:plan WBP-0001 --prompt "..." --action feature --repos test-repo --dry-run` exits non-zero, output contains `--prompt` (E4 guard)
5. `wf issue:implement --plan /nonexistent --repos test-repo` exits non-zero, output contains `Plan file not found` (E5 error path)
6. `wf issue:implement --plan <valid> --dry-run` exits 0, output does NOT contain `git checkout -b` (E5 keyless mode)
7. `wf issue:implement --dry-run` (no args) exits non-zero (E5 guard)
8. All 22 assertions in `test-issue-all-agents.ts` still pass (no regression)
9. `WorkflowStage.IMPLEMENT = 'implement'` is unchanged in `issue-all.command.ts`
10. `npx tsc --noEmit` exits 0 after all tasks
