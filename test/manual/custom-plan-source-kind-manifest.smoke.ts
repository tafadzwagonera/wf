/**
 * Manual Test: custom plan manifest stamped with sourceKind 'custom' at creation time
 *
 * Run: nr test:manual custom-plan-source-kind-manifest.smoke.ts
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
} from '../../src/common/utils/plan-artifact';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const cannedPlan = {
  action: 'fix',
  summary: 'Stub plan for sourceKind smoke test',
  estimatedComplexity: 'low',
  steps: ['Step one'],
  affectedFiles: [{ filePath: 'wf/src/main.ts', status: 'found' }],
  affectedRepositories: ['wf'],
  risks: [],
};

function checkCustomSourceKindManifest(manifest: any): void {
  if (manifest.sourceKind === 'custom') pass('manifest.sourceKind is "custom"');
  else fail('manifest.sourceKind is not "custom"', `got: ${manifest.sourceKind}`);

  if (manifest.customArtifactName === 'my-custom-plan') pass('manifest.customArtifactName is "my-custom-plan"');
  else fail('manifest.customArtifactName mismatch', `got: ${manifest.customArtifactName}`);

  if (manifest.ticketKey === undefined) pass('manifest.ticketKey is absent');
  else fail('manifest.ticketKey should be undefined for custom source', `got: ${manifest.ticketKey}`);
}

function checkDefaultTicketSourceKindManifest(manifest: any): void {
  if (manifest.sourceKind === 'ticket') pass('manifest.sourceKind defaults to "ticket"');
  else fail('manifest.sourceKind should default to "ticket"', `got: ${manifest.sourceKind}`);

  if (manifest.ticketKey === 'WBP-999') pass('manifest.ticketKey is "WBP-999"');
  else fail('manifest.ticketKey mismatch', `got: ${manifest.ticketKey}`);

  if (manifest.customArtifactName === undefined) pass('manifest.customArtifactName is absent for ticket source');
  else fail('manifest.customArtifactName should be undefined', `got: ${manifest.customArtifactName}`);
}

async function validateManifestAt(manifestPath: string, checker: (manifest: any) => void): Promise<void> {
  if (!fs.existsSync(manifestPath)) {
    fail('Manifest file was not written to disk', `expected at ${manifestPath}`);
    return;
  }
  const manifest = readPlanArtifactManifest(manifestPath);
  if (!manifest) {
    fail('Manifest could not be read back from disk');
    return;
  }
  checker(manifest);
}

async function createCustomArtifactAndCheckManifest(planStageService: any, tempDir: string): Promise<void> {
  const ticketPath = path.join(tempDir, 'my-custom-plan.md');
  fs.writeFileSync(ticketPath, '# Custom plan content');
  const artifact = await planStageService.createPlanArtifact(
    { ticketKey: 'my-custom-plan', content: '# Custom plan content', path: ticketPath },
    { action: 'fix', affectedRepositories: ['wf'], sourceKind: 'custom' }
  );
  const manifestPath = buildPlanArtifactManifestPath(artifact.path);
  await validateManifestAt(manifestPath, checkCustomSourceKindManifest);
}

async function testCustomSourceKind(planStageService: any): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-source-kind-'));
  try {
    await createCustomArtifactAndCheckManifest(planStageService, tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function createTicketArtifactAndCheckManifest(planStageService: any, tempDir: string): Promise<void> {
  const ticketPath = path.join(tempDir, 'WBP-999.md');
  fs.writeFileSync(ticketPath, '# WBP-999: Ticket content');
  const artifact = await planStageService.createPlanArtifact(
    { ticketKey: 'WBP-999', content: '# WBP-999: Ticket content', path: ticketPath },
    { action: 'fix', affectedRepositories: ['wf'] }
  );
  const manifestPath = buildPlanArtifactManifestPath(artifact.path);
  await validateManifestAt(manifestPath, checkDefaultTicketSourceKindManifest);
}

async function testDefaultTicketSourceKind(planStageService: any): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-source-kind-'));
  try {
    await createTicketArtifactAndCheckManifest(planStageService, tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function setupApp(planStageService: any): void {
  (planStageService).generatePlan = async () => ({ plan: cannedPlan });
}

function printResults(): void {
  console.log('\n' + '─'.repeat(60));
  console.log(`Results: ✅ ${counts.passed} passed   ❌ ${counts.failed} failed`);
  if (counts.failed === 0) console.log('✅ All tests passed!');
  console.log('─'.repeat(60));
}

async function runAllTests(planStageService: any): Promise<void> {
  console.log('\n🧪 Test 1: createPlanArtifact with sourceKind custom\n' + '─'.repeat(60));
  await testCustomSourceKind(planStageService);
  console.log('\n🧪 Test 2: createPlanArtifact without sourceKind defaults to ticket\n' + '─'.repeat(60));
  await testDefaultTicketSourceKind(planStageService);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const planStageService = app.get(PlanStageService);
  setupApp(planStageService);
  await runAllTests(planStageService);
  await app.close();
  printResults();
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
