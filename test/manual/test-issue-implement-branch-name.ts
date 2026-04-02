/**
 * Manual Test: issue:implement branch name generation
 *
 * Run: npm run test:manual -- test-issue-implement-branch-name
 *
 * Verifies:
 *   1. ImplementerAgent creates a git branch using the full ticket summary slug
 *   2. Long Jira summaries are not truncated to 50 characters
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { NestFactory } from '@nestjs/core';
import * as os from 'os';
import * as path from 'path';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import type { PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import { AppModule } from '../../src/app.module';

let passed = 0;
let failed = 0;

const pass = (message: string) => {
  console.log(`  ✓ ${message}`);
  passed++;
};

const fail = (message: string, detail?: string) => {
  console.error(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`);
  failed++;
};

const runGit = (repoDir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' }).trim();

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const implementer = app.get(ImplementerAgent);

  console.log(
    '\n🧪 Test: full branch name for long Jira summary\n' + '─'.repeat(60),
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-branch-name-'));
  const repoDir = path.join(tempRoot, 'service-tourv3');
  fs.mkdirSync(repoDir, { recursive: true });

  runGit(repoDir, ['init', '-b', 'main']);
  runGit(repoDir, ['config', 'user.name', 'WF Manual Test']);
  runGit(repoDir, ['config', 'user.email', 'wf-manual-test@example.com']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# temp repo\n', 'utf-8');
  runGit(repoDir, ['add', 'README.md']);
  runGit(repoDir, ['commit', '-m', 'chore: initial commit']);

  const ticket: TicketArtifact = {
    ticketKey: 'WBP-3054',
    content:
      '# WBP-3054: Trip.com Content Mapping: Align Contentful Fields to Trip.com Preview Structure\n\n## Description\n\nManual test.',
    path: path.join(tempRoot, 'WBP-3054.md'),
  };

  const planArtifact: PlanArtifact = {
    plan: {
      action: 'feature',
      summary: 'Manual branch generation test',
      steps: ['Verify branch name generation'],
      estimatedComplexity: 'low',
      filesAffected: [],
      repositoriesAffected: ['service-tourv3'],
      risks: [],
    },
    action: 'feature',
    path: path.join(tempRoot, 'WBP-3054-plan-feature.json'),
  };

  (implementer as any).aiService.narrateImplementationPlan = async () =>
    '## Goal\nVerify long branch names.\n';

  const result = await implementer.execute(ticket, planArtifact, {
    platformName: 'jira',
    repoDir,
    suppressHeader: true,
  });

  const expectedBranchName =
    'feature/WBP-3054__tripcom-content-mapping-align-contentful-fields-to-tripcom-preview-structure';
  const currentBranchName = runGit(repoDir, ['branch', '--show-current']);

  if (result.type === 'implementation') {
    if (result.branchName === expectedBranchName) {
      pass(
        `Returned branch name matches expected value: ${expectedBranchName}`,
      );
    } else {
      fail(
        'Returned branch name did not match expected value',
        `expected: ${expectedBranchName}\nreceived: ${result.branchName}`,
      );
    }
  } else {
    fail('Implementer returned investigation result for a feature plan');
  }

  if (currentBranchName === expectedBranchName) {
    pass(`Git checked out expected branch: ${expectedBranchName}`);
  } else {
    fail(
      'Git checked out an unexpected branch',
      `expected: ${expectedBranchName}\nreceived: ${currentBranchName}`,
    );
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
  await app.close();

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) console.log('✅ All tests passed!');
  console.log('━'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
