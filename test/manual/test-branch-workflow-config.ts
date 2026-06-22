/**
 * Manual smoke test: branch workflow config migration
 *
 * Run: nr test:manual -- test-branch-workflow-config
 *
 * Verifies:
 *   1. `branching.*` keys are rejected by the Joi schema
 *   2. `git.defaultBranch` is rejected by the Joi schema
 *   3. `git.branchNamePattern` defaults to the Atlassian regex
 *   4. `git.branchPrefixMapping` defaults correctly
 *   5. `git.commitFormat` defaults to 'auto' when omitted
 *   6. Custom `git.branchNamePattern` is accepted and preserved
 *   7. Custom `git.branchPrefixMapping` is accepted and preserved
 *   8. `GitService.detectDevelopmentBranches` returns all branches containing 'dev'
 *   9. `GitService.detectMainBranch` returns 'main' or 'master'
 *  10. `stages.implement.model` + `stages.implement.models` throws mutual exclusion error
 *
 * @returns void
 */
import chalk from 'chalk';
import { normalizeWfConfig } from '../../src/config/wf-config-loader';
import { GitService } from '../../src/integrations/git/git.service';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
};

function main(): void {
  console.log(chalk.bold('\nBranch workflow config migration smoke test\n'));

  // 1. branching.* keys rejected
  try {
    normalizeWfConfig({ branching: { atlassianPattern: '^test$' } } as never);
    fail('branching.* keys should be rejected');
  } catch {
    pass('branching.* keys are rejected by Joi schema');
  }

  // 2. git.defaultBranch rejected
  try {
    normalizeWfConfig({ git: { defaultBranch: 'develop' } } as never);
    fail('git.defaultBranch should be rejected');
  } catch {
    pass('git.defaultBranch is rejected by Joi schema');
  }

  // 3. git.branchNamePattern defaults
  const defaultConfig = normalizeWfConfig({});
  assert(
    'git.branchNamePattern defaults to Atlassian regex',
    defaultConfig.git.branchNamePattern.startsWith('^(bugfix|build|chore|'),
    `Got: ${defaultConfig.git.branchNamePattern}`,
  );

  // 4. git.branchPrefixMapping defaults
  assert(
    'git.branchPrefixMapping.feature defaults to "feature"',
    defaultConfig.git.branchPrefixMapping.feature === 'feature',
  );
  assert(
    'git.branchPrefixMapping.fix defaults to "bugfix"',
    defaultConfig.git.branchPrefixMapping.fix === 'bugfix',
  );
  assert(
    'git.branchPrefixMapping.investigate defaults to "chore"',
    defaultConfig.git.branchPrefixMapping.investigate === 'chore',
  );

  // 5. git.commitFormat defaults
  assert(
    'git.commitFormat defaults to "auto" when omitted',
    defaultConfig.git.commitFormat === 'auto',
    `Got: ${defaultConfig.git.commitFormat}`,
  );

  // 6. Custom branchNamePattern
  const customPatternConfig = normalizeWfConfig({
    git: { branchNamePattern: '^custom/.+$' },
  });
  assert(
    'Custom git.branchNamePattern is preserved',
    customPatternConfig.git.branchNamePattern === '^custom/.+$',
  );

  // 7. Custom branchPrefixMapping
  const customPrefixConfig = normalizeWfConfig({
    git: {
      branchPrefixMapping: {
        feature: 'feat',
        fix: 'fix',
        investigate: 'research',
      },
    },
  });
  assert(
    'Custom git.branchPrefixMapping.feature is preserved',
    customPrefixConfig.git.branchPrefixMapping.feature === 'feat',
  );

  // 8. GitService.detectDevelopmentBranches
  const gitService = new (GitService as any)(
    { get: () => undefined },
    { warn: () => {}, success: () => {} },
  );
  const devBranches = gitService.detectDevelopmentBranches([
    'main',
    'develop',
    'dev',
    'feature/something',
  ]);
  assert(
    'detectDevelopmentBranches returns all branches containing "dev"',
    devBranches.length === 2 &&
      devBranches.includes('develop') &&
      devBranches.includes('dev'),
    `Got: ${JSON.stringify(devBranches)}`,
  );

  // 9. GitService.detectMainBranch
  const mainBranch = gitService.detectMainBranch([
    'develop',
    'main',
    'feature/x',
  ]);
  assert(
    'detectMainBranch returns "main"',
    mainBranch === 'main',
    `Got: ${mainBranch}`,
  );
  const masterBranch = gitService.detectMainBranch([
    'develop',
    'master',
    'feature/x',
  ]);
  assert(
    'detectMainBranch returns "master" when no "main" exists',
    masterBranch === 'master',
    `Got: ${masterBranch}`,
  );

  // 10. model + models mutual exclusion
  try {
    const {
      resolveModelRouting,
    } = require('../../src/integrations/ai/adapters/shared-routing');
    resolveModelRouting({
      routing: 'auto',
      fallbackDefaultModel: 'claude-sonnet-4-6',
      defaultMechanicalModel: 'claude-haiku-4-5',
      configService: {
        get: (key: string) => {
          if (key === 'stages.implement.model') return 'claude-sonnet-4-6';
          if (key === 'stages.implement.models')
            return { mechanical: 'claude-haiku-4-5' };
          return undefined;
        },
      },
      plan: { steps: ['test'], estimatedComplexity: 'low' },
      adapterLabel: 'test',
    });
    fail('model + models should throw mutual exclusion error');
  } catch (error) {
    assert(
      'model + models throws mutual exclusion error',
      (error as Error).message.includes('mutually exclusive'),
      (error as Error).message,
    );
  }

  // Summary
  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) {
    process.exit(1);
  }
}

main();
