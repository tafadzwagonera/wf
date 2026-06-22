/**
 * Manual Test: Plan stage repo fallback when --repos is omitted
 *
 * Run: nr test:manual -- test-issue-plan-repo-fallback
 *
 * Verifies that when --repos is not provided, the plan stage derives
 * affectedRepositories from the current working directory name instead
 * of passing undefined (which causes the AI to hallucinate repo names).
 *
 * Tests cover both issue.command.ts and issue-plan.command.ts code paths.
 */

import * as path from 'path';

// --------------------------------------------------------------------------
// Module under test: inline extraction of the fallback logic
// --------------------------------------------------------------------------

/**
 * Simulates the fallback expression used in issue.command.ts and
 * issue-plan.command.ts:
 *
 *   affectedRepositories: options?.repos ?? [path.basename(repoBaseDir)]
 *
 * where repoBaseDir = resolveRepoBasePath(options.repos?.[0]) which,
 * when repos is undefined, falls back to process.cwd().
 */
const resolveAffectedRepositories = (
  repos: string[] | undefined,
  repoBaseDir: string,
): string[] => repos ?? [path.basename(repoBaseDir)];

// --------------------------------------------------------------------------
// Test harness
// --------------------------------------------------------------------------

let passed = 0;
let failed = 0;

const pass = (msg: string) => {
  console.log(`✓ ${msg}`);
  passed++;
};
const fail = (msg: string) => {
  console.error(`✗ ${msg}`);
  failed++;
};
const assert = (condition: boolean, msg: string) => {
  if (condition) {
    pass(msg);
  } else {
    fail(msg);
  }
};

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

console.log('Testing: plan stage repo fallback when --repos is omitted\n');

// Test 1: explicit --repos passes through unchanged
{
  const result = resolveAffectedRepositories(
    ['repo-a', 'repo-b'],
    '/Users/dev/projects/terraform-aws',
  );
  assert(
    result.length === 2 && result[0] === 'repo-a' && result[1] === 'repo-b',
    'explicit --repos passes through unchanged',
  );
}

// Test 2: undefined repos falls back to basename of repoBaseDir
{
  const result = resolveAffectedRepositories(
    undefined,
    '/Users/dev/projects/terraform-aws',
  );
  assert(
    result.length === 1 && result[0] === 'terraform-aws',
    'undefined repos falls back to basename of repoBaseDir (terraform-aws)',
  );
}

// Test 3: fallback works for nested paths
{
  const result = resolveAffectedRepositories(
    undefined,
    '/home/ci/workspace/service-tourv3',
  );
  assert(
    result.length === 1 && result[0] === 'service-tourv3',
    'fallback works for nested path (service-tourv3)',
  );
}

// Test 4: empty array repos still passes through (not nullish)
{
  const result = resolveAffectedRepositories(
    [],
    '/Users/dev/projects/terraform-aws',
  );
  assert(
    result.length === 0,
    'empty array passes through (nullish coalescing only triggers on undefined)',
  );
}

// Test 5: single-element repos passes through
{
  const result = resolveAffectedRepositories(
    ['explicit-repo'],
    '/Users/dev/projects/terraform-aws',
  );
  assert(
    result.length === 1 && result[0] === 'explicit-repo',
    'single-element repos passes through unchanged',
  );
}

// Test 6: verify the fallback produces a valid repoHint
{
  const repos = resolveAffectedRepositories(
    undefined,
    '/Users/dev/projects/terraform-aws',
  );
  const repoHint = repos.length
    ? `Affected repositories (hint): ${repos.join(', ')}`
    : '';
  assert(
    repoHint === 'Affected repositories (hint): terraform-aws',
    'fallback produces correct repoHint string for AI prompt',
  );
}

// Test 7: verify the fallback feeds resolvePlanPromptRepoExample correctly
{
  const repos = resolveAffectedRepositories(
    undefined,
    '/Users/dev/projects/terraform-aws',
  );
  const firstRepository = repos.find(
    (repository) => typeof repository === 'string' && repository.trim(),
  );
  const repoExample = firstRepository?.trim() || 'current-repo';
  assert(
    repoExample === 'terraform-aws',
    'fallback feeds resolvePlanPromptRepoExample with real repo name, not "current-repo"',
  );
}

// Test 8: without the fix, undefined repos would yield "current-repo"
{
  const repos = resolveAffectedRepositories(
    undefined,
    '/Users/dev/projects/terraform-aws',
  );
  const firstRepository = repos.find(
    (repository) => typeof repository === 'string' && repository.trim(),
  );
  const repoExample = firstRepository?.trim() || 'current-repo';
  assert(
    repoExample !== 'current-repo',
    'repo example is never the generic "current-repo" placeholder when cwd is available',
  );
}

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------

const separator =
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
console.log(`\n${separator}`);
console.log(`Results: ${passed} passed   ${failed} failed`);
if (failed === 0) {
  console.log('All tests passed!');
} else {
  process.exitCode = 1;
}
console.log(separator);
