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
 * Run: nr test:manual multi-repo-skip-message.smoke.ts
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import { createReporter, summarise } from './support/reporter';
import type { PlanArtifact } from '../../src/agents/interfaces';

const { counts, pass, fail } = createReporter();

const buildPlan = (overrides?: Partial<PlanArtifact['plan']>): PlanArtifact => ({
  action: 'fix',
  path: '/tmp/.wf/repo-a/jira/plan.json',
  plan: {
    action: 'fix',
    summary: 'Test plan',
    steps: [{ description: 'Update a file' }],
    estimatedComplexity: 'low' as const,
    affectedFiles: ['repo-a/src/a.ts'],
    affectedRepositories: ['repo-a'],
    ...overrides,
  },
});

function captureSkipLog(filterActiveRepos: (...args: unknown[]) => unknown): string {
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  const plan1 = buildPlan({ affectedRepositories: ['repo-a'], newRepositories: [] });
  filterActiveRepos(['repo-a', 'repo-b'], plan1);
  console.log = original;
  return logged.join('\n');
}

function captureNewRepoLog(filterActiveRepos: (...args: unknown[]) => unknown): { result: string[]; plain: string } {
  const logged2: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logged2.push(args.map(String).join(' '));
  const plan2 = buildPlan({ affectedRepositories: ['repo-a'], newRepositories: ['brand-new-service'] });
  const result = filterActiveRepos(['repo-a', 'brand-new-service', 'repo-b'], plan2) as string[];
  console.log = original;
  return { result, plain: logged2.join('\n') };
}

function checkSkipMessageContent(plain: string): void {
  if (plain.includes("not in plan's affected or new repositories")) {
    pass('message says "not in plan\'s affected or new repositories"');
  } else {
    fail('message says "not in plan\'s affected or new repositories"');
  }
  if (plain.includes("not in plan's affected repositories")) {
    fail('old message fragment absent');
  } else {
    pass('old message fragment absent');
  }
}

function checkBrandNewServiceSkipless(plain: string): void {
  if (plain.includes('brand-new-service')) {
    fail('no skip message for brand-new-service');
  } else {
    pass('no skip message for brand-new-service');
  }
}

function checkNewRepositoryIsKept(result: string[], plain: string): void {
  if (result.includes('brand-new-service')) {
    pass('brand-new-service kept in result');
  } else {
    fail('brand-new-service kept in result');
  }
  if (result.includes('repo-b')) {
    fail('repo-b removed from result');
  } else {
    pass('repo-b removed from result');
  }
  checkBrandNewServiceSkipless(plain);
}

async function runTests(filterActiveRepos: (...args: unknown[]) => unknown): Promise<void> {
  console.log(chalk.bold('  1. skip message for repo absent from affected + new'));
  checkSkipMessageContent(captureSkipLog(filterActiveRepos));
  console.log(chalk.bold('\n  2. repo in newRepositories is NOT skipped'));
  const { result, plain } = captureNewRepoLog(filterActiveRepos);
  checkNewRepositoryIsKept(result, plain);
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: filterActiveRepos skip log message\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const command = app.get(IssueImplementCommand);
    const filterActiveRepos = (command as any).filterActiveRepos.bind(command);
    await runTests(filterActiveRepos);
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
