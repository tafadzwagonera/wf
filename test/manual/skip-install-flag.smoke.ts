/**
 * Manual smoke test: --skip-install flag suppresses dependency install after pull
 *
 * Run: nr test:manual skip-install-flag.smoke.ts
 *
 * Scenario: Fix C removed the git-diff gate from `runPostPullDependencyInstall`
 * so install runs unconditionally. The `skip?: boolean` param is the explicit
 * escape hatch. This test verifies the param and schema field behave correctly
 * at the live function and schema level.
 *
 * Note: `post-pull-dependency-install.smoke.ts` covers the now-deleted git-diff
 * gate — that test exercises a removed code path and should be retired.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { runPostPullDependencyInstall } from '../../src/shared/utils/post-pull-install';
import { implementerOptionsSchema } from '../../src/shared/schemas/agent.schema';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const captureOutput = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  const restore = (): void => {
    console.log = origLog;
  };
  return { lines, restore };
};

async function checkRuntimeBehaviour(dir: string): Promise<void> {
  const { lines: skipLines, restore: restoreSkip } = captureOutput();
  await runPostPullDependencyInstall(dir, true);
  restoreSkip();
  assert('skip=true produces no output lines', skipLines.length === 0, `got ${skipLines.length} line(s): ${skipLines.join(' | ')}`);

  const { lines: noSkipLines, restore: restoreNoSkip } = captureOutput();
  await runPostPullDependencyInstall(dir, false);
  restoreNoSkip();
  assert('skip=false produces at least one output line (install attempted)', noSkipLines.length > 0, 'expected a result line but got none');

  const { lines: defaultLines, restore: restoreDefault } = captureOutput();
  await runPostPullDependencyInstall(dir);
  restoreDefault();
  assert('skip omitted produces at least one output line (unconditional install)', defaultLines.length > 0, 'expected a result line but got none');
}

function assertSchemaAcceptsTrue(base: { trackerName: string }): void {
  const result = implementerOptionsSchema.safeParse({ ...base, skipInstall: true });
  assert(
    'implementerOptionsSchema accepts skipInstall: true',
    result.success && result.data.skipInstall === true,
    result.success ? `parsed skipInstall=${result.data.skipInstall}` : String(result.error),
  );
}

function assertSchemaAcceptsOmitted(base: { trackerName: string }): void {
  const result = implementerOptionsSchema.safeParse(base);
  assert(
    'implementerOptionsSchema accepts skipInstall omitted (field is optional)',
    result.success && result.data.skipInstall === undefined,
    result.success ? `parsed skipInstall=${result.data.skipInstall}` : String(result.error),
  );
}

function assertSchemaRejectsNonBoolean(base: { trackerName: string }): void {
  const result = implementerOptionsSchema.safeParse({ ...base, skipInstall: 'yes' });
  assert(
    'implementerOptionsSchema rejects skipInstall: "yes" (non-boolean)',
    !result.success,
    'expected ZodError but parse succeeded',
  );
}

function checkSchema(): void {
  const base = { trackerName: 'jira' };
  assertSchemaAcceptsTrue(base);
  assertSchemaAcceptsOmitted(base);
  assertSchemaRejectsNonBoolean(base);
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSkip-install flag smoke test\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-skip-install-'));
  try {
    await checkRuntimeBehaviour(dir);
    checkSchema();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  summarise(counts);
}

main();
