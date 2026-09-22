/**
 * Manual smoke test: PlanStageService.createPlanArtifact gates Figma link extraction on the figma flag.
 *
 * Run: nr test:manual figma-plan-flag-gate.smoke.ts
 */

import { NestFactory } from '@nestjs/core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppModule } from '../../src/app.module';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import {
  buildPlanArtifactManifestPath,
  readPlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const FIGMA_URL = 'https://figma.com/design/ABC123/Page?node-id=1-1';
const TICKET_CONTENT = `# WBP-100: Style the modal\n\nSee ${FIGMA_URL} for the design.`;

const cannedPlan = {
  action: 'fix' as const,
  summary: 'Stub plan for figma gate smoke test',
  estimatedComplexity: 'low',
  steps: ['Step one'],
  affectedFiles: [{ filePath: 'src/main.ts', status: 'found' }],
  affectedRepositories: ['wf'],
  risks: [],
};

type ArtifactOptions = Parameters<PlanStageService['createPlanArtifact']>[1];

function setupTicketDir(): { tempDir: string; ticketPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-gate-'));
  const ticketPath = path.join(tempDir, 'WBP-100.md');
  fs.writeFileSync(ticketPath, TICKET_CONTENT);
  return { tempDir, ticketPath };
}

function readArtifactOutputs(artifactPath: string): { plan: any; manifest: any } {
  const plan = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
  const manifestPath = buildPlanArtifactManifestPath(artifactPath);
  const manifest = readPlanArtifactManifest(manifestPath);
  return { plan, manifest };
}

function assertFigmaGateOpen(label: string, plan: any, manifest: any): void {
  if (Array.isArray(plan.figmaLinks) && plan.figmaLinks.includes(FIGMA_URL)) {
    pass(`${label}: plan JSON contains figmaLinks`);
  } else {
    fail(`${label}: plan JSON missing expected figmaLinks`, JSON.stringify(plan.figmaLinks));
  }
  if (Array.isArray(manifest?.figmaLinks) && manifest.figmaLinks.includes(FIGMA_URL)) {
    pass(`${label}: manifest contains figmaLinks`);
  } else {
    fail(`${label}: manifest missing expected figmaLinks`, JSON.stringify(manifest?.figmaLinks));
  }
}

function assertFigmaGateClosed(label: string, plan: any, manifest: any): void {
  if (plan.figmaLinks) {
    fail(`${label}: plan JSON unexpectedly has figmaLinks`, JSON.stringify(plan.figmaLinks));
  } else {
    pass(`${label}: plan JSON has no figmaLinks (gate closed)`);
  }
  if (manifest?.figmaLinks) {
    fail(`${label}: manifest unexpectedly has figmaLinks`, JSON.stringify(manifest.figmaLinks));
  } else {
    pass(`${label}: manifest has no figmaLinks (gate closed)`);
  }
}

async function runCase(label: string, service: PlanStageService, options: ArtifactOptions): Promise<void> {
  const { tempDir, ticketPath } = setupTicketDir();
  try {
    const ticket = { ticketKey: 'WBP-100', content: TICKET_CONTENT, path: ticketPath };
    const artifact = await service.createPlanArtifact(ticket, options);
    const { plan, manifest } = readArtifactOutputs(artifact.path);
    if (options.figma) {
      assertFigmaGateOpen(label, plan, manifest);
    } else {
      assertFigmaGateClosed(label, plan, manifest);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function reportResults(): void {
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: figma gate controls plan-stage link extraction');
}

async function main(): Promise<void> {
  console.log('Manual smoke: PlanStageService.createPlanArtifact gates extraction on the figma flag\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const service = app.get(PlanStageService);
  (service as any).generatePlan = async () => ({ plan: cannedPlan });
  await runCase('gate closed (figma: undefined)', service, { action: 'fix' });
  await runCase('gate open (figma: true)', service, { action: 'fix', figma: true });
  await app.close();
  reportResults();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
