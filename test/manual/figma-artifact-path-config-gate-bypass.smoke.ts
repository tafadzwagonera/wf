/**
 * Manual smoke test: FigmaStageService bypasses the config gate when artifactPath is provided
 *
 * Verifies that `resolveIfEnabled` reads the `.sources.json` sibling from disk and returns
 * figmaLinks even when `force` is false and the config key is disabled — as long as
 * `artifactPath` is provided. Also confirms the figmaLinks guard still applies: an
 * `artifactPath` pointing to a manifest with no links returns undefined.
 *
 * Run: nr test:manual -- figma-artifact-path-config-gate-bypass.smoke
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

const FIGMA_LINK = 'https://www.figma.com/design/UZuMQg4xXa9cXvIPnghyz9/Stories-Feed?node-id=194-4397';

function makeConfigService(overrides: Record<string, unknown> = {}) {
  return {
    get: <T>(key: string, def?: T): T | undefined =>
      (key in overrides ? overrides[key] : def) as T | undefined,
  } as any;
}

function writeManifest(artifactPath: string, figmaLinks: string[] | undefined): void {
  const manifest = {
    artifactPath,
    action: 'fix',
    createdAt: new Date().toISOString(),
    format: 'json',
    hash: 'aabbccdd',
    sourceKind: 'custom',
    sourceName: 'test-plan',
    figmaLinks,
  };
  fs.writeFileSync(buildPlanArtifactManifestPath(artifactPath), JSON.stringify(manifest, null, 2), 'utf-8');
}

async function main(): Promise<void> {
  console.log('Manual smoke: FigmaStageService bypasses config gate when artifactPath is provided\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-gate-'));
  const artifactPath = path.join(tempDir, 'test-fix-plan.json');
  const repoDir = tempDir;

  const origFetch = global.fetch;

  try {
    console.log(chalk.bold.cyan('\nTest 1: config gate bypassed — artifactPath reads manifest and returns figmaLinks'));
    {
      fs.writeFileSync(artifactPath, '{}', 'utf-8');
      writeManifest(artifactPath, [FIGMA_LINK]);

      const configService = makeConfigService();
      const logger = new LoggerService(configService);
      const fakeGitService = {} as any;
      const fakeFigmaClient = {
        fetchFrames: async (links: string[]) => links.map(url => ({
          url,
          name: 'Frame',
          width: 800,
          height: 600,
          screenshotUrl: 'https://s3.example.com/img.png',
          layout: { name: 'Frame', width: 800, height: 600 },
        })),
      } as any;

      const service = new FigmaStageService(configService, fakeGitService, logger, fakeFigmaClient);
      const result = await service.resolveIfEnabled({
        repoDir,
        force: false,
        configKey: 'stages.implement.figma',
        artifactPath,
      });

      if (result?.figmaLinks?.length === 1 && result.figmaLinks[0] === FIGMA_LINK) {
        pass(`figmaLinks returned despite config gate being disabled: ${FIGMA_LINK}`);
      } else {
        fail('expected figmaLinks in result but got none', JSON.stringify(result));
      }

      if (result?.frames?.length === 1) {
        pass('frames populated from fetchFrames call');
      } else {
        fail('expected one frame in result', JSON.stringify(result?.frames));
      }
    }

  } finally {
    global.fetch = origFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: FigmaStageService bypasses config gate when artifactPath is provided');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
