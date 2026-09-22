import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMigration } from '../../scripts/migrate-short-hash-plan-artifacts';

type MigrationSummary = ReturnType<typeof runMigration>;

interface FixtureDir {
  rootDir: string;
  jiraDir: string;
}

interface ArtifactPaths {
  shortPlanPath: string;
  shortManifestPath: string;
  canonicalPlanPath: string;
  canonicalManifestPath: string;
}

function setupFixtureDir(): FixtureDir {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-migrate-plan-'));
  const jiraDir = path.join(rootDir, 'repo-a', 'jira');
  fs.mkdirSync(jiraDir, { recursive: true });
  return { rootDir, jiraDir };
}

function buildPlanData() {
  return {
    action: 'fix',
    summary: 'Normalize artifact naming',
    estimatedComplexity: 'low',
    steps: ['rename file'],
  };
}

function writePlanArtifact(shortPlanPath: string): void {
  fs.writeFileSync(shortPlanPath, JSON.stringify(buildPlanData(), null, 2));
}

function buildManifestData(shortPlanPath: string) {
  return {
    artifactPath: shortPlanPath,
    action: 'fix',
    createdAt: '2026-04-29T09:00:00.000Z',
    format: 'json',
    hash: '91d8ea76',
    sourceKind: 'ticket',
    sourceName: 'WBP-42',
    ticketKey: 'WBP-42',
  };
}

function writeManifestArtifact(shortManifestPath: string, shortPlanPath: string): void {
  const data = buildManifestData(shortPlanPath);
  fs.writeFileSync(shortManifestPath, JSON.stringify(data, null, 2));
}

function assertMigrationResults(summary: MigrationSummary, paths: ArtifactPaths): void {
  if (summary.convertedCount !== 1) {
    throw new Error(`Expected convertedCount=1, got ${summary.convertedCount}`);
  }
  if (!fs.existsSync(paths.canonicalPlanPath)) {
    throw new Error('Canonical plan artifact was not created');
  }
  if (!fs.existsSync(paths.canonicalManifestPath)) {
    throw new Error('Canonical manifest was not created');
  }
  if (fs.existsSync(paths.shortPlanPath) || fs.existsSync(paths.shortManifestPath)) {
    throw new Error('Short hashed source artifacts were not removed');
  }
}

function main(): void {
  console.log('Manual: migrate short hashed plan artifacts');
  const { rootDir, jiraDir } = setupFixtureDir();
  const shortPlanPath = path.join(jiraDir, '91d8ea76-fix-plan.json');
  const shortManifestPath = path.join(jiraDir, '91d8ea76-fix-plan.sources.json');
  writePlanArtifact(shortPlanPath);
  writeManifestArtifact(shortManifestPath, shortPlanPath);
  const summary = runMigration({ rootDir });
  const canonicalPlanPath = path.join(jiraDir, '2026-04-29-91d8ea76-fix-plan.json');
  const canonicalManifestPath = path.join(jiraDir, '2026-04-29-91d8ea76-fix-plan.sources.json');
  assertMigrationResults(summary, { shortPlanPath, shortManifestPath, canonicalPlanPath, canonicalManifestPath });
  console.log('PASS');
}

main();
