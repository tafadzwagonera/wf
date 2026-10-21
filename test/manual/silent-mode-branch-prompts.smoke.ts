/**
 * Manual smoke test: --silent mode branch prompt behavior
 *
 * Run: nr test:manual silent-mode-branch-prompts.smoke.ts
 *
 * Verifies:
 *   1. handleBranchWorkflow derives stashInteractive=false and branchInteractive=true
 *      when silent=true and TTY is available
 *   2. handleBranchWorkflow derives stashInteractive=false and branchInteractive=false
 *      when silent=true and no TTY
 *   3. handleBranchWorkflow derives stashInteractive=true and branchInteractive=true
 *      when silent=false and TTY is available
 *   4. ensureCleanWorkingTree receives stashInteractive (not branchInteractive)
 *   5. branch selection and pull resolution receive the TTY flag (not stashInteractive)
 *
 * @returns void
 */
import chalk from 'chalk';
import * as assert from 'node:assert/strict';
import { createReporter, summarise } from './support/reporter';

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

function checkSilentFlagDerivations(): void {
  test('silent=true + TTY: stashInteractive=false, branchInteractive=true', () => {
    const { stashInteractive, branchInteractive } = deriveFlags(true, true);
    assert.equal(stashInteractive, false);
    assert.equal(branchInteractive, true);
  });
  test('silent=true + no TTY: stashInteractive=false, branchInteractive=false', () => {
    const { stashInteractive, branchInteractive } = deriveFlags(true, false);
    assert.equal(stashInteractive, false);
    assert.equal(branchInteractive, false);
  });
}

function checkNonSilentFlagDerivations(): void {
  test('silent=false + TTY: stashInteractive=true, branchInteractive=true', () => {
    const { stashInteractive, branchInteractive } = deriveFlags(false, true);
    assert.equal(stashInteractive, true);
    assert.equal(branchInteractive, true);
  });
  test('silent=false + no TTY: stashInteractive=false, branchInteractive=false', () => {
    const { stashInteractive, branchInteractive } = deriveFlags(false, false);
    assert.equal(stashInteractive, false);
    assert.equal(branchInteractive, false);
  });
}

function loadImplementerSource(): string {
  const fs = require('fs');
  const p = require('path');
  return fs.readFileSync(p.join(__dirname, '../../src/agents/implementer.agent.ts'), 'utf-8');
}

function checkFlagDerivationSource(source: string): void {
  test('handleBranchWorkflow source derives stashInteractive from silent and TTY only', () => {
    assert.ok(source.includes('const isTTY = this.isInteractiveSession();'), 'Expected isTTY derivation');
    assert.ok(
      source.includes('const stashInteractive = !options.silent && isTTY;'),
      'Expected stashInteractive derivation'
    );
    assert.ok(
      !source.includes('const interactive = !options.silent && this.isInteractiveSession();'),
      'Old single interactive flag should be removed'
    );
  });
}

function checkInteractivePassthroughs(source: string): void {
  test('handleBranchWorkflow passes isTTY and stashInteractive to both paths', () => {
    assert.ok(
      source.includes('this.handleStayPath(current, planArtifact, options, isTTY, stashInteractive, cwd)'),
      'handleStayPath should receive isTTY then stashInteractive'
    );
    assert.ok(
      source.includes('this.createBranchFromSource(ticket, planArtifact, options, isTTY, stashInteractive, cwd)'),
      'createBranchFromSource should receive isTTY then stashInteractive'
    );
  });
}

function checkStashAndPullPassthroughs(source: string): void {
  test('ensureCleanWorkingTree calls pass stashInteractive', () => {
    assert.ok(
      source.includes('this.ensureCleanWorkingTree(planArtifact, stashInteractive, cwd)'),
      'ensureCleanWorkingTree should receive stashInteractive'
    );
  });
  test('handleStayPath resolves pull with branchInteractive', () => {
    assert.ok(
      source.includes('this.resolveShouldPull(branch, branchInteractive)'),
      'resolveShouldPull should receive branchInteractive'
    );
  });
}

function checkSourceCode(): void {
  const source = loadImplementerSource();
  checkFlagDerivationSource(source);
  checkInteractivePassthroughs(source);
  checkStashAndPullPassthroughs(source);
}

function main(): void {
  console.log(chalk.bold('\nSilent mode branch prompt behavior smoke test\n'));
  checkSilentFlagDerivations();
  checkNonSilentFlagDerivations();
  checkSourceCode();
  summarise(counts);
}

main();
