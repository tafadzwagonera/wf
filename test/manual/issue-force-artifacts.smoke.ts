import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const runCommand = (cmd: string): string =>
  execSync(cmd, {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf-8',
    env: process.env,
  });

function writeArtifacts(
  artifactDir: string,
  ticketPath: string,
  planPath: string,
  planManifestPath: string,
  reviewPath: string,
): void {
  fs.writeFileSync(ticketPath, '# WBP-999: test ticket');
  fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'test', estimatedComplexity: 'low', steps: ['test'] }, null, 2));
  fs.writeFileSync(
    planManifestPath,
    JSON.stringify({ artifactPath: planPath, action: 'fix', createdAt: '2026-05-04T00:00:00.000Z', format: 'json', hash: 'deadbeef', sourceKind: 'ticket', sourceName: 'WBP-999', ticketKey: 'WBP-999' }, null, 2)
  );
  fs.writeFileSync(reviewPath, '# Code Review: WBP-999\n\n## Approval Status\n✓ Approved\n');
}

function checkWithoutForce(withoutForce: string): void {
  if (!withoutForce.includes('artifact exists')) {
    throw new Error('Expected non-force run to report artifact exists');
  }
}

function checkWithForce(withForce: string): void {
  if (withForce.includes('artifact exists')) {
    throw new Error('Expected force run to avoid skip-by-artifact path');
  }
}

type ArtifactPaths = {
  artifactDir: string;
  ticketPath: string;
  planPath: string;
  planManifestPath: string;
  reviewPath: string;
};

function prepareArtifactDir(): ArtifactPaths {
  const repoName = 'wf';
  const artifactDir = path.join(os.homedir(), '.wf', repoName, 'jira');
  fs.mkdirSync(artifactDir, { recursive: true });
  return {
    artifactDir,
    ticketPath: path.join(artifactDir, 'WBP-999.md'),
    planPath: path.join(artifactDir, '2026-05-04-deadbeef-fix-plan.json'),
    planManifestPath: path.join(artifactDir, '2026-05-04-deadbeef-fix-plan.sources.json'),
    reviewPath: path.join(artifactDir, 'WBP-999-review.md'),
  };
}

function main(): void {
  console.log('Manual: issue force artifact behavior');
  const { artifactDir, ticketPath, planPath, planManifestPath, reviewPath } = prepareArtifactDir();
  writeArtifacts(artifactDir, ticketPath, planPath, planManifestPath, reviewPath);
  const withoutForce = runCommand('yarn -s start -- issue WBP-999 --from fetch --to review --action fix --dry-run');
  const withForce = runCommand('yarn -s start -- issue WBP-999 --from fetch --to review --action fix --dry-run --force');
  checkWithoutForce(withoutForce);
  checkWithForce(withForce);
  console.log('PASS');
}

main();
