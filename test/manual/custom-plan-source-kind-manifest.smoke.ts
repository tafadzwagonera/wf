/**
 * Manual Test: custom plan manifest stamped with sourceKind 'custom' at creation time
 *
 * Run: nr test:manual -- test-custom-plan-source-kind-manifest
 *
 * Verifies:
 *   1. createPlanArtifact with sourceKind 'custom' writes a manifest with sourceKind: 'custom'
 *   2. The manifest contains customArtifactName (not ticketKey)
 *   3. createPlanArtifact without sourceKind defaults to 'ticket' (backward compat)
 *   4. The default manifest contains ticketKey (not customArtifactName)
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import {
  buildPlanArtifactManifestPath,
  readPlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const planStageService = app.get(PlanStageService);

  const cannedPlan = {
    action: 'fix',
    summary: 'Stub plan for sourceKind smoke test',
    estimatedComplexity: 'low',
    steps: ['Step one'],
    affectedFiles: [{ filePath: 'wf/src/main.ts', status: 'found' }],
    affectedRepositories: ['wf'],
    risks: [],
  };
  (planStageService as any).generatePlan = async () => ({ plan: cannedPlan });

  console.log(
    '\n\uD83E\uDDEA Test 1: createPlanArtifact with sourceKind custom\n' + '\u2500'.repeat(60)
  );
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-source-kind-'));
    const ticketPath = path.join(tempDir, 'my-custom-plan.md');
    fs.writeFileSync(ticketPath, '# Custom plan content');

    try {
      const artifact = await planStageService.createPlanArtifact(
        {
          ticketKey: 'my-custom-plan',
          content: '# Custom plan content',
          path: ticketPath,
        },
        {
          action: 'fix',
          affectedRepositories: ['wf'],
          sourceKind: 'custom',
        }
      );

      const manifestPath = buildPlanArtifactManifestPath(artifact.path);

      if (fs.existsSync(manifestPath)) {
        const manifest = readPlanArtifactManifest(manifestPath);

        if (manifest) {
          if (manifest.sourceKind === 'custom') {
            pass('manifest.sourceKind is "custom"');
          } else {
            fail('manifest.sourceKind is not "custom"', `got: ${manifest.sourceKind}`);
          }

          if (manifest.customArtifactName === 'my-custom-plan') {
            pass('manifest.customArtifactName is "my-custom-plan"');
          } else {
            fail('manifest.customArtifactName mismatch', `got: ${manifest.customArtifactName}`);
          }

          if (manifest.ticketKey === undefined) {
            pass('manifest.ticketKey is absent');
          } else {
            fail('manifest.ticketKey should be undefined for custom source', `got: ${manifest.ticketKey}`);
          }
        } else {
          fail('Manifest could not be read back from disk');
        }
      } else {
        fail('Manifest file was not written to disk', `expected at ${manifestPath}`);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  console.log(
    '\n\uD83E\uDDEA Test 2: createPlanArtifact without sourceKind defaults to ticket\n' + '\u2500'.repeat(60)
  );
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-source-kind-'));
    const ticketPath = path.join(tempDir, 'WBP-999.md');
    fs.writeFileSync(ticketPath, '# WBP-999: Ticket content');

    try {
      const artifact = await planStageService.createPlanArtifact(
        {
          ticketKey: 'WBP-999',
          content: '# WBP-999: Ticket content',
          path: ticketPath,
        },
        {
          action: 'fix',
          affectedRepositories: ['wf'],
        }
      );

      const manifestPath = buildPlanArtifactManifestPath(artifact.path);

      if (fs.existsSync(manifestPath)) {
        const manifest = readPlanArtifactManifest(manifestPath);

        if (manifest) {
          if (manifest.sourceKind === 'ticket') {
            pass('manifest.sourceKind defaults to "ticket"');
          } else {
            fail('manifest.sourceKind should default to "ticket"', `got: ${manifest.sourceKind}`);
          }

          if (manifest.ticketKey === 'WBP-999') {
            pass('manifest.ticketKey is "WBP-999"');
          } else {
            fail('manifest.ticketKey mismatch', `got: ${manifest.ticketKey}`);
          }

          if (manifest.customArtifactName === undefined) {
            pass('manifest.customArtifactName is absent for ticket source');
          } else {
            fail('manifest.customArtifactName should be undefined', `got: ${manifest.customArtifactName}`);
          }
        } else {
          fail('Manifest could not be read back from disk');
        }
      } else {
        fail('Manifest file was not written to disk', `expected at ${manifestPath}`);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  await app.close();

  console.log('\n' + '\u2501'.repeat(60));
  console.log(`Results: \u2705 ${counts.passed} passed   \u274C ${counts.failed} failed`);
  if (counts.failed === 0) console.log('\u2705 All tests passed!');
  console.log('\u2501'.repeat(60));

  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
