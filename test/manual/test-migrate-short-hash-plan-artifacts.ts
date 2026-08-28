import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMigration } from '../../scripts/migrate-short-hash-plan-artifacts';

const run = (): void => {
  console.log('Manual: migrate short hashed plan artifacts');
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-migrate-plan-'));
  const jiraDir = path.join(rootDir, 'repo-a', 'jira');
  fs.mkdirSync(jiraDir, { recursive: true });

  const shortPlanPath = path.join(jiraDir, '91d8ea76-fix-plan.json');
  const shortManifestPath = path.join(jiraDir, '91d8ea76-fix-plan.sources.json');
  fs.writeFileSync(
    shortPlanPath,
    JSON.stringify(
      {
        action: 'fix',
        summary: 'Normalize artifact naming',
        estimatedComplexity: 'low',
        steps: ['rename file'],
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    shortManifestPath,
    JSON.stringify(
      {
        artifactPath: shortPlanPath,
        action: 'fix',
        createdAt: '2026-04-29T09:00:00.000Z',
        format: 'json',
        hash: '91d8ea76',
        sourceKind: 'ticket',
        sourceName: 'WBP-42',
        ticketKey: 'WBP-42',
      },
      null,
      2
    )
  );

  const summary = runMigration({ rootDir });
  const canonicalPlanPath = path.join(jiraDir, '2026-04-29-91d8ea76-fix-plan.json');
  const canonicalManifestPath = path.join(jiraDir, '2026-04-29-91d8ea76-fix-plan.sources.json');

  if (summary.convertedCount !== 1) {
    throw new Error(`Expected convertedCount=1, got ${summary.convertedCount}`);
  }
  if (!fs.existsSync(canonicalPlanPath)) {
    throw new Error('Canonical plan artifact was not created');
  }
  if (!fs.existsSync(canonicalManifestPath)) {
    throw new Error('Canonical manifest was not created');
  }
  if (fs.existsSync(shortPlanPath) || fs.existsSync(shortManifestPath)) {
    throw new Error('Short hashed source artifacts were not removed');
  }

  console.log('PASS');
};

run();
