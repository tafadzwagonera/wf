/**
 * Manual smoke test: filesContext plan schema and buildPlanContext extraction
 *
 * Run: nr test:manual -- test-files-context-and-plan-context
 *
 * Verifies:
 *   1. FileEntry, FileStatus, normalizeFileEntries are exported from ai.service.
 *   2. normalizeFileEntries converts legacy string[] to FileEntry[].
 *   3. normalizeFileEntries preserves FileEntry objects unchanged.
 *   4. normalizeFileEntries handles mixed arrays.
 *   5. buildPlanContext is exported from shared-routing.
 *   6. buildPlanContext includes context files section when contextFiles is non-empty.
 *   7. buildPlanContext omits context files section when contextFiles is empty/undefined.
 *   8. ResolutionPlan accepts filesContext and FileEntry in filesAffected.
 *   9. Plan artifact parser preserves FileEntry objects from JSON.
 *  10. Plan artifact parser preserves legacy string entries.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  normalizeFileEntries,
  type FileEntry,
  type FileStatus,
  type ResolutionPlan,
} from '../../src/integrations/ai/ai.service';
import { buildPlanContext } from '../../src/integrations/ai/adapters/shared-routing';
import { parsePlanArtifact } from '../../src/shared/utils/plan-artifact';
import type { VerificationScript } from '../../src/agents/interfaces';

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
  console.log(chalk.bold('\nSmoke test: filesContext and buildPlanContext\n'));

  // 1. Exports exist
  assert(
    'FileEntry type is importable',
    typeof normalizeFileEntries === 'function',
  );

  // 2. normalizeFileEntries converts legacy strings
  const fromStrings = normalizeFileEntries(['src/a.ts', 'src/b.ts']);
  assert(
    'normalizeFileEntries converts strings to FileEntry',
    fromStrings.length === 2 &&
      fromStrings[0].filePath === 'src/a.ts' &&
      fromStrings[0].status === 'found',
  );

  // 3. normalizeFileEntries preserves FileEntry objects
  const entry: FileEntry = { filePath: 'src/c.ts', status: 'to-create' };
  const fromEntries = normalizeFileEntries([entry]);
  assert(
    'normalizeFileEntries preserves FileEntry objects',
    fromEntries[0].filePath === 'src/c.ts' &&
      fromEntries[0].status === 'to-create',
  );

  // 4. normalizeFileEntries handles mixed arrays
  const mixed = normalizeFileEntries([
    'src/a.ts',
    { filePath: 'src/b.ts', status: 'not-found' },
  ]);
  assert(
    'normalizeFileEntries handles mixed arrays',
    mixed[0].status === 'found' && mixed[1].status === 'not-found',
  );

  // 5. buildPlanContext is exported
  assert(
    'buildPlanContext is exported from shared-routing',
    typeof buildPlanContext === 'function',
  );

  const baseParams = {
    ticketKey: 'TEST-1',
    repoDir: '/tmp/repo',
    repoName: 'repo',
    repoFiles: ['repo/src/a.ts'],
    trackedFilePaths: ['repo/src/a.ts'],
    verificationScripts: [
      { id: 'build', command: 'yarn build', policy: 'enforced' },
    ] as VerificationScript[],
    planSteps: ['Step 1'],
    planSummary: 'Summary',
    planAction: 'fix' as const,
  };

  // 6. Includes context files section when non-empty
  const withContext = buildPlanContext({
    ...baseParams,
    contextFiles: ['repo/package.json'],
  });
  assert(
    'buildPlanContext includes context files section when non-empty',
    withContext.includes('Files for context (read-only') &&
      withContext.includes('package.json'),
  );

  // 7. Omits context files section when empty/undefined
  const withoutContext = buildPlanContext(baseParams);
  assert(
    'buildPlanContext omits context files section when undefined',
    !withoutContext.includes('Files for context'),
  );
  const withEmptyContext = buildPlanContext({
    ...baseParams,
    contextFiles: [],
  });
  assert(
    'buildPlanContext omits context files section when empty',
    !withEmptyContext.includes('Files for context'),
  );

  // 8. ResolutionPlan type accepts filesContext
  const plan: ResolutionPlan = {
    action: 'fix',
    summary: 'Test',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
    filesAffected: [
      { filePath: 'repo/src/a.ts', status: 'found' },
      'repo/src/legacy.ts',
    ],
    filesContext: [{ filePath: 'repo/package.json', status: 'found' }],
    repositoriesAffected: ['repo'],
  };
  assert(
    'ResolutionPlan accepts filesContext and mixed filesAffected',
    plan.filesContext!.length === 1 && plan.filesAffected!.length === 2,
  );

  // 9 & 10. Plan artifact parser preserves FileEntry objects and legacy strings
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  const planWithEntries = {
    action: 'fix',
    summary: 'Test plan',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
    filesAffected: [
      { filePath: 'repo/src/a.ts', status: 'found' },
      'repo/src/b.ts',
    ],
    filesContext: [{ filePath: 'repo/package.json', status: 'found' }],
    repositoriesAffected: ['repo'],
  };
  const planPath = path.join(tmpDir, 'test-plan.json');
  const planJson = JSON.stringify(planWithEntries, null, 2);
  fs.writeFileSync(planPath, planJson);

  const parsed = parsePlanArtifact(planJson, planPath);
  const parsedAffected = parsed.filesAffected ?? [];
  const firstEntry = parsedAffected[0];
  const secondEntry = parsedAffected[1];
  assert(
    'parsePlanArtifact preserves FileEntry objects from JSON',
    typeof firstEntry === 'object' &&
      firstEntry.filePath === 'repo/src/a.ts' &&
      firstEntry.status === 'found',
  );
  assert(
    'parsePlanArtifact preserves legacy string entries',
    typeof secondEntry === 'string' && secondEntry === 'repo/src/b.ts',
  );

  const parsedContext = parsed.filesContext ?? [];
  const firstContext = parsedContext[0];
  assert(
    'parsePlanArtifact preserves filesContext',
    parsedContext.length === 1 &&
      typeof firstContext === 'object' &&
      firstContext.filePath === 'repo/package.json',
  );

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
