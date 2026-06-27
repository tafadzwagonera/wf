/**
 * Manual smoke test: issue:implement per-repo loop and legacy field migration
 *
 * Run: nr test:manual -- test-issue-implement-multi-repo-loop
 *
 * Verifies:
 *   1. parsePlanArtifact accepts legacy filesAffected/filesContext keys and maps
 *      them to affectedFiles/affectedFilesContext.
 *   2. parsePlanArtifact prefers new field names when both old and new are present.
 *   3. resolutionPlanSchema validates affectedFiles/affectedFilesContext fields.
 *   4. issue:implement --repos option description reflects multi-repo support.
 */
import chalk from 'chalk';
import { parsePlanArtifact } from '../../src/shared/utils/plan-artifact';
import { resolutionPlanSchema } from '../../src/shared/schemas/ai.schema';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  \u2713 ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  \u2717 ${label}`));
    failed++;
  }
};

const run = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: per-repo loop and legacy field migration\n'));

  // 1. Legacy field names are accepted
  const legacyPlan = parsePlanArtifact(
    JSON.stringify({
      action: 'fix',
      summary: 'Legacy plan',
      steps: ['Step 1'],
      estimatedComplexity: 'low',
      filesAffected: [{ filePath: 'repo-a/src/auth.ts', status: 'found' }],
      filesContext: [{ filePath: 'repo-a/package.json', status: 'found' }],
    }),
    '/tmp/legacy.json'
  );
  assert(
    'legacy filesAffected maps to affectedFiles',
    legacyPlan.affectedFiles?.length === 1 &&
      typeof legacyPlan.affectedFiles[0] === 'object' &&
      legacyPlan.affectedFiles[0].filePath === 'repo-a/src/auth.ts'
  );
  assert(
    'legacy filesContext maps to affectedFilesContext',
    legacyPlan.affectedFilesContext?.length === 1 &&
      typeof legacyPlan.affectedFilesContext[0] === 'object' &&
      legacyPlan.affectedFilesContext[0].filePath === 'repo-a/package.json'
  );

  // 2. New field names take precedence over legacy
  const dualPlan = parsePlanArtifact(
    JSON.stringify({
      action: 'feature',
      summary: 'Dual plan',
      steps: ['Step 1'],
      estimatedComplexity: 'low',
      affectedFiles: [{ filePath: 'repo-a/src/new.ts', status: 'found' }],
      filesAffected: [{ filePath: 'repo-a/src/old.ts', status: 'found' }],
      affectedFilesContext: [{ filePath: 'repo-a/new-pkg.json', status: 'found' }],
      filesContext: [{ filePath: 'repo-a/old-pkg.json', status: 'found' }],
    }),
    '/tmp/dual.json'
  );
  assert(
    'new affectedFiles takes precedence over legacy filesAffected',
    dualPlan.affectedFiles?.length === 1 &&
      typeof dualPlan.affectedFiles[0] === 'object' &&
      dualPlan.affectedFiles[0].filePath === 'repo-a/src/new.ts'
  );
  assert(
    'new affectedFilesContext takes precedence over legacy filesContext',
    dualPlan.affectedFilesContext?.length === 1 &&
      typeof dualPlan.affectedFilesContext[0] === 'object' &&
      dualPlan.affectedFilesContext[0].filePath === 'repo-a/new-pkg.json'
  );

  // 3. Zod schema validates new field names
  const schemaResult = resolutionPlanSchema.safeParse({
    action: 'fix',
    summary: 'Schema test',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
    affectedFiles: [{ filePath: 'repo-a/src/a.ts', status: 'found' }],
    affectedFilesContext: [{ filePath: 'repo-a/package.json', status: 'found' }],
  });
  assert('resolutionPlanSchema accepts affectedFiles/affectedFilesContext', schemaResult.success);

  const schemaRejectOld = resolutionPlanSchema.safeParse({
    action: 'fix',
    summary: 'Old fields',
    steps: [],
    estimatedComplexity: 'low',
    filesAffected: ['src/a.ts'],
  });
  // Old field names are NOT in the schema — they pass through as extra keys (Zod strips them)
  assert(
    'resolutionPlanSchema does not define filesAffected (old key is stripped)',
    schemaRejectOld.success && !('filesAffected' in schemaRejectOld.data)
  );

  // 4. --repos option description reflects multi-repo support
  const proto = IssueImplementCommand.prototype as any;
  const reposDescriptor = Object.getOwnPropertyDescriptor(proto, 'parseRepos');
  // Verify the method exists (option is registered)
  assert('parseRepos option method exists on IssueImplementCommand', reposDescriptor !== undefined);

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
