/**
 * Smoke test: multi-repo repo skipping and plan step filtering
 *
 * Verifies:
 *   1. filterActiveRepos skips repos not in plan.affectedRepositories
 *   2. filterActiveRepos keeps undefined (cwd mode) entries
 *   3. filterActiveRepos falls back to full list when all repos would be removed
 *   4. filterStepsForRepo excludes steps referencing another repo's files
 *   5. filterStepsForRepo passes all steps through for empty repoName or repoFiles
 *
 * Run: nr test:manual multi-repo-filtering.smoke.ts
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { IssueImplementCommand } from '../../src/commands/issue-implement.command';
import type { PlanArtifact } from '../../src/agents/interfaces';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}`));
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

type StepFilter = (steps: string[], files: string[], repo: string) => string[];

function runFilterActiveReposChecks(command: IssueImplementCommand): void {
  console.log(chalk.bold('  filterActiveRepos'));
  const filter = (command as any).filterActiveRepos.bind(command);
  const result1 = filter(['repo-a', 'repo-b'], buildPlan({ affectedRepositories: ['repo-a'] }));
  assert('skips repos not in affectedRepositories', result1.length === 1 && result1[0] === 'repo-a');
  const result2 = filter(['repo-a', 'repo-b'], buildPlan({ affectedRepositories: [] }));
  assert('keeps all repos when affectedRepositories is empty', result2.length === 2);
  const result3 = filter([undefined, 'repo-b'], buildPlan({ affectedRepositories: ['repo-a'] }));
  assert('always keeps undefined (cwd mode)', result3.length === 1 && result3[0] === undefined);
  const result4 = filter(['repo-a', 'repo-b'], buildPlan({ affectedRepositories: ['repo-c'] }));
  assert('falls back to full list when all repos would be removed', result4.length === 2);
}

function checkCrossRepoStepFiltering(filter: StepFilter): void {
  const steps = [
    'Update repo-a/src/services/booking.mapper.ts',
    'Update cop-nuxt-app/src/services/booking.service.ts',
    'Run verification tests',
  ];
  const result = filter(steps, ['repo-a/src/services/booking.mapper.ts'], 'repo-a');
  assert('keeps step referencing this repo', result.includes('Update repo-a/src/services/booking.mapper.ts'));
  assert('keeps generic step', result.includes('Run verification tests'));
  assert('cross-repo step is excluded (filtered count equals 2)', result.length === 2);
}

function checkPassthroughFiltering(filter: StepFilter): void {
  const steps = ['Step A', 'Step B'];
  assert('passes all steps through for empty repoName', filter(steps, ['src/a.ts'], '').length === 2);
  assert('passes all steps through for empty repoFiles', filter(steps, [], 'repo-a').length === 2);
  const genericSteps = ['Run yarn test', 'Check CI status'];
  assert('generic steps always included', filter(genericSteps, ['repo-a/src/a.ts'], 'repo-a').length === 2);
}

function runFilterStepsForRepoChecks(agent: ImplementerAgent): void {
  console.log(chalk.bold('\n  filterStepsForRepo'));
  const filter = (agent as any).filterStepsForRepo.bind(agent) as StepFilter;
  checkCrossRepoStepFiltering(filter);
  checkPassthroughFiltering(filter);
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: multi-repo filtering\n'));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    runFilterActiveReposChecks(app.get(IssueImplementCommand));
    runFilterStepsForRepoChecks(app.get(ImplementerAgent));
    console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
    if (failed > 0) process.exit(1);
  } finally {
    await app.close();
  }
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
