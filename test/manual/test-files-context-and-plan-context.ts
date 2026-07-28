/**
 * Manual smoke test: affectedFilesContext plan schema and buildPlanContext extraction
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
 *   8. ResolutionPlan accepts affectedFilesContext and FileEntry in affectedFiles.
 *   9. Plan artifact parser preserves FileEntry objects from JSON.
 *  10. Plan artifact parser preserves legacy string entries.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  normalizeFileEntries,
  type FileEntry,
  type ResolutionPlan,
} from '../../src/integrations/ai/ai.service';
import { buildPlanContext } from '../../src/integrations/ai/adapters/shared-routing';
import { parsePlanArtifact } from '../../src/shared/utils/plan-artifact';
import type { VerificationScript } from '../../src/agents/interfaces';

let passed = 0;
let failed = 0;

const pass = (label: string): void => {
  console.log(chalk.green(`  \u2713 ${label}`));
  passed++;
};

const fail = (label: string): void => {
  console.log(chalk.red(`  \u2717 ${label}`));
  failed++;
};

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label);
};

const run = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: affectedFilesContext and buildPlanContext\n'));

  // 1. Exports exist
  assert('FileEntry type is importable', typeof normalizeFileEntries === 'function');

  // 2. normalizeFileEntries converts legacy strings
  const fromStrings = normalizeFileEntries(['src/a.ts', 'src/b.ts']);
  assert(
    'normalizeFileEntries converts strings to FileEntry',
    fromStrings.length === 2 && fromStrings[0].filePath === 'src/a.ts' && fromStrings[0].status === 'found'
  );

  // 3. normalizeFileEntries preserves FileEntry objects
  const entry: FileEntry = { filePath: 'src/c.ts', status: 'to-create' };
  const fromEntries = normalizeFileEntries([entry]);
  assert(
    'normalizeFileEntries preserves FileEntry objects',
    fromEntries[0].filePath === 'src/c.ts' && fromEntries[0].status === 'to-create'
  );

  // 4. normalizeFileEntries handles mixed arrays
  const mixed = normalizeFileEntries(['src/a.ts', { filePath: 'src/b.ts', status: 'not-found' }]);
  assert('normalizeFileEntries handles mixed arrays', mixed[0].status === 'found' && mixed[1].status === 'not-found');

  // 5. buildPlanContext is exported
  assert('buildPlanContext is exported from shared-routing', typeof buildPlanContext === 'function');

  const baseParams = {
    ticketKey: 'TEST-1',
    repoDir: '/tmp/repo',
    repoName: 'repo',
    repoFiles: ['repo/src/a.ts'],
    trackedFilePaths: ['repo/src/a.ts'],
    verificationScripts: [{ id: 'build', command: 'yarn build', policy: 'enforced' }] as VerificationScript[],
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
    withContext.includes('Files for context (read-only') && withContext.includes('package.json')
  );

  // 7. Omits context files section when empty/undefined
  const withoutContext = buildPlanContext(baseParams);
  assert('buildPlanContext omits context files section when undefined', !withoutContext.includes('Files for context'));
  const withEmptyContext = buildPlanContext({
    ...baseParams,
    contextFiles: [],
  });
  assert('buildPlanContext omits context files section when empty', !withEmptyContext.includes('Files for context'));

  // 8. ResolutionPlan type accepts affectedFilesContext
  const plan: ResolutionPlan = {
    action: 'fix',
    summary: 'Test',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
    affectedFiles: [{ filePath: 'repo/src/a.ts', status: 'found' }, 'repo/src/legacy.ts'],
    affectedFilesContext: [{ filePath: 'repo/package.json', status: 'found' }],
    affectedRepositories: ['repo'],
  };
  assert(
    'ResolutionPlan accepts affectedFilesContext and mixed affectedFiles',
    plan.affectedFilesContext?.length === 1 && plan.affectedFiles?.length === 2
  );

  // 9 & 10. Plan artifact parser preserves FileEntry objects and legacy strings
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  const planWithEntries = {
    action: 'fix',
    summary: 'Test plan',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
    affectedFiles: [{ filePath: 'repo/src/a.ts', status: 'found' }, 'repo/src/b.ts'],
    affectedFilesContext: [{ filePath: 'repo/package.json', status: 'found' }],
    affectedRepositories: ['repo'],
  };
  const planPath = path.join(tmpDir, 'test-plan.json');
  const planJson = JSON.stringify(planWithEntries, null, 2);
  fs.writeFileSync(planPath, planJson);

  const parsed = parsePlanArtifact(planJson, planPath);
  const parsedAffected = parsed.affectedFiles ?? [];
  const firstEntry = parsedAffected[0];
  const secondEntry = parsedAffected[1];
  assert(
    'parsePlanArtifact preserves FileEntry objects from JSON',
    typeof firstEntry === 'object' && firstEntry.filePath === 'repo/src/a.ts' && firstEntry.status === 'found'
  );
  assert(
    'parsePlanArtifact preserves legacy string entries',
    typeof secondEntry === 'string' && secondEntry === 'repo/src/b.ts'
  );

  const parsedContext = parsed.affectedFilesContext ?? [];
  const firstContext = parsedContext[0];
  assert(
    'parsePlanArtifact preserves affectedFilesContext',
    parsedContext.length === 1 && typeof firstContext === 'object' && firstContext.filePath === 'repo/package.json'
  );

  fs.rmSync(tmpDir, { recursive: true });

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
