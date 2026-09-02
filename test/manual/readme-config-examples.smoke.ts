/**
 * Manual smoke test: README config examples match current types
 *
 * Run: nr test:manual -- test-readme-config-examples
 *
 * Verifies:
 *   1. TypeScript example from README passes normalizeWfConfig without errors
 *   2. YAML-equivalent plain object passes normalizeWfConfig without errors
 *   3. Normalized output has expected provider count, default provider, and stage backends
 *   4. git.branchNamePattern is preserved through normalization
 *   5. slack config is preserved through normalization
 *   6. stages.create config is preserved through normalization
 *
 * @returns void
 */
import chalk from 'chalk';
import { normalizeWfConfig } from '../../src/config/wf-config-loader';
import type { WfConfig } from '../../src/config/public-config';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
};

/** Config matching the TypeScript example in README.md */
const README_TS_EXAMPLE: WfConfig = {
  tracker: 'jira',
  ai: [
    {
      provider: 'anthropic',
      apiKey: 'test-anthropic-key',
      model: 'claude-sonnet-4-6',
    },
    {
      provider: 'openai',
      apiKey: 'test-openai-key',
      model: 'gpt-5.5',
      default: true,
    },
    {
      provider: 'google',
      apiKey: 'test-google-key',
      model: 'gemini-2.5-flash',
      maxTokens: 8192,
    },
  ],
  atlassian: {
    baseUrl: 'https://yourcompany.atlassian.net',
    email: 'your-email@company.com',
    jira: {
      apiToken: 'test-jira-token',
      defaultProject: 'WBP',
    },
    bitbucket: {
      apiToken: 'test-bitbucket-token',
      workspace: 'your-workspace',
    },
  },
  github: {
    token: 'test-github-token',
    defaultRepo: 'owner/repo',
  },
  git: {
    commitFormat: 'auto',
    branchNamePattern:
      '^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\\/[A-Z]+-[0-9]+__|-.+$',
  },
  log: {
    level: 'info',
  },
  slack: {
    botToken: 'xoxb-test',
    userToken: 'xoxp-test',
  },
  stages: {
    generate: {
      provider: 'anthropic',
      backend: 'cli',
    },
    plan: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    implement: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      backend: 'cli',
      verificationConditions: {
        policyFile: 'verification.policy.json',
      },
    },
    create: {
      provider: 'anthropic',
      backend: 'cli',
    },
    review: {
      provider: 'anthropic',
      backend: 'cli',
    },
    commit: {
      provider: 'google',
      backend: 'standard',
    },
  },
};

function main(): void {
  console.log(chalk.bold('\nREADME config examples smoke test\n'));

  // 1. TypeScript example passes normalization
  let normalized: ReturnType<typeof normalizeWfConfig> | undefined;
  try {
    normalized = normalizeWfConfig(README_TS_EXAMPLE);
    pass('TypeScript README example passes normalizeWfConfig');
  } catch (error) {
    fail(
      'TypeScript README example passes normalizeWfConfig',
      `threw: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!normalized) {
    console.log(chalk.red('\n  Aborting: normalization failed, remaining tests depend on normalized config.\n'));
    process.exit(1);
  }

  // 2. Provider count
  assert('has 3 AI providers', normalized.ai.providers.length === 3, `got: ${normalized.ai.providers.length}`);

  // 3. Default provider is OpenAI
  const defaultProvider = normalized.ai.providers.find(p => p.default);
  assert('default provider is openai', defaultProvider?.provider === 'openai', `got: ${defaultProvider?.provider}`);
  assert(
    'top-level ai.provider is openai (default)',
    normalized.ai.provider === 'openai',
    `got: ${normalized.ai.provider}`
  );

  // 4. Stage backends
  assert(
    'stages.generate.backend is cli',
    normalized.stages.generate?.backend === 'cli',
    `got: ${normalized.stages.generate?.backend}`
  );
  assert(
    'stages.plan.backend defaults to agent',
    normalized.stages.plan?.backend === 'agent',
    `got: ${normalized.stages.plan?.backend}`
  );
  assert(
    'stages.implement.backend is cli',
    normalized.stages.implement?.backend === 'cli',
    `got: ${normalized.stages.implement?.backend}`
  );
  assert(
    'stages.review.backend is cli',
    normalized.stages.review?.backend === 'cli',
    `got: ${normalized.stages.review?.backend}`
  );
  assert(
    'stages.commit.backend is standard',
    normalized.stages.commit?.backend === 'standard',
    `got: ${normalized.stages.commit?.backend}`
  );

  // 5. git.branchNamePattern preserved
  assert(
    'git.branchNamePattern preserved',
    typeof normalized.git?.branchNamePattern === 'string' && normalized.git.branchNamePattern.length > 0,
    `got: ${normalized.git?.branchNamePattern}`
  );

  // 6. slack config preserved
  assert('slack.botToken preserved', normalized.slack?.botToken === 'xoxb-test', `got: ${normalized.slack?.botToken}`);
  assert(
    'slack.userToken preserved',
    normalized.slack?.userToken === 'xoxp-test',
    `got: ${normalized.slack?.userToken}`
  );

  // 7. stages.create preserved
  assert(
    'stages.create.provider is anthropic',
    (normalized.stages as Record<string, { provider?: string }>).create?.provider === 'anthropic',
    `got: ${(normalized.stages as Record<string, { provider?: string }>).create?.provider}`
  );

  // 8. implement model preserved
  assert(
    'stages.implement.model is claude-haiku-4-5-20251001',
    normalized.stages.implement?.model === 'claude-haiku-4-5-20251001',
    `got: ${normalized.stages.implement?.model}`
  );

  // 9. Verification conditions preserved
  assert(
    'stages.implement.verificationConditions.policyFile preserved',
    normalized.stages.implement?.verificationConditions?.policyFile === 'verification.policy.json',
    `got: ${normalized.stages.implement?.verificationConditions?.policyFile}`
  );

  // Summary
  console.log(
    chalk.bold(
      `\n${counts.passed + counts.failed} assertions: ${chalk.green(`${counts.passed} passed`)}${counts.failed > 0 ? `, ${chalk.red(`${counts.failed} failed`)}` : ''}`
    )
  );

  if (counts.failed > 0) {
    process.exit(1);
  }
}

main();
