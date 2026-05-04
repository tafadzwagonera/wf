import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const runCommand = (cmd: string): string =>
  execSync(cmd, {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf-8',
    env: process.env,
  });

const run = (): void => {
  console.log('Manual: issue force artifact behavior');
  const repoName = 'wf';
  const artifactDir = path.join(os.homedir(), '.wf', repoName, 'jira');
  fs.mkdirSync(artifactDir, { recursive: true });

  const ticketPath = path.join(artifactDir, 'WBP-999.md');
  const planPath = path.join(artifactDir, '2026-05-04-deadbeef-fix-plan.json');
  const planManifestPath = path.join(
    artifactDir,
    '2026-05-04-deadbeef-fix-plan.sources.json',
  );
  const reviewPath = path.join(artifactDir, 'WBP-999-review.md');

  fs.writeFileSync(ticketPath, '# WBP-999: test ticket');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        action: 'fix',
        summary: 'test',
        estimatedComplexity: 'low',
        steps: ['test'],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    planManifestPath,
    JSON.stringify(
      {
        artifactPath: planPath,
        action: 'fix',
        createdAt: '2026-05-04T00:00:00.000Z',
        format: 'json',
        hash: 'deadbeef',
        sourceKind: 'ticket',
        sourceName: 'WBP-999',
        ticketKey: 'WBP-999',
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    reviewPath,
    '# Code Review: WBP-999\n\n## Approval Status\n✓ Approved\n',
  );

  const withoutForce = runCommand(
    'npm run -s start -- issue WBP-999 --from fetch --to review --action fix --dry-run',
  );
  const withForce = runCommand(
    'npm run -s start -- issue WBP-999 --from fetch --to review --action fix --dry-run --force',
  );

  if (!withoutForce.includes('artifact exists')) {
    throw new Error('Expected non-force run to report artifact exists');
  }
  if (withForce.includes('artifact exists')) {
    throw new Error('Expected force run to avoid skip-by-artifact path');
  }

  console.log('PASS');
};

run();
