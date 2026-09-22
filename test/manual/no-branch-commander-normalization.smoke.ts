/**
 * Smoke test: --no-branch commander flag normalization
 *
 * Run: nr test:manual no-branch-commander-normalization.smoke.ts
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
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const issueSource = fs.readFileSync(path.join(__dirname, '../../src/commands/issue.command.ts'), 'utf-8');
const implementSource = fs.readFileSync(path.join(__dirname, '../../src/commands/issue-implement.command.ts'), 'utf-8');
const agentSource = fs.readFileSync(path.join(__dirname, '../../src/agents/implementer.agent.ts'), 'utf-8');

const test = (label: string, fn: () => void): void => {
  try {
    fn();
    pass(label);
  } catch (err) {
    fail(label, (err as Error).message);
  }
};

function checkCommanderMapsNoBranch(): void {
  test('commander maps --no-branch to { branch: false }', () => {
    const { Command } = require('commander');
    const cmd = new Command();
    cmd.option('--no-branch', 'test');
    cmd.parse(['node', 'test', '--no-branch']);
    const opts = cmd.opts();
    assert.equal(opts.branch, false, 'branch should be false');
    assert.equal(opts.noBranch, undefined, 'noBranch should not exist');
  });
}

function checkIssueCommandNormalizesNoBranch(): void {
  test('issue.command.ts contains branch===false normalization', () => {
    assert.ok(issueSource.includes('options?.branch === false'), 'Expected branch === false guard in issue.command.ts');
    assert.ok(issueSource.includes('options.noBranch = true'), 'Expected noBranch assignment in issue.command.ts');
  });
}

function checkImplementCommandNormalizesNoBranch(): void {
  test('issue-implement.command.ts contains branch===false normalization', () => {
    assert.ok(implementSource.includes('options?.branch === false'), 'Expected branch === false guard in issue-implement.command.ts');
    assert.ok(implementSource.includes('options.noBranch = true'), 'Expected noBranch assignment in issue-implement.command.ts');
  });
}

function checkHandleBranchWorkflowShortCircuits(): void {
  test('handleBranchWorkflow short-circuits --no-branch before source detection', () => {
    const noBranchIndex = agentSource.indexOf('if (options.noBranch)');
    const detectIndex = agentSource.indexOf('console.log(chalk.gray(\'  Detecting source branches...\'));');
    assert.ok(noBranchIndex !== -1, 'Expected --no-branch guard in handleBranchWorkflow');
    assert.ok(detectIndex !== -1, 'Expected source detection log in handleBranchWorkflow');
    assert.ok(noBranchIndex < detectIndex, '--no-branch guard should run before source detection');
    assert.ok(agentSource.includes('return this.handleStayPath(current, planArtifact, options, isTTY, stashInteractive, cwd);'), 'Expected stay-path helper call in --no-branch path');
  });
}

function checkPromptBranchNameNoLongerHandlesNoBranch(): void {
  test('promptBranchName no longer handles noBranch directly', () => {
    const start = agentSource.indexOf('private async promptBranchName');
    const promptMethod = agentSource.slice(start, start + 700);
    assert.ok(!promptMethod.includes('if (noBranch)'), 'promptBranchName should not check noBranch');
    assert.ok(!promptMethod.includes('return null'), 'promptBranchName should no longer return null for noBranch');
  });
}

function checkIssueOptionsHasBranch(): void {
  test('IssueOptions interface includes branch property', () => {
    assert.ok(issueSource.includes('branch?: boolean;'), 'Expected branch?: boolean in IssueOptions');
  });
}

function checkImplementOptionsHasBranch(): void {
  test('IssueImplementOptions interface includes branch property', () => {
    assert.ok(implementSource.includes('branch?: boolean;'), 'Expected branch?: boolean in IssueImplementOptions');
  });
}

function checkHelpTextSaysCurrentBranch(): void {
  test('user-facing help text says current branch', () => {
    assert.ok(issueSource.includes('work directly on the current branch'), 'Expected current-branch wording in issue.command.ts');
    assert.ok(implementSource.includes('work directly on the current branch'), 'Expected current-branch wording in issue-implement.command.ts');
    assert.ok(issueSource.includes('stay on the current branch'), 'Expected current-branch mutual-exclusion wording in issue.command.ts');
    assert.ok(implementSource.includes('stay on the current branch'), 'Expected current-branch mutual-exclusion wording in issue-implement.command.ts');
  });
}

function checkParseNoBranchReturnsFalseInIssue(): void {
  test('parseNoBranch returns false in issue.command.ts', () => {
    const methodMatch = /parseNoBranch\(\)[^{]*\{[^}]*return\s+(true|false)/.exec(issueSource);
    assert.ok(methodMatch, 'Expected parseNoBranch method');
    assert.equal(methodMatch[1], 'false', 'parseNoBranch must return false');
  });
}

function checkParseNoBranchReturnsFalseInImplement(): void {
  test('parseNoBranch returns false in issue-implement.command.ts', () => {
    const methodMatch = /parseNoBranch\(\)[^{]*\{[^}]*return\s+(true|false)/.exec(implementSource);
    assert.ok(methodMatch, 'Expected parseNoBranch method');
    assert.equal(methodMatch[1], 'false', 'parseNoBranch must return false');
  });
}

function main(): void {
  console.log(chalk.bold('\n--no-branch commander normalization smoke test\n'));
  checkCommanderMapsNoBranch();
  checkIssueCommandNormalizesNoBranch();
  checkImplementCommandNormalizesNoBranch();
  checkHandleBranchWorkflowShortCircuits();
  checkPromptBranchNameNoLongerHandlesNoBranch();
  checkIssueOptionsHasBranch();
  checkImplementOptionsHasBranch();
  checkHelpTextSaysCurrentBranch();
  checkParseNoBranchReturnsFalseInIssue();
  checkParseNoBranchReturnsFalseInImplement();
  summarise(counts);
}

main();
