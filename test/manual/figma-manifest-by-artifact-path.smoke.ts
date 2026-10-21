/**
 * Manual smoke test: FigmaStageService loads manifest by artifact path, skipping branch-name lookup
 *
 * Verifies that when `artifactPath` is set on `FigmaStageOptions`, `resolveFromManifest`
 * reads the `.sources.json` sibling directly and never consults the git service for the
 * current branch. This is the fix for the stale-manifest bug: the branch-name lookup finds
 * older manifests whose figmaLinks lack `?node-id=` query strings.
 *
 * Run: nr test:manual figma-manifest-by-artifact-path.smoke.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { FigmaStageService } from '../../src/review/figma-stage.service';
import { LoggerService } from '../../src/common/logger/logger.service';
import { buildPlanArtifactManifestPath } from '../../src/common/utils/plan-artifact';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const FIGMA_LINK = 'https://www.figma.com/design/ABC123/MyFile?node-id=1-2';

function makeConfigService(overrides: Record<string, unknown> = {}) {
  return {
    get: <T>(key: string, def?: T): T | undefined =>
      (key in overrides ? overrides[key] : def) as T | undefined,
  } as any;
}

function buildTestManifest(artifactPath: string) {
  return {
    artifactPath,
    action: 'fix',
    createdAt: '2026-09-08T00:00:00.000Z',
    format: 'json',
    hash: 'abc123',
    sourceKind: 'ticket',
    sourceName: 'PROJ-1',
    figmaLinks: [FIGMA_LINK],
    sourceBranch: 'main',
  };
}

function setupTestFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-manifest-'));
  const artifactPath = path.join(tempDir, 'PROJ-1.json');
  const manifest = buildTestManifest(artifactPath);
  fs.writeFileSync(artifactPath, JSON.stringify({ action: 'fix', figmaLinks: [FIGMA_LINK] }), 'utf-8');
  fs.writeFileSync(buildPlanArtifactManifestPath(artifactPath), JSON.stringify(manifest, null, 2), 'utf-8');
  return { tempDir, artifactPath, manifest };
}

function checkCondition(condition: boolean, passMsg: string, failMsg: string, snippet?: string): void {
  if (condition) {
    pass(passMsg);
  } else {
    fail(failMsg, snippet);
  }
}

function makeFetchFramesClient() {
  return {
    fetchFrames: async (links: string[]) => links.map(url => ({
      url, name: 'Frame', width: 800, height: 600, screenshotUrl: 'https://s3.example.com/img.png',
    })),
  } as any;
}

function makeFakeGitServiceWithTracker() {
  const tracker = { called: false };
  const service = {
    getBranchInfo: async () => {
      tracker.called = true;
      throw new Error('getBranchInfo must not be called when artifactPath is set');
    },
  } as any;
  return { service, tracker };
}

function makeGitServiceReturningBranchInfo() {
  const tracker = { called: false };
  const service = {
    getBranchInfo: async () => {
      tracker.called = true;
      return { current: 'feature/PROJ-1', all: ['feature/PROJ-1'], detached: false };
    },
  } as any;
  return { service, tracker };
}

async function runTest1FigmaLinksFromManifest(tempDir: string, artifactPath: string): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 1: result contains figmaLinks from manifest'));
  const configService = makeConfigService();
  const { service: gitService, tracker } = makeFakeGitServiceWithTracker();
  const logger = new LoggerService(configService);
  const service = new FigmaStageService(configService, gitService, logger, makeFetchFramesClient());
  const result = await service.resolveIfEnabled({ repoDir: tempDir, force: true, artifactPath });
  const hasLink = result?.figmaLinks?.length === 1 && result.figmaLinks[0] === FIGMA_LINK;
  checkCondition(hasLink, 'figmaLinks from manifest', 'figmaLinks missing or wrong', JSON.stringify(result?.figmaLinks));
  checkCondition(result?.baseBranch === 'main', 'baseBranch is main', 'baseBranch wrong', String(result?.baseBranch));
  checkCondition(!tracker.called, 'getBranchInfo skipped when artifactPath set', 'getBranchInfo was called');
}

async function runTest2FallbackToBranchLookup(tempDir: string): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 2: falls back to branch-name lookup when artifactPath is absent'));
  const configService = makeConfigService();
  const { service: gitService, tracker } = makeGitServiceReturningBranchInfo();
  const logger = new LoggerService(configService);
  const fakeFigmaClient = { fetchFrames: async () => [] } as any;
  const service = new FigmaStageService(configService, gitService, logger, fakeFigmaClient);
  await service.resolveIfEnabled({ repoDir: tempDir, force: true });
  checkCondition(tracker.called, 'getBranchInfo called when artifactPath absent', 'getBranchInfo not called');
}

function setupEmptyLinksFixture(tempDir: string, manifest: ReturnType<typeof buildTestManifest>): string {
  const emptyManifest = { ...manifest, figmaLinks: [] };
  const emptyArtifactPath = path.join(tempDir, 'PROJ-2.json');
  fs.writeFileSync(emptyArtifactPath, JSON.stringify({ action: 'fix', figmaLinks: [] }), 'utf-8');
  fs.writeFileSync(buildPlanArtifactManifestPath(emptyArtifactPath), JSON.stringify(emptyManifest, null, 2), 'utf-8');
  return emptyArtifactPath;
}

async function runTest3UndefinedForEmptyLinks(
  tempDir: string,
  manifest: ReturnType<typeof buildTestManifest>,
): Promise<void> {
  console.log(chalk.bold.cyan('\nTest 3: returns undefined when plan artifact has no figmaLinks'));
  const emptyArtifactPath = setupEmptyLinksFixture(tempDir, manifest);
  const configService = makeConfigService();
  const logger = new LoggerService(configService);
  const service = new FigmaStageService(configService, {} as any, logger, { fetchFrames: async () => [] } as any);
  const result = await service.resolveIfEnabled({ repoDir: tempDir, force: true, artifactPath: emptyArtifactPath });
  checkCondition(result === undefined, 'returns undefined for empty links', 'expected undefined', JSON.stringify(result));
}

async function main(): Promise<void> {
  console.log('Manual smoke: FigmaStageService loads manifest by artifact path\n');
  const { tempDir, artifactPath, manifest } = setupTestFixture();
  try {
    await runTest1FigmaLinksFromManifest(tempDir, artifactPath);
    await runTest2FallbackToBranchLookup(tempDir);
    await runTest3UndefinedForEmptyLinks(tempDir, manifest);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: FigmaStageService loads manifest by artifact path');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
