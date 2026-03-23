# `issue:implement` — Require Pre-existing Plan Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `--force-recreate` from `issue:implement` and make Mode C fail fast with actionable errors when the ticket or plan artifact is missing, instead of auto-fetching or generating them.

**Architecture:** All changes are confined to `IssueImplementCommand`. The two preflight checks are placed before the dry-run block so they gate both the live and dry-run paths. Mode B (`ticketKey + --plan`) and Mode A (`--plan` only) are untouched.

**Tech Stack:** TypeScript, NestJS (`nest-commander`), Jest, `fs` (Node built-in)

**Spec:** `docs/superpowers/specs/2026-03-23-issue-implement-require-plan-artifact-design.md`

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Modify | `src/commands/issue-implement.command.ts` | Remove `--force-recreate`, add preflight checks, rewrite Mode C live + dry-run paths |
| Create | `src/commands/issue-implement.command.spec.ts` | New unit tests covering both preflight checks and the updated dry-run |
| Create | `test/manual/test-issue-implement-preflight.ts` | Manual test for preflight checks |

---

## Task 1: Unit test skeleton and `--force-recreate` removal

**Files:**
- Create: `src/commands/issue-implement.command.spec.ts`
- Modify: `src/commands/issue-implement.command.ts`

### Context

The test file mirrors the pattern from `src/commands/run.command.spec.ts`:
- Mock `chalk` at the top before any imports (must include all color chains used in the source and reference tests).
- Build a minimal NestJS test module with all injected services mocked.
- Use `jest.spyOn(process, 'exit').mockImplementation(...)` to intercept `process.exit(1)` calls without actually exiting.
- Use `jest.spyOn(require('fs'), 'existsSync')` to control which artifacts appear to be present on disk.

### Steps

- [ ] **Step 1: Write the failing test — `--force-recreate` option is gone**

Create `src/commands/issue-implement.command.spec.ts` with the following content:

```typescript
// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (s: any) => s;
  const makeChain = () => {
    const chain: any = identity;
    [
      'bold', 'dim', 'italic', 'underline', 'inverse', 'strikethrough',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
      'white', 'gray', 'grey',
    ].forEach((name) => { chain[name] = identity; });
    return chain;
  };
  const chalk = makeChain();
  chalk.bold = makeChain();
  return { default: chalk, ...chalk };
});

import { Test } from '@nestjs/testing';
import { IssueImplementCommand } from './issue-implement.command';
import { ClaudeService } from '../integrations/ai/claude.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';

async function buildCommand(): Promise<IssueImplementCommand> {
  const module = await Test.createTestingModule({
    providers: [
      IssueImplementCommand,
      { provide: ClaudeService, useValue: {} },
      { provide: PlatformService, useValue: {} },
      {
        provide: ConfigService,
        useValue: { get: jest.fn().mockReturnValue('jira') },
      },
      {
        provide: LoggerService,
        useValue: {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          success: jest.fn(),
        },
      },
      {
        provide: DryRunPreviewService,
        useValue: {
          showHeader: jest.fn(),
          showSummary: jest.fn(),
          showValidationResult: jest.fn(),
          previewApiCall: jest.fn(),
          previewFileRead: jest.fn(),
          previewFileWrite: jest.fn(),
        },
      },
      {
        provide: AgentOrchestrator,
        useValue: {
          implementer: { execute: jest.fn() },
          planner: { execute: jest.fn() },
        },
      },
    ],
  }).compile();
  return module.get(IssueImplementCommand);
}

describe('IssueImplementCommand', () => {
  describe('option metadata', () => {
    it('does not expose a --force-recreate option', () => {
      const proto = IssueImplementCommand.prototype as any;
      expect(proto.parseForceRecreate).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run the test — it should FAIL** (method still exists)

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: FAIL — `parseForceRecreate` is defined on the prototype.

- [ ] **Step 3: Remove `--force-recreate` from the command**

In `src/commands/issue-implement.command.ts`:

3a. Remove the `forceRecreate` field from `IssueImplementOptions`:
```typescript
// Before
interface IssueImplementOptions {
  plan?: string;
  platform?: string;
  forceRecreate?: boolean;   // DELETE this line
  format?: OutputFormat;
  repos?: string[];
  dryRun?: boolean;
}
```

3b. Remove the entire `@Option` block for `--force-recreate` (lines ~114–120):
```typescript
// DELETE this entire block:
@Option({
  flags: '--force-recreate',
  description: 'Force fetch and recreate ticket artifact before planning',
})
parseForceRecreate(): boolean {
  return true;
}
```

3c. Update the `@Command` description (lines ~73–77) to:
```typescript
@Command({
  name: 'issue:implement',
  description:
    'Carry out an implementation plan for a ticket. ' +
    'Requires a local ticket artifact (<ticketKey>.md) and a plan artifact ' +
    '(<ticketKey>-plan-<action>.json). ' +
    'Run issue:fetch then issue:plan before calling this command.',
  arguments: '[ticket-key]',
})
```

- [ ] **Step 4: Run the test — it should PASS**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/issue-implement.command.ts src/commands/issue-implement.command.spec.ts
git commit -m "feat(issue-implement): remove --force-recreate option"
```

---

## Task 2: Mode C live path — replace auto-fetch + plan-generation with preflight checks

**Files:**
- Modify: `src/commands/issue-implement.command.ts`
- Modify: `src/commands/issue-implement.command.spec.ts`

### Context

The current Mode B/C block (after the Mode A return at line ~402) begins with:

```typescript
const platformDir = resolveArtifactDir(process.cwd(), platformName);
const ticketPath = path.join(platformDir, `${ticketKey}.md`);
const discovered = discoverPlanAction(platformDir, ticketKey);
const action: ResolutionAction = discovered.action;
const planPath = discovered.filePath;
const ticketExists = fs.existsSync(ticketPath);
const needsFetch = options?.forceRecreate || !ticketExists;   // will be removed
```

After this task: `ticketExists`, `needsFetch`, and the live fetch block (lines ~578–609) are gone. The `planArtifact` branch structure is preserved — Mode B still sets `planArtifact` from `resolvedPlanPath`; Mode C now loads it from `planPath`. The single `orchestrator.implementer.execute` call remains **outside** the if/else (as it is today).

The final structure of the live path will be:

```typescript
// checks and variable setup
const platformDir = ...;
const ticketPath = ...;
const discovered = ...;
const planPath = discovered.filePath;

// Check 1 — ticket
if (!fs.existsSync(ticketPath)) { ... process.exit(1); }

// Check 2 — plan
if (!fs.existsSync(planPath)) { ... process.exit(1); }

// [dry-run block here — Task 3]

// live path
this.logger.info(...);
const ticketContent = await fs.promises.readFile(ticketPath, 'utf-8');
const ticketArtifact: TicketArtifact = { ticketKey, content: ticketContent, path: ticketPath };

let planArtifact: PlanArtifact;
if (resolvedPlanPath) {
  // Mode B — unchanged
  const plan = loadPlanFile(resolvedPlanPath) as ResolutionPlan;
  planArtifact = { plan, action: ((plan as any).action ?? action) as ResolutionAction, path: resolvedPlanPath };
} else {
  // Mode C — load from disk instead of generating via AI
  const plan = loadPlanFile(planPath) as ResolutionPlan;
  planArtifact = {
    plan,
    // `action` is not declared on ResolutionPlan; the `as any` cast is intentional
    // and mirrors the same defensive pattern already used in Mode B.
    action: ((plan as any).action ?? action) as ResolutionAction,
    path: planPath,
  };
}

await this.orchestrator.implementer.execute(ticketArtifact, planArtifact, { platformName });
```

### Steps

- [ ] **Step 1: Write failing test — ticket artifact missing**

Add to the `describe('IssueImplementCommand')` block in the spec file:

```typescript
describe('Mode C — preflight checks (live path)', () => {
  let command: IssueImplementCommand;
  let exitSpy: jest.SpyInstance;
  let existsSyncSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    command = await buildCommand();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    existsSyncSpy = jest.spyOn(require('fs'), 'existsSync');
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    existsSyncSpy.mockRestore();
  });

  it('exits with code 1 and prints fetch hint when ticket artifact is missing', async () => {
    existsSyncSpy.mockReturnValue(false);

    await command.run(['WBP-0001'], { repos: ['repo-a'] });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorOutput).toContain('Ticket artifact not found');
    expect(errorOutput).toContain('issue:fetch');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: FAIL — no preflight check yet.

- [ ] **Step 3: Implement Check 1 — ticket artifact**

In `run()`, replace the `ticketExists` + `needsFetch` lines with:

```typescript
// Preflight Check 1: ticket artifact must exist
if (!fs.existsSync(ticketPath)) {
  console.error(
    chalk.red(`Error: Ticket artifact not found: ${ticketPath}`),
  );
  console.error(
    chalk.yellow(
      `Run:   wf issue:fetch ${ticketKey}${options?.repos?.length ? ` --repos ${options.repos.join(',')}` : ''}`,
    ),
  );
  process.exit(1);
}
```

- [ ] **Step 4: Run — ticket-missing test should PASS**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: PASS.

- [ ] **Step 5: Write failing test — plan artifact missing**

Add to the `describe('Mode C — preflight checks (live path)')` block:

```typescript
it('exits with code 1 and prints plan hint when ticket exists but plan is missing', async () => {
  // .md paths → ticket exists; .json paths → plan does not exist
  existsSyncSpy.mockImplementation((p: string) => String(p).endsWith('.md'));

  await command.run(['WBP-0001'], { repos: ['repo-a'] });

  expect(exitSpy).toHaveBeenCalledWith(1);
  const errorOutput = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  expect(errorOutput).toContain('No plan artifact found');
  expect(errorOutput).toContain('issue:plan');
  expect(errorOutput).toContain('issue:implement');
});
```

- [ ] **Step 6: Run — plan-missing test should FAIL**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: FAIL — no plan check yet.

- [ ] **Step 7: Implement Check 2 — plan artifact**

Immediately after Check 1, add:

```typescript
// Preflight Check 2: plan artifact must exist
// Note: discoverPlanAction always returns a struct — when no plan exists on disk,
// it returns a synthesised fallback path that does not exist. This fs.existsSync
// is the only gate.
if (!fs.existsSync(planPath)) {
  console.error(
    chalk.red(`Error: No plan artifact found for ${ticketKey}.`),
  );
  console.error(
    chalk.yellow(
      `Run:   wf issue:plan ${ticketKey} --action <feature|fix|investigate>${options?.repos?.length ? ` --repos ${options.repos.join(',')}` : ''}`,
    ),
  );
  console.error(
    chalk.yellow(
      `Then:  wf issue:implement ${ticketKey}${options?.repos?.length ? ` --repos ${options.repos.join(',')}` : ''}`,
    ),
  );
  process.exit(1);
}
```

- [ ] **Step 8: Run — both preflight tests should PASS**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: PASS.

- [ ] **Step 9: Write failing test — happy path loads artifacts from disk**

> **Note on spy interaction:** `existsSyncSpy.mockReturnValue(true)` satisfies both the preflight checks and the internal `fs.existsSync` call inside `loadPlanFile` (line ~27 of the command), so no separate stub is needed for `loadPlanFile`'s guard. The `readFileSync` spy feeds the `JSON.parse` inside `loadPlanFile`.

```typescript
it('reads ticket and plan from disk and calls implementer when both artifacts exist', async () => {
  existsSyncSpy.mockReturnValue(true);

  const mockOrchestrator = {
    implementer: { execute: jest.fn().mockResolvedValue(undefined) },
    planner: { execute: jest.fn() },
  };
  const module = await Test.createTestingModule({
    providers: [
      IssueImplementCommand,
      { provide: ClaudeService, useValue: {} },
      { provide: PlatformService, useValue: {} },
      { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('jira') } },
      {
        provide: LoggerService,
        useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
      },
      {
        provide: DryRunPreviewService,
        useValue: {
          showHeader: jest.fn(), showSummary: jest.fn(), showValidationResult: jest.fn(),
          previewApiCall: jest.fn(), previewFileRead: jest.fn(), previewFileWrite: jest.fn(),
        },
      },
      { provide: AgentOrchestrator, useValue: mockOrchestrator },
    ],
  }).compile();
  const cmd = module.get(IssueImplementCommand);

  // Allow ticket .md and only the feature plan to appear to exist so
  // discoverPlanAction returns action='feature' (not investigate, which is first
  // in its candidates array when all mtimeMs are equal).
  existsSyncSpy.mockImplementation((p: string) =>
    !String(p).includes('-plan-investigate.json') &&
    !String(p).includes('-plan-fix.json'),
  );
  // statSync is called by discoverPlanAction's sort and by previewFileRead size
  jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
  jest.spyOn(require('fs').promises, 'readFile').mockResolvedValue('# WBP-0001\n**Ticket:** WBP-0001\n');
  jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
    JSON.stringify({ action: 'feature', steps: [] }),
  );

  await cmd.run(['WBP-0001'], { repos: ['repo-a'] });

  expect(mockOrchestrator.implementer.execute).toHaveBeenCalledTimes(1);
  const [ticketArg, planArg] = mockOrchestrator.implementer.execute.mock.calls[0];
  expect(ticketArg.ticketKey).toBe('WBP-0001');
  expect(planArg.action).toBe('feature');
  // planner was never called — plan was loaded from disk
  expect(mockOrchestrator.planner.execute).not.toHaveBeenCalled();
});
```

- [ ] **Step 10: Run — happy-path test should FAIL**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: FAIL — Mode C still calls `orchestrator.planner.execute`.

- [ ] **Step 11: Replace Mode C live path**

In `run()`, keep the `if (resolvedPlanPath)` Mode B branch exactly as-is. Replace only the `else` branch (which currently calls `this.orchestrator.planner.execute`) with:

```typescript
} else {
  // Mode C: load plan from disk (plan artifact verified by preflight check above)
  const plan = loadPlanFile(planPath) as ResolutionPlan;
  planArtifact = {
    plan,
    // `action` is not declared on ResolutionPlan; the `as any` cast is intentional
    // and mirrors the same defensive pattern used in Mode B above.
    action: ((plan as any).action ?? action) as ResolutionAction,
    path: planPath,
  };
}
```

Also remove the `this.logger.info(`Implementing ticket...`)` line and the `ticketContent` fetch block that currently reads from disk or fetches from the platform, and replace the entire section from the old `if (needsFetch)` block down to the `ticketArtifact` construction with:

```typescript
this.logger.info(`Implementing ticket ${ticketKey}...`);
const ticketContent = await fs.promises.readFile(ticketPath, 'utf-8');
const ticketArtifact: TicketArtifact = {
  ticketKey,
  content: ticketContent,
  path: ticketPath,
};
```

The `await this.orchestrator.implementer.execute(ticketArtifact, planArtifact, { platformName })` call that follows the if/else remains unchanged — it is already outside the branching logic.

- [ ] **Step 12: Run — all three Mode C tests should PASS**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add src/commands/issue-implement.command.ts src/commands/issue-implement.command.spec.ts
git commit -m "feat(issue-implement): Mode C requires pre-existing ticket and plan artifacts"
```

---

## Task 3: Dry-run path — apply preflight checks and simplify Mode C preview

**Files:**
- Modify: `src/commands/issue-implement.command.ts`
- Modify: `src/commands/issue-implement.command.spec.ts`

### Context

The dry-run block currently follows the (now-removed) `needsFetch` variable. After this task:
- The two preflight checks from Task 2 fire **before** `if (options?.dryRun)`, so they gate both paths.
- The dry-run ticket section unconditionally calls `previewFileRead` for `ticketPath` (no `if (needsFetch)` branch).
- The plan-source section: Mode B shows `previewFileRead` for `resolvedPlanPath`; Mode C shows `previewFileRead` for `planPath`.
- `showSummary` counts: `apiCallCount: investigateApiCalls`, `fileCreatedCount: investigateFiles` — where both are `0` for feature/fix plans and `1` for investigate plans. No fetch or plan-generation counts.

### Steps

- [ ] **Step 1: Write failing tests — dry-run exits when either artifact is missing**

Add to the spec file:

```typescript
describe('Mode C — dry-run path', () => {
  let command: IssueImplementCommand;
  let exitSpy: jest.SpyInstance;
  let existsSyncSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let dryRunPreview: jest.Mocked<DryRunPreviewService>;

  beforeEach(async () => {
    command = await buildCommand();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    existsSyncSpy = jest.spyOn(require('fs'), 'existsSync');
    dryRunPreview = (command as any).dryRunPreview as jest.Mocked<DryRunPreviewService>;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    existsSyncSpy.mockRestore();
  });

  it('exits with code 1 and does not render preview when ticket artifact is missing', async () => {
    existsSyncSpy.mockReturnValue(false);

    await command.run(['WBP-0001'], { dryRun: true, repos: ['repo-a'] });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(dryRunPreview.showHeader).not.toHaveBeenCalled();
  });

  it('exits with code 1 and does not render preview when plan artifact is missing', async () => {
    existsSyncSpy.mockImplementation((p: string) => String(p).endsWith('.md'));

    await command.run(['WBP-0001'], { dryRun: true, repos: ['repo-a'] });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(dryRunPreview.showHeader).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: FAIL — dry-run block renders the header before any guards.

- [ ] **Step 3: Move preflight checks before the dry-run block**

Ensure the Mode B/C block is ordered as follows (the preflight checks from Task 2 are moved above `if (options?.dryRun)`):

```typescript
// ── MODE B & C: ticketKey present ─────────────────────────────────
const platformDir = resolveArtifactDir(process.cwd(), platformName);
const ticketPath = path.join(platformDir, `${ticketKey}.md`);
const discovered = discoverPlanAction(platformDir, ticketKey);
const action: ResolutionAction = discovered.action;
const planPath = discovered.filePath;

// Preflight Check 1: ticket artifact must exist (gates both live + dry-run)
if (!fs.existsSync(ticketPath)) {
  // ... same error + process.exit(1) as Task 2
}

// Preflight Check 2: plan artifact must exist (gates both live + dry-run)
if (!fs.existsSync(planPath)) {
  // ... same error + process.exit(1) as Task 2
}

if (options?.dryRun) {
  this.dryRunPreview.showHeader('issue:implement', ticketKey);

  // Ticket: always a file-read now (no fetch branch)
  this.dryRunPreview.previewFileRead({
    filePath: ticketPath,
    exists: true,
    sizeInKb: (fs.statSync(ticketPath).size / 1024).toFixed(2),
  });

  if (resolvedPlanPath) {
    // Mode B: plan from --plan flag
    const planExists = fs.existsSync(resolvedPlanPath);
    this.dryRunPreview.previewFileRead({
      filePath: resolvedPlanPath,
      exists: planExists,
      sizeInKb: planExists ? (fs.statSync(resolvedPlanPath).size / 1024).toFixed(2) : '0',
    });
  } else {
    // Mode C: plan from disk
    this.dryRunPreview.previewFileRead({
      filePath: planPath,
      exists: true,
      sizeInKb: (fs.statSync(planPath).size / 1024).toFixed(2),
    });
  }

  // investigate: also preview findings generation
  if (action === 'investigate') {
    // ... existing investigate previewApiCall + previewFileWrite — keep unchanged
  }

  const investigateApiCalls = action === 'investigate' ? 1 : 0;
  const investigateFiles = action === 'investigate' ? 1 : 0;
  this.dryRunPreview.showSummary({
    apiCallCount: investigateApiCalls,
    fileCreatedCount: investigateFiles,
    fileModifiedCount: 0,
    gitOperationCount: 0,
    terminalOutputLines: [
      ...(action === 'investigate'
        ? [
            `✓ Investigation findings saved to: ${(resolvedPlanPath ?? planPath).replace('.json', '-findings-and-recommendations.json')}`,
          ]
        : [
            '',
            'Plan Summary:',
            '  Action: ' + action,
            '  Complexity: <medium|high|low>',
            '  Steps: <n>',
            '  Files affected: <n>',
            '  Repositories affected: <n>',
          ]),
    ],
  });

  this.dryRunPreview.showValidationResult();
  return;
}

// live path follows...
```

- [ ] **Step 4: Run — preflight dry-run tests should PASS**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: the two missing-artifact dry-run tests pass.

- [ ] **Step 5: Write failing test — dry-run Mode C shows two file-read previews (feature plan)**

```typescript
it('previews two file-reads and shows summary with zero counts when both artifacts exist (feature plan)', async () => {
  // Allow ticket .md and only the feature plan so discoverPlanAction resolves
  // action='feature' (investigate is first in the candidates array and would win
  // when all mtimeMs are equal if we simply mockReturnValue(true) for everything).
  existsSyncSpy.mockImplementation((p: string) =>
    !String(p).includes('-plan-investigate.json') &&
    !String(p).includes('-plan-fix.json'),
  );
  jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);

  await command.run(['WBP-0001'], { dryRun: true, repos: ['repo-a'] });

  expect(exitSpy).not.toHaveBeenCalled();
  expect(dryRunPreview.previewFileRead).toHaveBeenCalledTimes(2);
  expect(dryRunPreview.showSummary).toHaveBeenCalledWith(
    expect.objectContaining({ apiCallCount: 0, fileCreatedCount: 0 }),
  );
});
```

- [ ] **Step 6: Run — expect FAIL**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: FAIL.

- [ ] **Step 7: Write failing test — dry-run investigate plan shows apiCallCount: 1**

```typescript
it('shows apiCallCount: 1 and fileCreatedCount: 1 for investigate plan dry-run', async () => {
  existsSyncSpy.mockReturnValue(true);
  jest.spyOn(require('fs'), 'statSync').mockReturnValue({ size: 2048, mtimeMs: Date.now() } as any);
  // Make discoverPlanAction return an investigate plan by naming the mock plan file accordingly
  // The statSync sort picks the most recent — stub readFileSync to confirm the action in the file
  jest.spyOn(require('fs'), 'readFileSync').mockReturnValue(
    JSON.stringify({ action: 'investigate' }),
  );
  // Override existsSync so the investigate plan file is the one that "exists"
  existsSyncSpy.mockImplementation((p: string) =>
    // ticket exists; investigate plan exists; feature/fix plans do not
    String(p).endsWith('.md') || String(p).includes('-plan-investigate.json'),
  );

  await command.run(['WBP-0001'], { dryRun: true, repos: ['repo-a'] });

  expect(exitSpy).not.toHaveBeenCalled();
  expect(dryRunPreview.showSummary).toHaveBeenCalledWith(
    expect.objectContaining({ apiCallCount: 1, fileCreatedCount: 1 }),
  );
});
```

- [ ] **Step 8: Run — both new dry-run tests should FAIL**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: FAIL — dry-run still previews AI plan generation and uses old compound counts.

- [ ] **Step 9: Apply the dry-run rewrite from Step 3**

Apply the full dry-run block shown in Step 3 above.

- [ ] **Step 10: Run — all dry-run tests should PASS**

```bash
yarn test --testPathPattern="issue-implement.command.spec" --no-coverage
```

Expected: PASS.

- [ ] **Step 11: Run full test suite**

```bash
yarn test --no-coverage
```

Expected: PASS. Fix any regressions before continuing.

- [ ] **Step 12: Commit**

```bash
git add src/commands/issue-implement.command.ts src/commands/issue-implement.command.spec.ts
git commit -m "feat(issue-implement): update dry-run to apply preflight checks and drop AI plan-gen preview"
```

---

## Task 4: Manual test and build

**Files:**
- Create: `test/manual/test-issue-implement-preflight.ts`

### Steps

- [ ] **Step 1: Write the manual test**

Create `test/manual/test-issue-implement-preflight.ts`:

```typescript
/**
 * Manual Test: issue:implement preflight checks
 *
 * Run: nr test:manual -- test-issue-implement-preflight
 *
 * Verifies:
 *   1. Exits with code 1 and prints fetch hint when ticket artifact is missing
 *   2. Exits with code 1 and prints plan hint when ticket exists but plan is missing
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;
const pass = (msg: string) => { console.log(`  ✓ ${msg}`); passed++; };
const fail = (msg: string, detail?: string) => {
  console.error(`  ✗ ${msg}${detail ? `\n    → ${detail}` : ''}`);
  failed++;
};

function captureExit(): { restore: () => number } {
  let code = 0;
  const orig = process.exit.bind(process);
  (process.exit as any) = (c: number) => { code = c; };
  return { restore: () => { (process.exit as any) = orig; return code; } };
}

function captureConsoleError(): { restore: () => string } {
  let out = '';
  const orig = console.error.bind(console);
  (console.error as any) = (...args: any[]) => { out += args.join(' ') + '\n'; };
  return { restore: () => { (console.error as any) = orig; return out; } };
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const command = app.get(IssueImplementCommand);

  // ── Test 1: ticket artifact missing ──────────────────────────────────────
  console.log('\n🧪 Test 1: missing ticket artifact\n' + '─'.repeat(60));
  {
    const exitCapture = captureExit();
    const errCapture = captureConsoleError();
    // run from current dir — TEST-MISSING ticket will not exist in .wf/
    await command.run(['TEST-MISSING-9999'], {});
    const exitCode = exitCapture.restore();
    const errorOutput = errCapture.restore();

    if (exitCode === 1) {
      pass('Exits with code 1 when ticket artifact is missing');
    } else {
      fail('Did not exit with code 1', `exitCode: ${exitCode}`);
    }
    if (errorOutput.includes('issue:fetch')) {
      pass('Error output contains issue:fetch hint');
    } else {
      fail('Error output missing issue:fetch hint', errorOutput.slice(0, 300));
    }
  }

  // ── Test 2: ticket exists, plan missing ──────────────────────────────────
  console.log('\n🧪 Test 2: ticket exists, plan missing\n' + '─'.repeat(60));
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-implement-test-'));
    const artifactDir = path.join(tmpDir, '.wf', 'jira');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'PLAN-MISSING-001.md'), '# PLAN-MISSING-001\n');

    // Temporarily override process.cwd so resolveArtifactDir picks up our tmpDir
    const origCwd = process.cwd.bind(process);
    (process as any).cwd = () => tmpDir;

    const exitCapture = captureExit();
    const errCapture = captureConsoleError();
    await command.run(['PLAN-MISSING-001'], {});
    const exitCode = exitCapture.restore();
    const errorOutput = errCapture.restore();
    (process as any).cwd = origCwd;

    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (exitCode === 1) {
      pass('Exits with code 1 when plan artifact is missing');
    } else {
      fail('Did not exit with code 1', `exitCode: ${exitCode}`);
    }
    if (errorOutput.includes('issue:plan')) {
      pass('Error output contains issue:plan hint');
    } else {
      fail('Error output missing issue:plan hint', errorOutput.slice(0, 300));
    }
  }

  await app.close();

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) console.log('✅ All tests passed!');
  console.log('━'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the manual test**

```bash
nr test:manual -- test-issue-implement-preflight
```

Expected: `✅ All tests passed!`

If it fails, diagnose and fix before continuing.

- [ ] **Step 3: Run the full unit test suite one final time**

```bash
yarn test --no-coverage
```

Expected: PASS.

- [ ] **Step 4: Run `yarn build`**

```bash
yarn build
```

Expected: no TypeScript errors, build succeeds.

- [ ] **Step 5: Final commit**

```bash
git add test/manual/test-issue-implement-preflight.ts
git commit -m "test(issue-implement): manual preflight check verification"
```
