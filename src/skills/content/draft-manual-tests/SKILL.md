---
name: draft-manual-tests
description: Draft prompts for candidate manual smoke tests that enter the system through user-facing surfaces (CLI invocation, config file, on-disk artifact). Use when asked to propose manual test coverage for a change before writing the tests.
---

**Category:** Methodology skill.

## Purpose

Produce *prompts* — not test code — for candidate manual smoke tests in the current project's `test/manual` directory, following the pattern documented below. Each prompt is a complete, self-sufficient brief that a later session can implement without re-deriving context.

Deliverables are **only prompts in the output format below, then wait for further instructions**. Do not write the test files, the runner, or any production code in the same turn.

## Rules for every candidate test

- Target exactly the behavior introduced by the change, not the entire subsystem.
- Enter the system where users do: a CLI invocation, an endpoint, an on-disk artifact, or a real config file — never a direct call to an internal service, exported function, or test-framework binding. Existing unit and integration tests already cover the internals.
- Be copy-paste-runnable from the repo root, produce human-readable pass/fail output, and exit 0 on success and 1 on failure.
- Reference real scripts from the project's test infrastructure (e.g. `nr test:manual {name}`); verify the script exists in `package.json` before citing it.
- Verify CLI flags against the installed framework version (`node dist/main.js <cmd> --help`, `npx <tool> --version`) before writing assertions that depend on them — stale flags produce false passes.
- If `test/manual` does not exist, the first prompt must include creating the directory tree and the runner infrastructure (see reference implementation below).
- If a manual test already exists covering the same observable behavior, do not duplicate it — extend it or note the overlap in the prompt instead.
- Use the correct package manager for the smoke test runner: detect from the lockfile (`package-lock.json` → npm, `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm), or use `nr` (antfu-collective/ni) which detects automatically.

## Prompt output format

One block per candidate test, nothing else:

```txt
// {feature}.smoke.ts. The `test-` prefix is redundant.
Manual smoke test: <one-line description of the specific behavior under test>

Scenario: <what the user does and what observable output is expected; name the
concrete entry point (endpoint/CLI command, config field,
on-disk artifact path)>

Config under test:
  <minimal config snippet or CLI invocation that exercises the behavior>

Verify:
  1. <observable assertion expressed as exit code, stdout content, or file content>
  2. ...
  N. ...

Wire up: <how to reach the entry point — CLI flags, temp git repo setup, config
bootstrap — without bypassing the user-facing surface>

Teardown: <cleanup steps>
```

## Reference implementation (the wf pattern)

The pattern the prompts must assume. If the target project lacks this infrastructure, the first prompt scaffolds it.

### Test configuration — `package.json`

```json
{
  "scripts": {
    "test:manual": "ts-node -r tsconfig-paths/register run-manual-test.ts"
  }
}
```

Run as `nr test:manual {testFileNameWithoutTsExtension}`, e.g. `nr test:manual bar.smoke`.

### Runner — `run-manual-test.ts` (repo root)

Resolves `test/manual/{name}.ts`, guards against running outside the project root, loads app config before requiring the test, and exits 1 on any unhandled error:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';

const runManualTest = async (): Promise<void> => {
  const packageJsonPath = path.join(__dirname, 'package.json');
  const expectedName = 'my-app';
  const isProjectRoot
    = fs.existsSync(packageJsonPath)
      && JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).name === expectedName;
  if (!isProjectRoot) throw new Error(`Manual tests must be run from the ${expectedName} project root.`);

  const testName = process.argv[2];
  if (!testName) {
    console.error('Usage: nr test:manual {testFileNameWithoutTsExtension}');
    process.exit(1);
  }

  const resolvedTestPath = path.join(__dirname, 'test', 'manual', `${testName}.ts`);
  if (!fs.existsSync(resolvedTestPath)) {
    console.error(`Manual test "${testName}" not found in test/manual.`);
    process.exit(1);
  }

  // Load project config here if tests need it, then:
  require(resolvedTestPath);
};

runManualTest().catch(error => {
  console.error(error.message ?? error);
  process.exit(1);
});
```

### Helper — `test/manual/support/reporter.ts`

Shared pass/fail reporter; `summarise` prints a human-readable tally and exits 1 on any failure:

```typescript
import chalk from 'chalk';

export interface TestCounts { passed: number; failed: number }

export interface Reporter {
  counts: TestCounts;
  pass: (msg: string) => void;
  fail: (msg: string, detail?: string) => void;
}

export function createReporter(): Reporter {
  const counts: TestCounts = { passed: 0, failed: 0 };
  const pass = (msg: string): void => {
    console.log(chalk.green(`  PASS  ${msg}`));
    counts.passed++;
  };
  const fail = (msg: string, detail?: string): void => {
    const suffix = detail ? '\n    → ' + detail : '';
    console.error(chalk.red('  FAIL  ' + msg + suffix));
    counts.failed++;
  };
  return { counts, pass, fail };
}

export function summarise(counts: TestCounts): void {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) console.log('✓ All tests passed!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (counts.failed > 0) process.exit(1);
}
```

Scenario-specific harnesses (temp git repos, fake home directories, CLI spawners) live beside it in `test/manual/support/` and are reused across tests rather than re-implemented inline.

### Quintessential example — `test/manual/issue-commit-ticket-key-flag.smoke.ts`

A CLI flag migration verified through the compiled binary's help output — the user-facing surface — not through the command class's internals. Note the docs header (what it runs and verifies), the reporter helpers, the entry via `node dist/main.js`, and the single `summarise` call that sets the exit code:

```typescript
/**
 * Manual Test: issue:commit --ticket-key flag migration
 *
 * Run: nr test:manual issue-commit-ticket-key-flag.smoke
 *
 * Verifies:
 *   1. issue:commit --help shows -k, --ticket-key
 *   2. issue:commit --help no longer shows a [ticket-key] positional argument
 *   3. issue:commit --help options are in alphabetical order by long flag name
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

function getHelpOutput(): string {
  const distMain = path.join(__dirname, '../../dist/main.js');
  try {
    return execSync(`node ${distMain} issue:commit --help`, { encoding: 'utf-8', cwd: os.tmpdir() });
  } catch (err: any) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

function checkHelpShowsTicketKeyFlag(help: string): void {
  if (help.includes('-k, --ticket-key')) {
    pass('issue:commit --help shows -k, --ticket-key');
  } else {
    fail('issue:commit --help does NOT show -k, --ticket-key', help.slice(0, 300));
  }
}

function checkHelpHasNoPositional(help: string): void {
  if (help.includes('[ticket-key]')) {
    fail('issue:commit --help still shows [ticket-key] positional');
  } else {
    pass('issue:commit --help does not show [ticket-key] positional');
  }
}

function checkOptionsAlphabetical(help: string): void {
  const optionRegex = /^\s+(-\w,\s+)?--([a-z][-a-z]*)/gm;
  const flags: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = optionRegex.exec(help)) !== null) flags.push(m[2]);
  const sorted = [...flags].sort();
  if (JSON.stringify(flags) === JSON.stringify(sorted)) {
    pass(`Options alphabetically ordered: [${flags.join(', ')}]`);
  } else {
    fail(`Options not alphabetical: got [${flags.join(', ')}], expected [${sorted.join(', ')}]`);
  }
}

async function main(): Promise<void> {
  console.log('\n issue:commit --ticket-key flag migration\n');
  const help = getHelpOutput();
  checkHelpShowsTicketKeyFlag(help);
  checkHelpHasNoPositional(help);
  checkOptionsAlphabetical(help);
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

The prompt that would have produced this test:

```txt
// issue-commit-ticket-key-flag.smoke.ts. The `test-` prefix is redundant.
Manual smoke test: issue:commit exposes --ticket-key as a flag, not a positional

Scenario: a user runs `node dist/main.js issue:commit --help` from any directory
and sees `-k, --ticket-key` listed as an option, no `[ticket-key]` positional,
and all options alphabetically ordered by long flag name.

Config under test:
  node dist/main.js issue:commit --help

Verify:
  1. stdout contains `-k, --ticket-key`
  2. stdout does not contain `[ticket-key]`
  3. long flag names in the options list are in alphabetical order
  4. the runner exits 0 when all assertions hold, 1 otherwise

Wire up: execSync `node dist/main.js issue:commit --help` with cwd set to
os.tmpdir() to prove no repo-local state is required; build dist first
(`nest build`) so the compiled CLI path is exercised, not ts-node.

Teardown: none — the test is read-only against dist/.
```

## Conventions carried by the example

- **File naming**: `{feature}.smoke.ts` in `test/manual/`; never a `test-` prefix.
- **Docs header**: every test opens with a block comment stating the run command and a numbered list of what it verifies — the header is the test's documentation.
- **Compiled-path entry**: CLI assertions go through `dist/` (or the installed binary), because ts-node paths hide dist-only failures. A stale `dist/` invalidates the run — build first.
- **One `summarise(counts)` call** at the end is the only place the exit code is decided; individual checks only call `pass`/`fail`.
- **Live-dependency tests** (real AI providers, real APIs) are suffixed `-live` in the filename so cost and flakiness are visible up front.
