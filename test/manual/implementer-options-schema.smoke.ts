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
} from '../../src/common/schemas/agent.schema';

import type { ImplementerOptions, TicketArtifact, PlanArtifact, ModelRouting } from '../../src/agents/interfaces';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const testCase = (name: string, fn: () => void): void => {
  try {
    fn();
    pass(name);
  } catch (e: any) {
    fail(name, e.message);
  }
};

function testAcceptsMinimalOptions(): void {
  testCase('accepts minimal options (trackerName only)', () => {
    const result = implementerOptionsSchema.safeParse({ trackerName: 'jira' });
    assert.ok(result.success, 'Expected parse to succeed');
    assert.equal(result.data.trackerName, 'jira');
  });
}

function testAcceptsFullOptions(): void {
  testCase('accepts full options with all fields', () => {
    const full: ImplementerOptions = {
      trackerName: 'bitbucket', repoDir: '/tmp/repo', additionalRepoDirs: ['/tmp/other-repo'],
      suppressHeader: true, conversationContext: 'prior context', customBranchSlug: 'my-feature',
      allowMultiRepoScope: true, modelRouting: 'auto', silent: false, noBranch: true,
      branchNamePattern: '^(feature|bugfix)/', priorStageSummary: 'Plan summary here', resumeProviderSessionId: 'session-abc-123',
    };
    const result = implementerOptionsSchema.safeParse(full);
    assert.ok(result.success, 'Expected parse to succeed');
    assert.equal(result.data.repoDir, '/tmp/repo');
    assert.equal(result.data.modelRouting, 'auto');
    assert.equal(result.data.noBranch, true);
  });
}

function testRejectsMissingTrackerName(): void {
  testCase('rejects missing required trackerName', () => {
    const result = implementerOptionsSchema.safeParse({});
    assert.ok(!result.success, 'Expected parse to fail');
  });
}

function testRejectsNonStringTrackerName(): void {
  testCase('rejects non-string trackerName', () => {
    const result = implementerOptionsSchema.safeParse({ trackerName: 42 });
    assert.ok(!result.success, 'Expected parse to fail');
  });
}

function testRejectsInvalidModelRouting(): void {
  testCase('rejects invalid modelRouting value', () => {
    const result = implementerOptionsSchema.safeParse({ trackerName: 'jira', modelRouting: 'invalid-routing' });
    assert.ok(!result.success, 'Expected parse to fail');
  });
}

function testAcceptsAllValidModelRoutings(): void {
  testCase('accepts all valid modelRouting values', () => {
    for (const routing of ['auto', 'default', 'mechanical'] as ModelRouting[]) {
      const result = implementerOptionsSchema.safeParse({ trackerName: 'jira', modelRouting: routing });
      assert.ok(result.success, `Expected '${routing}' to succeed`);
    }
  });
}

function testRejectsNonBooleanForBooleanFields(): void {
  testCase('rejects non-boolean for boolean fields', () => {
    const result = implementerOptionsSchema.safeParse({ trackerName: 'jira', silent: 'yes' });
    assert.ok(!result.success, 'Expected parse to fail for string in boolean field');
  });
}

function testRejectsNonArrayForAdditionalRepoDirs(): void {
  testCase('rejects non-array for additionalRepoDirs', () => {
    const result = implementerOptionsSchema.safeParse({ trackerName: 'jira', additionalRepoDirs: '/single/path' });
    assert.ok(!result.success, 'Expected parse to fail for string in array field');
  });
}

function testTicketArtifactAcceptsValid(): void {
  testCase('ticketArtifactSchema accepts valid ticket', () => {
    const ticket: TicketArtifact = { ticketKey: 'WBP-1000', content: 'Fix the build', path: '/tmp/.wf/state/WBP-1000.md' };
    const result = ticketArtifactSchema.safeParse(ticket);
    assert.ok(result.success, 'Expected parse to succeed');
  });
}

function testTicketArtifactAcceptsOptionalFromCache(): void {
  testCase('ticketArtifactSchema accepts optional fromCache', () => {
    const result = ticketArtifactSchema.safeParse({ ticketKey: 'WBP-1000', content: 'Fix the build', path: '/tmp/.wf/state/WBP-1000.md', fromCache: true });
    assert.ok(result.success, 'Expected parse to succeed');
  });
}

function testTicketArtifactRejectsMissingContent(): void {
  testCase('ticketArtifactSchema rejects missing content', () => {
    const result = ticketArtifactSchema.safeParse({ ticketKey: 'WBP-1000', path: '/tmp/.wf/state/WBP-1000.md' });
    assert.ok(!result.success, 'Expected parse to fail');
  });
}

function testPlanArtifactAcceptsValid(): void {
  testCase('planArtifactSchema accepts valid plan artifact', () => {
    const planArtifact: PlanArtifact = {
      plan: { action: 'fix', summary: 'Fix the build', steps: [{ description: 'Step 1' }], estimatedComplexity: 'low' },
      action: 'fix',
      path: '/tmp/.wf/state/WBP-1000-plan.md',
    };
    const result = planArtifactSchema.safeParse(planArtifact);
    assert.ok(result.success, 'Expected parse to succeed');
  });
}

function testPlanArtifactRejectsInvalidAction(): void {
  testCase('planArtifactSchema rejects invalid action', () => {
    const result = planArtifactSchema.safeParse({ plan: { action: 'fix', summary: 'Fix', steps: [{ description: 'Step 1' }], estimatedComplexity: 'low' }, action: 'destroy', path: '/tmp/plan.md' });
    assert.ok(!result.success, 'Expected parse to fail');
  });
}

function testResolutionActionSchemaValues(): void {
  testCase('resolutionActionSchema values match expected set', () => {
    const values = resolutionActionSchema.options;
    assert.deepEqual(values, ['feature', 'fix', 'investigate']);
  });
}

function testModelRoutingSchemaValues(): void {
  testCase('modelRoutingSchema values match expected set', () => {
    const values = modelRoutingSchema.options;
    assert.deepEqual(values, ['auto', 'default', 'mechanical']);
  });
}

function testImplementerOptionsSchemaShapeKeys(): void {
  testCase('implementerOptionsSchema shape keys match original interface fields', () => {
    const keys = Object.keys(implementerOptionsSchema.shape).sort();
    const expected = [
      'additionalRepoDirs', 'allowMultiRepoScope', 'branchNamePattern', 'conversationContext',
      'customBranchSlug', 'figma', 'initialPromptOverride', 'isNewRepo', 'modelRouting', 'noBranch',
      'onRecords', 'priorStageSummary', 'repoDir', 'resumeProviderSessionId', 'silent', 'skipInstall',
      'suppressHeader', 'trackerName',
    ];
    assert.deepEqual(keys, expected);
  });
}

function checkImplementerOptionsSchemaBaseCases(): void {
  console.log(chalk.bold('\n--- implementerOptionsSchema parsing ---'));
  testAcceptsMinimalOptions();
  testAcceptsFullOptions();
  testRejectsMissingTrackerName();
  testRejectsNonStringTrackerName();
}

function checkImplementerOptionsSchemaValidation(): void {
  testRejectsInvalidModelRouting();
  testAcceptsAllValidModelRoutings();
  testRejectsNonBooleanForBooleanFields();
  testRejectsNonArrayForAdditionalRepoDirs();
}

function checkTicketArtifactSchema(): void {
  console.log(chalk.bold('\n--- ticketArtifactSchema regression ---'));
  testTicketArtifactAcceptsValid();
  testTicketArtifactAcceptsOptionalFromCache();
  testTicketArtifactRejectsMissingContent();
}

function checkPlanArtifactSchema(): void {
  console.log(chalk.bold('\n--- planArtifactSchema regression ---'));
  testPlanArtifactAcceptsValid();
  testPlanArtifactRejectsInvalidAction();
}

function checkReExportChain(): void {
  console.log(chalk.bold('\n--- Re-export chain ---'));
  testResolutionActionSchemaValues();
  testModelRoutingSchemaValues();
  testImplementerOptionsSchemaShapeKeys();
}

function main(): void {
  checkImplementerOptionsSchemaBaseCases();
  checkImplementerOptionsSchemaValidation();
  checkTicketArtifactSchema();
  checkPlanArtifactSchema();
  checkReExportChain();
  summarise(counts);
}

main();
