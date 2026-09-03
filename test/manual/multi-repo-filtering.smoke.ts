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
 * Run: nr test:manual -- test-multi-repo-filtering
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

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: multi-repo filtering\n'));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  try {
    const command = app.get(IssueImplementCommand);
    const agent = app.get(ImplementerAgent);

    // --- filterActiveRepos tests (command level) ---
    console.log(chalk.bold('  filterActiveRepos'));

    const filterActiveRepos = (command as any).filterActiveRepos.bind(command);

    // 1. Skips repos not in affectedRepositories
    const plan1 = buildPlan({ affectedRepositories: ['repo-a'] });
    const result1 = filterActiveRepos(['repo-a', 'repo-b'], plan1);
    assert('skips repos not in affectedRepositories', result1.length === 1 && result1[0] === 'repo-a');

    // 2. Keeps all repos when affectedRepositories is empty
    const plan2 = buildPlan({ affectedRepositories: [] });
    const result2 = filterActiveRepos(['repo-a', 'repo-b'], plan2);
    assert('keeps all repos when affectedRepositories is empty', result2.length === 2);

    // 3. Always keeps undefined (cwd mode)
    const plan3 = buildPlan({ affectedRepositories: ['repo-a'] });
    const result3 = filterActiveRepos([undefined, 'repo-b'], plan3);
    assert('always keeps undefined (cwd mode)', result3.length === 1 && result3[0] === undefined);

    // 4. Falls back to full list when filtering removes all repos
    const plan4 = buildPlan({ affectedRepositories: ['repo-c'] });
    const result4 = filterActiveRepos(['repo-a', 'repo-b'], plan4);
    assert('falls back to full list when all repos would be removed', result4.length === 2);

    // --- filterStepsForRepo tests (agent level) ---
    console.log(chalk.bold('\n  filterStepsForRepo'));

    const filterStepsForRepo = (agent as any).filterStepsForRepo.bind(agent);

    // 5. Excludes steps referencing another repo's files
    const steps5 = [
      'Update repo-a/src/services/booking.mapper.ts',
      'Update cop-nuxt-app/src/services/booking.service.ts',
      'Run verification tests',
    ];
    const result5 = filterStepsForRepo(steps5, ['repo-a/src/services/booking.mapper.ts'], 'repo-a');
    assert('keeps step referencing this repo', result5.includes('Update repo-a/src/services/booking.mapper.ts'));
    assert('keeps generic step', result5.includes('Run verification tests'));
    assert('cross-repo step is excluded (filtered count equals 2)', result5.length === 2);

    // 6. Passes all steps through for empty repoName
    const steps6 = ['Step A', 'Step B'];
    const result6 = filterStepsForRepo(steps6, ['src/a.ts'], '');
    assert('passes all steps through for empty repoName', result6.length === 2);

    // 7. Passes all steps through for empty repoFiles
    const result7 = filterStepsForRepo(steps6, [], 'repo-a');
    assert('passes all steps through for empty repoFiles', result7.length === 2);

    // 8. Generic steps (no repo-prefixed path) are always included
    const steps8 = ['Run yarn test', 'Check CI status'];
    const result8 = filterStepsForRepo(steps8, ['repo-a/src/a.ts'], 'repo-a');
    assert('generic steps always included', result8.length === 2);

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
