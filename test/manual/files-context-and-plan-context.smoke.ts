/**
 * Manual smoke test: affectedFilesContext plan schema and buildPlanContext extraction
 *
 * Run: nr test:manual files-context-and-plan-context.smoke.ts
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
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label);
};

function testNormalizeFileEntriesConversion(): void {
  assert('FileEntry type is importable', typeof normalizeFileEntries === 'function');
  const fromStrings = normalizeFileEntries(['src/a.ts', 'src/b.ts']);
  assert('normalizeFileEntries converts strings to FileEntry',
    fromStrings.length === 2 && fromStrings[0].filePath === 'src/a.ts' && fromStrings[0].status === 'found');
}

function testNormalizeFileEntriesPreservation(): void {
  const entry: FileEntry = { filePath: 'src/c.ts', status: 'to-create' };
  const fromEntries = normalizeFileEntries([entry]);
  assert('normalizeFileEntries preserves FileEntry objects',
    fromEntries[0].filePath === 'src/c.ts' && fromEntries[0].status === 'to-create');
}

function testNormalizeFileEntriesMixed(): void {
  const mixed = normalizeFileEntries(['src/a.ts', { filePath: 'src/b.ts', status: 'not-found' }]);
  assert('normalizeFileEntries handles mixed arrays',
    mixed[0].status === 'found' && mixed[1].status === 'not-found');
}

function getBuildPlanContextBaseParams(): any {
  return {
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
}

function testBuildPlanContextWithFiles(): void {
  assert('buildPlanContext is exported from shared-routing', typeof buildPlanContext === 'function');
  const baseParams = getBuildPlanContextBaseParams();
  const withContext = buildPlanContext({
    ...baseParams,
    contextFiles: ['repo/package.json'],
  });
  assert('buildPlanContext includes context files section when non-empty',
    withContext.includes('Files for context (read-only') && withContext.includes('package.json'));
}

function testBuildPlanContextWithoutFiles(): void {
  const baseParams = getBuildPlanContextBaseParams();
  const withoutContext = buildPlanContext(baseParams);
  assert('buildPlanContext omits context files section when undefined',
    !withoutContext.includes('Files for context'));

  const withEmptyContext = buildPlanContext({
    ...baseParams,
    contextFiles: [],
  });
  assert('buildPlanContext omits context files section when empty',
    !withEmptyContext.includes('Files for context'));
}

function testResolutionPlanType(): void {
  const plan: ResolutionPlan = {
    action: 'fix',
    summary: 'Test',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
    affectedFiles: [{ filePath: 'repo/src/a.ts', status: 'found' }, 'repo/src/legacy.ts'],
    affectedFilesContext: [{ filePath: 'repo/package.json', status: 'found' }],
    affectedRepositories: ['repo'],
  };
  assert('ResolutionPlan accepts affectedFilesContext and mixed affectedFiles',
    plan.affectedFilesContext?.length === 1 && plan.affectedFiles?.length === 2);
}

function createTestPlanObject(): object {
  return {
    action: 'fix',
    summary: 'Test plan',
    steps: ['Step 1'],
    estimatedComplexity: 'low',
    affectedFiles: [{ filePath: 'repo/src/a.ts', status: 'found' }, 'repo/src/b.ts'],
    affectedFilesContext: [{ filePath: 'repo/package.json', status: 'found' }],
    affectedRepositories: ['repo'],
  };
}

function validateParsedArtifact(parsed: any): void {
  const parsedAffected = parsed.affectedFiles ?? [];
  const firstEntry = parsedAffected[0];
  const secondEntry = parsedAffected[1];
  assert('parsePlanArtifact preserves FileEntry objects from JSON',
    typeof firstEntry === 'object' && firstEntry.filePath === 'repo/src/a.ts' && firstEntry.status === 'found');
  assert('parsePlanArtifact preserves legacy string entries',
    typeof secondEntry === 'string' && secondEntry === 'repo/src/b.ts');
  const parsedContext = parsed.affectedFilesContext ?? [];
  const firstContext = parsedContext[0];
  assert('parsePlanArtifact preserves affectedFilesContext',
    parsedContext.length === 1 && typeof firstContext === 'object' && firstContext.filePath === 'repo/package.json');
}

function testPlanArtifactParserObjects(): void {
  const planJson = JSON.stringify(createTestPlanObject(), null, 2);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  const planPath = path.join(tmpDir, 'test-plan.json');
  fs.writeFileSync(planPath, planJson);
  try {
    const parsed = parsePlanArtifact(planJson, planPath);
    validateParsedArtifact(parsed);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: affectedFilesContext and buildPlanContext\n'));

  testNormalizeFileEntriesConversion();
  testNormalizeFileEntriesPreservation();
  testNormalizeFileEntriesMixed();
  testBuildPlanContextWithFiles();
  testBuildPlanContextWithoutFiles();
  testResolutionPlanType();
  testPlanArtifactParserObjects();

  console.log(chalk.bold(`\n  ${counts.passed} passed, ${counts.failed} failed\n`));

  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
