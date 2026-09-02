/**
 * Smoke test: implementerOptionsSchema Zod migration and re-export chain.
 *
 * Validates that:
 * 1. implementerOptionsSchema parses valid minimal and full options
 * 2. implementerOptionsSchema rejects invalid values (wrong types, unknown modelRouting)
 * 3. ticketArtifactSchema and planArtifactSchema parse valid data (regression guard)
 * 4. The re-export chain from agents/interfaces re-exports the Zod-inferred ImplementerOptions
 * 5. ImplementerOptions inferred type is structurally compatible with consumer call sites
 */

import assert from 'node:assert/strict';
import chalk from 'chalk';

import {
  implementerOptionsSchema,
  ticketArtifactSchema,
  planArtifactSchema,
  resolutionActionSchema,
  modelRoutingSchema,
} from '../../src/shared/schemas/agent.schema';

import type { ImplementerOptions, TicketArtifact, PlanArtifact, ModelRouting } from '../../src/agents/interfaces';

function main(): void {
  let passed = 0;
  let failed = 0;

  const test = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(chalk.green(`  PASS  ${name}`));
      passed++;
    } catch (e: any) {
      console.log(chalk.red(`  FAIL  ${name}: ${e.message}`));
      failed++;
    }
  };

  // --- 1. implementerOptionsSchema parsing ---
  console.log(chalk.bold('\n--- implementerOptionsSchema parsing ---'));

  test('accepts minimal options (trackerName only)', () => {
    const result = implementerOptionsSchema.safeParse({ trackerName: 'jira' });
    assert.ok(result.success, 'Expected parse to succeed');
    assert.equal(result.data.trackerName, 'jira');
  });

  test('accepts full options with all fields', () => {
    const full: ImplementerOptions = {
      trackerName: 'bitbucket',
      repoDir: '/tmp/repo',
      additionalRepoDirs: ['/tmp/other-repo'],
      suppressHeader: true,
      conversationContext: 'prior context',
      customBranchSlug: 'my-feature',
      allowMultiRepoScope: true,
      modelRouting: 'auto',
      silent: false,
      noBranch: true,
      branchNamePattern: '^(feature|bugfix)/',
      priorStageSummary: 'Plan summary here',
      resumeProviderSessionId: 'session-abc-123',
    };
    const result = implementerOptionsSchema.safeParse(full);
    assert.ok(result.success, 'Expected parse to succeed');
    assert.equal(result.data.repoDir, '/tmp/repo');
    assert.equal(result.data.modelRouting, 'auto');
    assert.equal(result.data.noBranch, true);
  });

  test('rejects missing required trackerName', () => {
    const result = implementerOptionsSchema.safeParse({});
    assert.ok(!result.success, 'Expected parse to fail');
  });

  test('rejects non-string trackerName', () => {
    const result = implementerOptionsSchema.safeParse({ trackerName: 42 });
    assert.ok(!result.success, 'Expected parse to fail');
  });

  test('rejects invalid modelRouting value', () => {
    const result = implementerOptionsSchema.safeParse({
      trackerName: 'jira',
      modelRouting: 'invalid-routing',
    });
    assert.ok(!result.success, 'Expected parse to fail');
  });

  test('accepts all valid modelRouting values', () => {
    for (const routing of ['auto', 'default', 'mechanical'] as ModelRouting[]) {
      const result = implementerOptionsSchema.safeParse({
        trackerName: 'jira',
        modelRouting: routing,
      });
      assert.ok(result.success, `Expected '${routing}' to succeed`);
    }
  });

  test('rejects non-boolean for boolean fields', () => {
    const result = implementerOptionsSchema.safeParse({
      trackerName: 'jira',
      silent: 'yes',
    });
    assert.ok(!result.success, 'Expected parse to fail for string in boolean field');
  });

  test('rejects non-array for additionalRepoDirs', () => {
    const result = implementerOptionsSchema.safeParse({
      trackerName: 'jira',
      additionalRepoDirs: '/single/path',
    });
    assert.ok(!result.success, 'Expected parse to fail for string in array field');
  });

  // --- 2. ticketArtifactSchema regression ---
  console.log(chalk.bold('\n--- ticketArtifactSchema regression ---'));

  test('ticketArtifactSchema accepts valid ticket', () => {
    const ticket: TicketArtifact = {
      ticketKey: 'WBP-1000',
      content: 'Fix the build',
      path: '/tmp/.wf/state/WBP-1000.md',
    };
    const result = ticketArtifactSchema.safeParse(ticket);
    assert.ok(result.success, 'Expected parse to succeed');
  });

  test('ticketArtifactSchema accepts optional fromCache', () => {
    const result = ticketArtifactSchema.safeParse({
      ticketKey: 'WBP-1000',
      content: 'Fix the build',
      path: '/tmp/.wf/state/WBP-1000.md',
      fromCache: true,
    });
    assert.ok(result.success, 'Expected parse to succeed');
  });

  test('ticketArtifactSchema rejects missing content', () => {
    const result = ticketArtifactSchema.safeParse({
      ticketKey: 'WBP-1000',
      path: '/tmp/.wf/state/WBP-1000.md',
    });
    assert.ok(!result.success, 'Expected parse to fail');
  });

  // --- 3. planArtifactSchema regression ---
  console.log(chalk.bold('\n--- planArtifactSchema regression ---'));

  test('planArtifactSchema accepts valid plan artifact', () => {
    const planArtifact: PlanArtifact = {
      plan: {
        action: 'fix',
        summary: 'Fix the build',
        steps: ['Step 1'],
        estimatedComplexity: 'low',
      },
      action: 'fix',
      path: '/tmp/.wf/state/WBP-1000-plan.md',
    };
    const result = planArtifactSchema.safeParse(planArtifact);
    assert.ok(result.success, 'Expected parse to succeed');
  });

  test('planArtifactSchema rejects invalid action', () => {
    const result = planArtifactSchema.safeParse({
      plan: {
        action: 'fix',
        summary: 'Fix',
        steps: ['Step 1'],
        estimatedComplexity: 'low',
      },
      action: 'destroy',
      path: '/tmp/plan.md',
    });
    assert.ok(!result.success, 'Expected parse to fail');
  });

  // --- 4. Re-export chain ---
  console.log(chalk.bold('\n--- Re-export chain ---'));

  test('resolutionActionSchema values match expected set', () => {
    const values = resolutionActionSchema.options;
    assert.deepEqual(values, ['feature', 'fix', 'investigate']);
  });

  test('modelRoutingSchema values match expected set', () => {
    const values = modelRoutingSchema.options;
    assert.deepEqual(values, ['auto', 'default', 'mechanical']);
  });

  test('implementerOptionsSchema shape keys match original interface fields', () => {
    const keys = Object.keys(implementerOptionsSchema.shape).sort();
    const expected = [
      'additionalRepoDirs',
      'allowMultiRepoScope',
      'branchNamePattern',
      'conversationContext',
      'customBranchSlug',
      'initialPromptOverride',
      'isNewRepo',
      'modelRouting',
      'noBranch',
      'priorStageSummary',
      'repoDir',
      'resumeProviderSessionId',
      'silent',
      'suppressHeader',
      'trackerName',
    ];
    assert.deepEqual(keys, expected);
  });

  // --- Summary ---
  console.log(chalk.bold(`\n--- Results: ${passed} passed, ${failed} failed ---`));
  if (failed > 0) {
    process.exit(1);
  }
}

main();
