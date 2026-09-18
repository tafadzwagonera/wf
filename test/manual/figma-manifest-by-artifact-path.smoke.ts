/**
 * Manual smoke test: FigmaStageService loads manifest by artifact path, skipping branch-name lookup
 *
 * Verifies that when `artifactPath` is set on `FigmaStageOptions`, `resolveFromManifest`
 * reads the `.sources.json` sibling directly and never consults the git service for the
 * current branch. This is the fix for the stale-manifest bug: the branch-name lookup finds
 * older manifests whose figmaLinks lack `?node-id=` query strings.
 *
 * Run: nr test:manual -- figma-manifest-by-artifact-path.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { FigmaStageService } from '../../src/review/figma-stage.service';
import { LoggerService } from '../../src/shared/logger/logger.service';
import { buildPlanArtifactManifestPath } from '../../src/shared/utils/plan-artifact';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const FIGMA_LINK = 'https://www.figma.com/design/ABC123/MyFile?node-id=1-2';

function makeConfigService(overrides: Record<string, unknown> = {}) {
  return {
    get: <T>(key: string, def?: T): T | undefined =>
      (key in overrides ? overrides[key] : def) as T | undefined,
  } as any;
}

async function main(): Promise<void> {
  console.log('Manual smoke: FigmaStageService loads manifest by artifact path\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-manifest-'));
  const artifactPath = path.join(tempDir, 'PROJ-1.md');
  const manifestPath = buildPlanArtifactManifestPath(artifactPath);

  const manifest = {
    artifactPath,
    action: 'fix',
    createdAt: '2026-09-08T00:00:00.000Z',
    format: 'md',
    hash: 'abc123',
    sourceKind: 'ticket',
    sourceName: 'PROJ-1',
    figmaLinks: [FIGMA_LINK],
    sourceBranch: 'main',
  };

  fs.writeFileSync(artifactPath, '# PROJ-1 artifact', 'utf-8');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  try {
    console.log(chalk.bold.cyan('\nTest 1: result contains figmaLinks from manifest'));
    {
      const configService = makeConfigService();
      const logger = new LoggerService(configService);
      let gitCalled = false;
      const fakeGitService = {
        getBranchInfo: async () => {
          gitCalled = true;
          throw new Error('getBranchInfo must not be called when artifactPath is set');
        },
      } as any;
      const fakeFigmaClient = {
        fetchFrames: async (links: string[]) => links.map(url => ({
          url, name: 'Frame', width: 800, height: 600, screenshotUrl: 'https://s3.example.com/img.png',
        })),
      } as any;

      const service = new FigmaStageService(configService, fakeGitService, logger, fakeFigmaClient);
      const result = await service.resolveIfEnabled({ repoDir: tempDir, force: true, artifactPath });

      if (result?.figmaLinks?.length === 1 && result.figmaLinks[0] === FIGMA_LINK) {
        pass(`figmaLinks contains the manifest link: ${FIGMA_LINK}`);
      } else {
        fail('figmaLinks missing or wrong', JSON.stringify(result?.figmaLinks));
      }

      if (result?.baseBranch === 'main') {
        pass('baseBranch resolved from manifest sourceBranch');
      } else {
        fail('baseBranch wrong or missing', String(result?.baseBranch));
      }

      if (!gitCalled) {
        pass('getBranchInfo was not called — branch-name lookup skipped');
      } else {
        fail('getBranchInfo was called despite artifactPath being set');
      }
    }

    console.log(chalk.bold.cyan('\nTest 2: falls back to branch-name lookup when artifactPath is absent'));
    {
      const configService = makeConfigService();
      const logger = new LoggerService(configService);
      let gitCalled = false;
      const fakeGitService = {
        getBranchInfo: async () => {
          gitCalled = true;
          return { current: 'feature/PROJ-1', all: ['feature/PROJ-1'], detached: false };
        },
      } as any;
      const fakeFigmaClient = { fetchFrames: async () => [] } as any;

      const service = new FigmaStageService(configService, fakeGitService, logger, fakeFigmaClient);
      await service.resolveIfEnabled({ repoDir: tempDir, force: true });

      if (gitCalled) {
        pass('getBranchInfo was called when artifactPath is absent');
      } else {
        fail('getBranchInfo was not called — fallback branch-name path did not run');
      }
    }

    console.log(chalk.bold.cyan('\nTest 3: returns undefined when manifest has no figmaLinks'));
    {
      const emptyManifest = { ...manifest, figmaLinks: [] };
      const emptyArtifactPath = path.join(tempDir, 'PROJ-2.md');
      fs.writeFileSync(emptyArtifactPath, '', 'utf-8');
      fs.writeFileSync(
        buildPlanArtifactManifestPath(emptyArtifactPath),
        JSON.stringify(emptyManifest, null, 2),
        'utf-8',
      );

      const configService = makeConfigService();
      const logger = new LoggerService(configService);
      const fakeGitService = {} as any;
      const fakeFigmaClient = { fetchFrames: async () => [] } as any;

      const service = new FigmaStageService(configService, fakeGitService, logger, fakeFigmaClient);
      const result = await service.resolveIfEnabled({
        repoDir: tempDir, force: true, artifactPath: emptyArtifactPath,
      });

      if (result === undefined) {
        pass('returns undefined when manifest has no figmaLinks');
      } else {
        fail('expected undefined for manifest with empty figmaLinks', JSON.stringify(result));
      }
    }
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
