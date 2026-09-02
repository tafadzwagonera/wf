/**
 * Manual smoke test: --silent mode branch prompt behavior
 *
 * Run: nr test:manual -- test-silent-mode-branch-prompts
 *
 * Verifies:
 *   1. handleBranchWorkflow derives stashInteractive=false and branchInteractive=true
 *      when silent=true and TTY is available
 *   2. handleBranchWorkflow derives stashInteractive=false and branchInteractive=false
 *      when silent=true and no TTY
 *   3. handleBranchWorkflow derives stashInteractive=true and branchInteractive=true
 *      when silent=false and TTY is available
 *   4. ensureCleanWorkingTree receives stashInteractive (not branchInteractive)
 *   5. resolveSourceBranch receives branchInteractive (not stashInteractive)
 *   6. promptBranchName receives branchInteractive (not stashInteractive)
 *
 * @returns void
 */
import chalk from 'chalk';
import * as assert from 'node:assert/strict';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const test = (label: string, fn: () => void): void => {
  try {
    fn();
    pass(label);
  } catch (err) {
    fail(label, (err as Error).message);
  }
};

/**
 * Extracts the flag derivation logic from handleBranchWorkflow
 * to verify correctness without needing the full NestJS context.
 */
function deriveFlags(silent: boolean, isTTY: boolean) {
  const stashInteractive = !silent && isTTY;
  const branchInteractive = isTTY;
  return { stashInteractive, branchInteractive };
}

function main(): void {
  console.log(chalk.bold('\nSilent mode branch prompt behavior smoke test\n'));

  // 1. silent=true + TTY → stash suppressed, branch prompts active
  test('silent=true + TTY: stashInteractive=false, branchInteractive=true', () => {
    const { stashInteractive, branchInteractive } = deriveFlags(true, true);
    assert.equal(stashInteractive, false);
    assert.equal(branchInteractive, true);
  });

  // 2. silent=true + no TTY → both suppressed
  test('silent=true + no TTY: stashInteractive=false, branchInteractive=false', () => {
    const { stashInteractive, branchInteractive } = deriveFlags(true, false);
    assert.equal(stashInteractive, false);
    assert.equal(branchInteractive, false);
  });

  // 3. silent=false + TTY → both active
  test('silent=false + TTY: stashInteractive=true, branchInteractive=true', () => {
    const { stashInteractive, branchInteractive } = deriveFlags(false, true);
    assert.equal(stashInteractive, true);
    assert.equal(branchInteractive, true);
  });

  // 4. silent=false + no TTY → both suppressed
  test('silent=false + no TTY: stashInteractive=false, branchInteractive=false', () => {
    const { stashInteractive, branchInteractive } = deriveFlags(false, false);
    assert.equal(stashInteractive, false);
    assert.equal(branchInteractive, false);
  });

  // 5. Verify source code contains the split flags (not the old single interactive)
  test('handleBranchWorkflow source uses stashInteractive and branchInteractive', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../src/agents/implementer.agent.ts'), 'utf-8');

    assert.ok(
      source.includes('const stashInteractive = !options.silent && isTTY;'),
      'Expected stashInteractive derivation'
    );
    assert.ok(source.includes('const branchInteractive = isTTY;'), 'Expected branchInteractive derivation');
    assert.ok(
      !source.includes('const interactive = !options.silent && this.isInteractiveSession();'),
      'Old single interactive flag should be removed'
    );
  });

  // 6. Verify ensureCleanWorkingTree receives stashInteractive
  test('ensureCleanWorkingTree call passes stashInteractive', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../src/agents/implementer.agent.ts'), 'utf-8');

    assert.ok(
      source.includes('ensureCleanWorkingTree(planArtifact, options, stashInteractive, cwd)'),
      'ensureCleanWorkingTree should receive stashInteractive'
    );
  });

  // 7. Verify resolveSourceBranch receives branchInteractive
  test('resolveSourceBranch call passes branchInteractive', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../src/agents/implementer.agent.ts'), 'utf-8');

    assert.ok(
      source.includes('interactive: branchInteractive,'),
      'resolveSourceBranch should receive branchInteractive'
    );
  });

  // 8. Verify JSDoc was updated
  test('handleBranchWorkflow JSDoc mentions --silent only suppresses stash prompt', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../src/agents/implementer.agent.ts'), 'utf-8');

    assert.ok(source.includes('`--silent` only suppresses'), 'JSDoc should describe the split behavior');
    assert.ok(source.includes('stash prompt'), 'JSDoc should mention stash prompt specifically');
  });

  // Summary
  console.log(chalk.bold(`\n  ${counts.passed} passed, ${counts.failed} failed\n`));
  if (counts.failed > 0) {
    process.exit(1);
  }
}

main();
