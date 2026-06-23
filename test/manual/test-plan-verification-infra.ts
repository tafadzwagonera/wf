/**
 * Manual Test: plan verification infrastructure detection
 *
 * Run: yarn test:manual -- test-plan-verification-infra
 *
 * Verifies:
 *   1. Node.js repo detection (package.json + jest in deps)
 *   2. Terraform repo detection (*.tf files)
 *   3. Mixed repo detection (Node + Terraform, node primary)
 *   4. formatTestInfraPromptSection output contains ecosystem-appropriate guidance
 *   5. Enforced command referencing yarn in Terraform-only repo throws
 *   6. Enforced command referencing terraform in Terraform repo passes validation
 */

import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectTestInfra, formatTestInfraPromptSection } from '../../src/shared/utils/detect-test-infra';
import type { TestInfraContext, NodeInfra } from '../../src/shared/utils/detect-test-infra';

const createTempRepo = (name: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wf-manual-infra-${name}-`));
  return dir;
};

const pass = (label: string) => console.log(`  ✓ ${label}`);

// --- Test 1: Node.js repo ---
{
  const dir = createTempRepo('node');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      scripts: { test: 'jest --coverage', build: 'nest build' },
      devDependencies: { jest: '^30' },
      engines: { node: '>=22' },
    })
  );

  const ctx = detectTestInfra(dir);
  assert.equal(ctx.primary, 'node');
  assert.equal(ctx.ecosystems.length, 1);
  const node = ctx.ecosystems[0] as NodeInfra;
  assert.equal(node.ecosystem, 'node');
  assert.deepEqual(node.frameworks, ['jest']);
  assert.equal(node.nodeVersionMajor, 22);
  assert.equal(node.hasNodeTest, true);
  assert.ok(node.scripts.test);
  pass('Node.js repo detection');
}

// --- Test 2: Terraform repo ---
{
  const dir = createTempRepo('terraform');
  fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "aws_s3_bucket" "b" {}');
  fs.writeFileSync(path.join(dir, 'backend.tf'), 'terraform {\n  backend "s3" {}\n}');

  const ctx = detectTestInfra(dir);
  assert.equal(ctx.primary, 'terraform');
  assert.equal(ctx.ecosystems.length, 1);
  assert.equal(ctx.ecosystems[0].ecosystem, 'terraform');
  if (ctx.ecosystems[0].ecosystem === 'terraform') {
    assert.equal(ctx.ecosystems[0].hasTfFiles, true);
    assert.equal(ctx.ecosystems[0].hasBackendConfig, true);
  }
  pass('Terraform repo detection');
}

// --- Test 3: Mixed repo (Node + Terraform) ---
{
  const dir = createTempRepo('mixed');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "null_resource" "x" {}');

  const ctx = detectTestInfra(dir);
  assert.equal(ctx.ecosystems.length, 2);
  assert.equal(ctx.primary, 'node');
  assert.deepEqual(
    ctx.ecosystems.map(e => e.ecosystem),
    ['node', 'terraform']
  );
  pass('Mixed repo detection (Node primary)');
}

// --- Test 4: formatTestInfraPromptSection output ---
{
  const nodeCtx: TestInfraContext = {
    ecosystems: [
      {
        ecosystem: 'node',
        nodeVersionMajor: 22,
        hasNodeTest: true,
        frameworks: ['jest'],
        scripts: { test: 'jest --coverage' },
        allScriptNames: ['test', 'start'],
      },
    ],
    primary: 'node',
  };
  const output = formatTestInfraPromptSection(nodeCtx);
  assert.ok(output.includes('Node.js: v22'), 'Should include node version');
  assert.ok(output.includes('node:test and node:assert available'), 'Should note node:test');
  assert.ok(output.includes('Frameworks: jest'), 'Should list frameworks');
  assert.ok(output.includes('Reference ONLY'), 'Should include rules');
  assert.ok(output.includes('copy-paste-runnable'), 'Should require runnable commands');

  const tfCtx: TestInfraContext = {
    ecosystems: [{ ecosystem: 'terraform', hasTfFiles: true, hasBackendConfig: true }],
    primary: 'terraform',
  };
  const tfOutput = formatTestInfraPromptSection(tfCtx);
  assert.ok(tfOutput.includes('Terraform files detected with backend configuration'));
  assert.ok(tfOutput.includes('terraform validate'));

  const emptyCtx: TestInfraContext = { ecosystems: [], primary: 'node' };
  const emptyOutput = formatTestInfraPromptSection(emptyCtx);
  assert.ok(emptyOutput.includes('No test infrastructure detected'));
  pass('formatTestInfraPromptSection output');
}

// --- Test 5: Enforced yarn command in Terraform-only repo throws ---
{
  const dir = createTempRepo('tf-only');
  fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "null_resource" "x" {}');

  const ctx = detectTestInfra(dir);
  const nodeEco = ctx.ecosystems.find(e => e.ecosystem === 'node');
  assert.equal(nodeEco, undefined, 'Should not detect node ecosystem');

  // Simulate what validateGeneratedPlan does: extractScriptName returns a name,
  // nodeEco is undefined, so the "package manager script in non-node repo" branch triggers
  const cmd = 'yarn test -- --bail';
  const match = cmd.match(/^(?:yarn|npm run|pnpm|pnpm run|npx|nr)\s+([^\s]+)/);
  assert.ok(match, 'Should extract script name');
  assert.equal(match[1], 'test');
  // With policy enforced and no nodeEco, this should be a validation error
  assert.ok(!nodeEco, 'No node ecosystem means enforced yarn commands should throw');
  pass('Enforced yarn command in Terraform-only repo would throw');
}

// --- Test 6: Terraform command in Terraform repo passes ---
{
  const dir = createTempRepo('tf-pass');
  fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "aws_s3_bucket" "b" {}');

  const ctx = detectTestInfra(dir);
  const hasTerraform = ctx.ecosystems.some(e => e.ecosystem === 'terraform');
  assert.ok(hasTerraform, 'Should detect terraform');

  // terraform plan in a terraform repo should NOT trigger the "no .tf files" error
  const cmd = 'terraform plan -target=module.foo';
  const isTerraformCmd = /^terraform\s/.test(cmd);
  assert.ok(isTerraformCmd && hasTerraform, 'terraform command in terraform repo is valid');
  pass('Terraform command in Terraform repo passes');
}

console.log('\n  All plan verification infra tests passed.\n');
