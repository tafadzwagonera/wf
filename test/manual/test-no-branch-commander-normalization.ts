/**
 * Smoke test: --no-branch commander flag normalization
 *
 * Run: nr test:manual -- test-no-branch-commander-normalization
 *
 * Verifies:
 *   1. Commander maps --no-branch to { branch: false }, not { noBranch: true }
 *   2. Both issue.command.ts and issue-implement.command.ts normalize branch→noBranch
 *   3. handleBranchWorkflow short-circuits --no-branch before source detection
 *   4. promptBranchName no longer owns noBranch handling
 *   5. The IssueOptions and IssueImplementOptions interfaces include `branch?: boolean`
 *   6. User-facing --no-branch help text says "current branch"
 */
import chalk from 'chalk';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  PASS  ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  FAIL  ${message}`));
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
  console.log(chalk.bold('\n--no-branch commander normalization smoke test\n'));

  const issueSource = fs.readFileSync(path.join(__dirname, '../../src/commands/issue.command.ts'), 'utf-8');
  const implementSource = fs.readFileSync(
    path.join(__dirname, '../../src/commands/issue-implement.command.ts'),
    'utf-8'
  );
  const agentSource = fs.readFileSync(path.join(__dirname, '../../src/agents/implementer.agent.ts'), 'utf-8');

  // 1. Commander --no-X behavior produces { branch: false }
  test('commander maps --no-branch to { branch: false }', () => {
    const { Command } = require('commander');
    const cmd = new Command();
    cmd.option('--no-branch', 'test');
    cmd.parse(['node', 'test', '--no-branch']);
    const opts = cmd.opts();
    assert.equal(opts.branch, false, 'branch should be false');
    assert.equal(opts.noBranch, undefined, 'noBranch should not exist');
  });

  // 2. issue.command.ts normalizes branch→noBranch
  test('issue.command.ts contains branch===false normalization', () => {
    assert.ok(issueSource.includes('options.branch === false'), 'Expected branch === false guard in issue.command.ts');
    assert.ok(issueSource.includes('options.noBranch = true'), 'Expected noBranch assignment in issue.command.ts');
  });

  // 3. issue-implement.command.ts normalizes branch→noBranch
  test('issue-implement.command.ts contains branch===false normalization', () => {
    assert.ok(
      implementSource.includes('options.branch === false'),
      'Expected branch === false guard in issue-implement.command.ts'
    );
    assert.ok(
      implementSource.includes('options.noBranch = true'),
      'Expected noBranch assignment in issue-implement.command.ts'
    );
  });

  // 4. handleBranchWorkflow short-circuits before source detection
  test('handleBranchWorkflow short-circuits --no-branch before source detection', () => {
    const noBranchIndex = agentSource.indexOf('if (options.noBranch)');
    const detectIndex = agentSource.indexOf("console.log(chalk.gray('  Detecting source branches...'));");
    assert.ok(noBranchIndex !== -1, 'Expected --no-branch guard in handleBranchWorkflow');
    assert.ok(detectIndex !== -1, 'Expected source detection log in handleBranchWorkflow');
    assert.ok(noBranchIndex < detectIndex, '--no-branch guard should run before source detection');
    assert.ok(
      agentSource.includes('await this.offerPullOnCurrentBranch(current, branchInteractive, cwd);'),
      'Expected current-branch pull helper call in --no-branch path'
    );
  });

  // 5. promptBranchName no longer handles noBranch
  test('promptBranchName no longer handles noBranch directly', () => {
    const start = agentSource.indexOf('private async promptBranchName');
    const promptMethod = agentSource.slice(start, start + 700);
    assert.ok(!promptMethod.includes('if (noBranch)'), 'promptBranchName should not check noBranch');
    assert.ok(!promptMethod.includes('return null'), 'promptBranchName should no longer return null for noBranch');
  });

  // 6. IssueOptions interface includes branch?: boolean
  test('IssueOptions interface includes branch property', () => {
    assert.ok(issueSource.includes('branch?: boolean;'), 'Expected branch?: boolean in IssueOptions');
  });

  // 7. IssueImplementOptions interface includes branch?: boolean
  test('IssueImplementOptions interface includes branch property', () => {
    assert.ok(implementSource.includes('branch?: boolean;'), 'Expected branch?: boolean in IssueImplementOptions');
  });

  // 8. current-branch wording is present in command help text
  test('user-facing help text says current branch', () => {
    assert.ok(
      issueSource.includes('work directly on the current branch'),
      'Expected current-branch wording in issue.command.ts'
    );
    assert.ok(
      implementSource.includes('work directly on the current branch'),
      'Expected current-branch wording in issue-implement.command.ts'
    );
    assert.ok(
      issueSource.includes('stay on the current branch'),
      'Expected current-branch mutual-exclusion wording in issue.command.ts'
    );
    assert.ok(
      implementSource.includes('stay on the current branch'),
      'Expected current-branch mutual-exclusion wording in issue-implement.command.ts'
    );
  });

  // 9. Normalization comment is present (documents the why)
  test('normalization has explanatory comment', () => {
    assert.ok(
      issueSource.includes('Commander maps --no-branch to { branch: false }'),
      'Expected comment explaining commander behavior'
    );
  });

  // 10. parseNoBranch returns false (not true) so commander stores branch: false
  test('parseNoBranch returns false in issue.command.ts', () => {
    const methodMatch = issueSource.match(/parseNoBranch\(\)[^{]*\{[^}]*return\s+(true|false)/);
    assert.ok(methodMatch, 'Expected parseNoBranch method');
    assert.equal(methodMatch[1], 'false', 'parseNoBranch must return false');
  });

  test('parseNoBranch returns false in issue-implement.command.ts', () => {
    const methodMatch = implementSource.match(/parseNoBranch\(\)[^{]*\{[^}]*return\s+(true|false)/);
    assert.ok(methodMatch, 'Expected parseNoBranch method');
    assert.equal(methodMatch[1], 'false', 'parseNoBranch must return false');
  });

  // Summary
  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) {
    process.exit(1);
  }
}

main();
