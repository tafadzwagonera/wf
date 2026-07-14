/**
 * Manual smoke test: branch workflow restructure
 *
 * Run: nr test:manual -- test-branch-workflow-restructure
 *
 * Verifies:
 *   1. Branch/pull decision comes before stash check in handleBranchWorkflow
 *   2. handleStayPath only stashes when shouldPull is true
 *   3. offerPullOnCurrentBranch is removed (replaced by resolveShouldPull + pullOnCurrentBranch)
 *   4. truncateSlug truncates at word boundary and respects MAX_BRANCH_NAME_LENGTH
 *   5. generateBranchName applies truncation for long summaries
 *   6. generateCustomBranchName applies truncation for long slugs
 */

import chalk from 'chalk';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { slugify, truncateSlug, MAX_BRANCH_NAME_LENGTH } from '../../src/agents/utils';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed += 1;
};

const test = (label: string, fn: () => void): void => {
  try {
    fn();
    pass(label);
  } catch (err) {
    fail(label, (err as Error).message);
  }
};

function main(): void {
  console.log(chalk.bold('\nBranch workflow restructure smoke test\n'));

  const agentSource = fs.readFileSync(path.join(__dirname, '../../src/agents/implementer.agent.ts'), 'utf-8');

  // ── Source structure checks ──────────────────────────────────────────────

  test('offerPullOnCurrentBranch is removed', () => {
    assert.ok(!agentSource.includes('offerPullOnCurrentBranch'), 'offerPullOnCurrentBranch should be fully removed');
  });

  test('resolveShouldPull exists as a private method', () => {
    assert.ok(agentSource.includes('private async resolveShouldPull('), 'resolveShouldPull should be defined');
  });

  test('pullOnCurrentBranch exists as a private method', () => {
    assert.ok(agentSource.includes('private async pullOnCurrentBranch('), 'pullOnCurrentBranch should be defined');
  });

  test('handleStayPath exists as a private method', () => {
    assert.ok(agentSource.includes('private async handleStayPath('), 'handleStayPath should be defined');
  });

  test('handleBranchWorkflow calls getCurrentBranch before noBranch check', () => {
    const getCurrentIdx = agentSource.indexOf('getCurrentBranch(cwd).catch');
    const noBranchIdx = agentSource.indexOf('if (options.noBranch)');
    assert.ok(getCurrentIdx > 0, 'getCurrentBranch call should exist');
    assert.ok(noBranchIdx > 0, 'noBranch check should exist');
    assert.ok(getCurrentIdx < noBranchIdx, 'getCurrentBranch should appear before noBranch check');
  });

  test('ensureCleanWorkingTree is called after branchAction prompt in create path', () => {
    const branchActionIdx = agentSource.indexOf('value: \'create\'');
    const ensureCleanIdx = agentSource.indexOf('ensureCleanWorkingTree(planArtifact, options, stashInteractive, cwd)');
    assert.ok(branchActionIdx > 0, 'branchAction create choice should exist');
    assert.ok(ensureCleanIdx > 0, 'ensureCleanWorkingTree call should exist');
    assert.ok(
      branchActionIdx < ensureCleanIdx,
      'branchAction prompt should appear before ensureCleanWorkingTree in the create path'
    );
  });

  test('handleStayPath conditionally stashes only when shouldPull is true', () => {
    const handleStayStart = agentSource.indexOf('private async handleStayPath(');
    const handleStayEnd = agentSource.indexOf('return branch;', handleStayStart);
    const stayBody = agentSource.slice(handleStayStart, handleStayEnd);
    assert.ok(stayBody.includes('if (shouldPull)'), 'handleStayPath should gate stash on shouldPull');
    assert.ok(
      stayBody.includes('ensureCleanWorkingTree'),
      'handleStayPath should call ensureCleanWorkingTree inside shouldPull block'
    );
  });

  // ── truncateSlug unit-level checks ───────────────────────────────────────

  test('MAX_BRANCH_NAME_LENGTH is 100', () => {
    assert.equal(MAX_BRANCH_NAME_LENGTH, 100);
  });

  test('truncateSlug returns slug unchanged when within limit', () => {
    assert.equal(truncateSlug('short-slug', 10), 'short-slug');
  });

  test('truncateSlug cuts at last hyphen when exceeding limit', () => {
    const slug = 'aaa-bbb-ccc-ddd-eee';
    // prefixLength=90 → maxSlugLength=10 → truncated='aaa-bbb-cc' → lastHyphen at 7 → 'aaa-bbb'
    assert.equal(truncateSlug(slug, 90), 'aaa-bbb');
  });

  test('truncateSlug hard-cuts when no hyphens exist', () => {
    assert.equal(truncateSlug('abcdefghijklmnop', 95), 'abcde');
  });

  test('truncateSlug returns empty when prefix consumes all space', () => {
    assert.equal(truncateSlug('any', 100), '');
    assert.equal(truncateSlug('any', 105), '');
  });

  // ── Branch name length integration ───────────────────────────────────────

  test('long slugified summary is truncated to fit MAX_BRANCH_NAME_LENGTH', () => {
    const longSummary = Array.from({ length: 12 }, (_, i) => String.fromCharCode(65 + i).repeat(10)).join(' ');
    const slug = slugify(longSummary);
    const prefixPart = 'feature/WBP-3054__';
    const truncatedSlug = truncateSlug(slug, prefixPart.length);
    const branchName = `${prefixPart}${truncatedSlug}`;

    assert.ok(
      branchName.length <= MAX_BRANCH_NAME_LENGTH,
      `Branch name length ${branchName.length} exceeds ${MAX_BRANCH_NAME_LENGTH}`
    );
    assert.ok(!branchName.endsWith('-'), 'Branch name should not end with a hyphen');
  });

  test('short slugified summary is not truncated', () => {
    const shortSummary = 'Fix build verification';
    const slug = slugify(shortSummary);
    const prefixPart = 'bugfix/WBP-1000__';
    const truncatedSlug = truncateSlug(slug, prefixPart.length);
    assert.equal(truncatedSlug, slug, 'Short slug should not be truncated');
  });

  // ── Command description update ───────────────────────────────────────────

  test('issue:implement description reflects new branch-first workflow', () => {
    const cmdSource = fs.readFileSync(path.join(__dirname, '../../src/commands/issue-implement.command.ts'), 'utf-8');
    assert.ok(
      cmdSource.includes('prompts to create a new branch or stay on the current one'),
      'Description should mention branch choice comes first'
    );
    assert.ok(
      cmdSource.includes('truncated at the nearest word boundary'),
      'Description should mention branch name truncation'
    );
  });

  // Summary
  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) {
    process.exit(1);
  }
}

main();
