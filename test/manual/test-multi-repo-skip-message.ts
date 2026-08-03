/**
 * Smoke test: filterActiveRepos skip log includes "or new repositories"
 *
 * Verifies:
 *   1. filterActiveRepos skips repos absent from affectedRepositories and the
 *      console message says "not in plan's affected or new repositories"
 *   2. A repo in newRepositories is NOT skipped and produces no log message
 *   3. The old message fragment "not in plan's affected repositories" (without
 *      "or new") never appears
 *
 * Run: nr test:manual -- test-multi-repo-skip-message
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
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
  path: '/tmp/.wf/repo-a/jira/plan.json',
  plan: {
    action: 'fix',
    summary: 'Test plan',
    steps: ['Update a file'],
    estimatedComplexity: 'low' as const,
    affectedFiles: ['repo-a/src/a.ts'],
    affectedRepositories: ['repo-a'],
    ...overrides,
  },
});

async function main() {
  console.log(chalk.bold.cyan('\nSmoke test: filterActiveRepos skip log message\n'));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  try {
    const command = app.get(IssueImplementCommand);
    const filterActiveRepos = (command as any).filterActiveRepos.bind(command);

    // 1. Skipped repo produces the updated message
    console.log(chalk.bold('  1. skip message for repo absent from affected + new'));
    const logged: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));

    const plan1 = buildPlan({ affectedRepositories: ['repo-a'], newRepositories: [] });
    filterActiveRepos(['repo-a', 'repo-b'], plan1);

    console.log = original;

    const plain = logged.join('\n');
    assert(
      'message says "not in plan\'s affected or new repositories"',
      plain.includes("not in plan's affected or new repositories"),
    );
    assert(
      'old message fragment absent',
      !plain.includes("not in plan's affected repositories"),
    );

    // 2. A repo in newRepositories is kept and produces no skip log
    console.log(chalk.bold('\n  2. repo in newRepositories is NOT skipped'));
    const logged2: string[] = [];
    console.log = (...args: unknown[]) => logged2.push(args.map(String).join(' '));

    const plan2 = buildPlan({
      affectedRepositories: ['repo-a'],
      newRepositories: ['brand-new-service'],
    });
    const result2 = filterActiveRepos(['repo-a', 'brand-new-service', 'repo-b'], plan2);

    console.log = original;

    assert('brand-new-service kept in result', result2.includes('brand-new-service'));
    assert('repo-b removed from result', !result2.includes('repo-b'));

    const plain2 = logged2.join('\n');
    assert('no skip message for brand-new-service', !plain2.includes('brand-new-service'));

    console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await app.close();
  }
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
