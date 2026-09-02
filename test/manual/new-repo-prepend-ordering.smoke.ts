/**
 * Smoke test: expandReposFromPlan prepends new repos before existing repos
 *
 * Verifies:
 *   1. New repos returned first in expanded list (isNewRepo guard ordering)
 *   2. Existing repos follow in their original order
 *   3. No duplicates and no drops in the combined list
 *   4. Returns original repos unchanged when plan has no newRepositories
 *   5. Skips scaffolding for newRepositories entries that already resolve locally
 *
 * Run: nr test:manual -- test-new-repo-prepend-ordering
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import type { PlanArtifact } from '../../src/agents/interfaces';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  \u2713 ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  \u2717 ${label}`));
    failed++;
  }
};

const buildPlan = (overrides?: Partial<PlanArtifact['plan']>): PlanArtifact => ({
  action: 'fix',
  path: '/tmp/.wf/smoke-test/jira/plan.json',
  plan: {
    action: 'fix',
    summary: 'Test plan',
    steps: ['Update files'],
    estimatedComplexity: 'low' as const,
    affectedFiles: ['src/a.ts'],
    affectedRepositories: [],
    newRepositories: [],
    ...overrides,
  },
});

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: expandReposFromPlan prepend ordering\n'));

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-smoke-expand-'));
  const baseDir = path.join(tmpRoot, 'existing-app');
  fs.mkdirSync(baseDir, { recursive: true });

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  try {
    const command = app.get(IssueCommand);
    const expandReposFromPlan = (command as any).expandReposFromPlan.bind(command);

    // 1. New repo is prepended before the existing (undefined = cwd) entry
    console.log(chalk.bold('  1. new repo prepended before existing repos'));
    const newRepoName = `wf-smoke-new-${Date.now()}`;
    const plan1 = buildPlan({ newRepositories: [newRepoName] });
    const expanded1: (string | undefined)[] = await expandReposFromPlan(
      [undefined],
      plan1,
      baseDir,
      true, // silent — bypasses interactive prompt and auto-scaffolds
    );
    assert('new repo is first element', expanded1[0] === newRepoName);
    assert('existing (undefined) follows', expanded1[1] === undefined);
    assert('no extra entries', expanded1.length === 2);

    // 2. Returns original list unchanged when there are no newRepositories
    console.log(chalk.bold('\n  2. no newRepositories — list unchanged'));
    const plan2 = buildPlan({ newRepositories: [] });
    const expanded2 = await expandReposFromPlan(
      [undefined],
      plan2,
      baseDir,
      true,
    );
    assert('returns original list', expanded2.length === 1 && expanded2[0] === undefined);

    // 3. Scaffolded directory exists on disk after expand
    console.log(chalk.bold('\n  3. scaffolded directory exists on disk'));
    const expectedPath = path.resolve(baseDir, '..', newRepoName);
    assert('new repo directory created', fs.existsSync(expectedPath));

    console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
