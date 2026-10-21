import * as path from 'node:path';

export type FieldCaseKind = 'roundTrip' | 'transformed' | 'dropped' | 'rejectedAtLoad';

export type FieldCase = {
  schemaPath: string;
  fixtures?: Array<{ path: string; value: unknown }>;
  kind: FieldCaseKind;
  reason?: string;
  expectations?: Array<{ path: string; value: unknown }>;
  rejection?: { rawConfig: Record<string, unknown>; message: RegExp };
};

type FieldCaseInput = {
  schemaPath: string;
  fixtures: Array<{ path: string; value: unknown }>;
  expectations: Array<{ path: string; value: unknown }>;
  kind?: FieldCaseKind;
  reason?: string;
  rejection?: FieldCase['rejection'];
};

const fieldCase = ({
  schemaPath,
  fixtures,
  expectations,
  kind = 'roundTrip',
  reason,
  rejection,
}: FieldCaseInput): FieldCase => ({
  schemaPath,
  fixtures,
  expectations,
  kind,
  ...(reason && { reason }),
  ...(rejection && { rejection }),
});

const roundTrip = (schemaPath: string, fixturePath: string, value: unknown, expectedPaths = [fixturePath]): FieldCase =>
  fieldCase({
    schemaPath,
    fixtures: [{ path: fixturePath, value }],
    expectations: expectedPaths.map(expectedPath => ({ path: expectedPath, value })),
  });

const plain = (schemaPath: string, value: unknown): FieldCase => roundTrip(schemaPath, schemaPath, value);

type StageName = 'plan' | 'implement' | 'review' | 'generate' | 'commit';

const stageField = (stage: StageName, field: string, value: unknown): FieldCase => {
  const stagePath = `stages.${stage}.${field}`;
  const publishedPaths = stage === 'implement' ? [stagePath] : [stagePath, `ai.stages.${stage}.${field}`];
  return roundTrip(stagePath, stagePath, value, publishedPaths);
};

const stageExtra = (stage: StageName, field: string, value: unknown): FieldCase => plain(`stages.${stage}.${field}`, value);

type ProviderFixture = { provider: string; apiKey: string; model: string; maxTokens: number; default?: boolean };

const providerFixtures: ProviderFixture[] = [
  { provider: 'anthropic', apiKey: 'anthropic-key-sentinel', model: 'claude-sonnet-4-6', maxTokens: 1111, default: true },
  { provider: 'openai', apiKey: 'openai-key-sentinel', model: 'gpt-4o', maxTokens: 2222, default: false },
  { provider: 'google', apiKey: 'gemini-key-sentinel', model: 'gemini-2.5-pro', maxTokens: 2048 },
  { provider: 'deepseek', apiKey: 'deepseek-key-sentinel', model: 'deepseek-chat', maxTokens: 3333 },
];

const providerFixturesFor = (field: keyof ProviderFixture): Array<{ path: string; value: unknown }> =>
  providerFixtures.flatMap((provider, index) =>
    provider[field] === undefined ? [] : [{ path: `ai.${index}.${field}`, value: provider[field] }]);

const aiProviderCases: FieldCase[] = [
  fieldCase({
    schemaPath: 'ai[].provider',
    fixtures: providerFixturesFor('provider'),
    expectations: [
      ...providerFixtures.map((provider, index) => ({ path: `ai.providers.${index}.provider`, value: provider.provider })),
      { path: 'ai.provider', value: 'anthropic' },
    ],
  }),
  fieldCase({
    schemaPath: 'ai[].apiKey',
    fixtures: providerFixturesFor('apiKey'),
    expectations: [
      ...providerFixtures.map((provider, index) => ({ path: `ai.providers.${index}.apiKey`, value: provider.apiKey })),
      { path: 'ai.apiKey', value: providerFixtures[0].apiKey },
      { path: 'ai.anthropicApiKey', value: providerFixtures[0].apiKey },
      { path: 'ai.openaiApiKey', value: providerFixtures[1].apiKey },
      { path: 'ai.geminiApiKey', value: providerFixtures[2].apiKey },
      { path: 'ai.deepseekApiKey', value: providerFixtures[3].apiKey },
    ],
  }),
  fieldCase({
    schemaPath: 'ai[].model',
    fixtures: providerFixturesFor('model'),
    expectations: [
      ...providerFixtures.map((provider, index) => ({ path: `ai.providers.${index}.model`, value: provider.model })),
      { path: 'ai.model', value: providerFixtures[0].model },
    ],
  }),
  fieldCase({
    schemaPath: 'ai[].maxTokens',
    fixtures: providerFixturesFor('maxTokens'),
    kind: 'transformed',
    reason: 'normalizeProvider keeps maxTokens only for gemini models and nulls it for every other provider',
    expectations: [
      { path: 'ai.providers.0.maxTokens', value: undefined },
      { path: 'ai.providers.1.maxTokens', value: undefined },
      { path: 'ai.providers.2.maxTokens', value: 2048 },
      { path: 'ai.providers.3.maxTokens', value: undefined },
      { path: 'ai.maxTokens', value: undefined },
    ],
  }),
  fieldCase({
    schemaPath: 'ai[].default',
    fixtures: providerFixturesFor('default'),
    expectations: [
      { path: 'ai.providers.0.default', value: true },
      { path: 'ai.providers.1.default', value: false },
      { path: 'ai.providers.2.default', value: false },
    ],
  }),
];

const stageTargetBaseCases: FieldCase[] = [
  stageField('plan', 'provider', 'anthropic'),
  stageField('plan', 'model', 'claude-plan-sentinel'),
  stageField('plan', 'backend', 'agent'),
  stageField('plan', 'maxTokens', 4001),
  stageField('plan', 'outputFormat', 'json'),
  stageField('plan', 'timeoutMs', 5001),
  stageField('plan', 'inactivityTimeoutMs', 6001),
  stageField('implement', 'provider', 'anthropic'),
  stageField('implement', 'backend', 'agent'),
  stageField('implement', 'maxTokens', 4002),
  stageField('implement', 'timeoutMs', 5002),
  stageField('implement', 'inactivityTimeoutMs', 6002),
  stageField('review', 'provider', 'openai'),
  stageField('review', 'model', 'gpt-review-sentinel'),
  stageField('review', 'backend', 'cli'),
  stageField('review', 'maxTokens', 4003),
  stageField('review', 'outputFormat', 'md'),
  stageField('review', 'timeoutMs', 5003),
  stageField('review', 'inactivityTimeoutMs', 6003),
  stageField('generate', 'provider', 'google'),
  stageField('generate', 'model', 'gemini-generate-sentinel'),
  stageField('generate', 'backend', 'standard'),
  stageField('generate', 'maxTokens', 4004),
  stageField('generate', 'outputFormat', 'yaml'),
  stageField('generate', 'timeoutMs', 5004),
  stageField('generate', 'inactivityTimeoutMs', 6004),
  stageField('commit', 'provider', 'deepseek'),
  stageField('commit', 'model', 'deepseek-commit-sentinel'),
  stageField('commit', 'backend', 'standard'),
  stageField('commit', 'maxTokens', 4005),
  stageField('commit', 'outputFormat', 'yml'),
  stageField('commit', 'timeoutMs', 5005),
  stageField('commit', 'inactivityTimeoutMs', 6005),
];

const stageExtraCases: FieldCase[] = [
  stageExtra('plan', 'figma', true),
  stageExtra('plan', 'skills', ['writing-plans']),
  stageExtra('implement', 'figma', true),
  stageExtra('implement', 'stallThresholdForVerificationFix', 7),
  stageExtra('implement', 'models.default', 'claude-default-sentinel'),
  stageExtra('implement', 'models.mechanical', 'claude-mechanical-sentinel'),
  stageExtra('implement', 'modelRoutingThresholds.maxTargetedWritesForDefault', 3),
  stageExtra('implement', 'modelRoutingThresholds.maxPlanStepsForDefault', 4),
  stageExtra('implement', 'skills', ['coding-style']),
  stageExtra('implement', 'verificationConditions.policyFile', 'implement-policy.md'),
  stageExtra('implement', 'verificationConditions.scripts', { lint: 'yarn lint' }),
  stageExtra('implement', 'planStepVerification.enabled', true),
  stageExtra('implement', 'planStepVerification.stallWindow', 8),
  stageExtra('implement', 'planStepVerification.mode', 'push'),
  stageExtra('implement', 'planStepVerification.provider', 'anthropic'),
  stageExtra('implement', 'planStepVerification.model', 'claude-verify-sentinel'),
  stageExtra('implement', 'planStepVerification.backend', 'standard'),
  stageExtra('implement', 'designConformance.enabled', true),
  stageExtra('implement', 'designConformance.maxScreenshots', 6),
  stageExtra('review', 'sonar', true),
  stageExtra('review', 'figma', true),
  stageExtra('review', 'maxDiffLength', 9001),
  stageExtra('review', 'epilogueTimeoutMs', 9002),
  plain('stages.create.verificationConditions.policyFile', 'create-policy.md'),
  plain('stages.create.verificationConditions.scripts', { build: 'yarn build' }),
];

const stageSpecialCases: FieldCase[] = [
  fieldCase({
    schemaPath: 'stages.implement.model',
    fixtures: [{ path: 'stages.implement.model', value: 'claude-implement-sentinel' }],
    kind: 'dropped',
    reason: 'intentionalStageFieldDrops: implement.model is stripped so models routing can resolve the model',
    expectations: [{ path: 'stages.implement.model', value: undefined }],
  }),
  fieldCase({
    schemaPath: 'stages.fetch',
    fixtures: [],
    kind: 'rejectedAtLoad',
    reason: 'normalizeWfConfig throws because the fetch stage cannot be overridden',
    expectations: [],
    rejection: { rawConfig: { stages: { fetch: 'x' } }, message: /fetch stage cannot be overridden/ },
  }),
];

const atlassianCases: FieldCase[] = [
  plain('atlassian.baseUrl', 'https://sentinel.atlassian.net'),
  plain('atlassian.email', 'sentinel@example.com'),
  fieldCase({
    schemaPath: 'atlassian.apiToken',
    fixtures: [{ path: 'atlassian.apiToken', value: 'top-level-token-sentinel' }],
    kind: 'transformed',
    reason: 'atlassian.jira.apiToken takes precedence and is published on both atlassian.apiToken paths',
    expectations: [{ path: 'atlassian.apiToken', value: 'jira-token-sentinel' }],
  }),
  roundTrip('atlassian.jira.apiToken', 'atlassian.jira.apiToken', 'jira-token-sentinel'),
  plain('atlassian.jira.defaultProject', 'SENT'),
  plain('atlassian.bitbucket.workspace', 'bitbucket-workspace-sentinel'),
  plain('atlassian.bitbucket.apiToken', 'bitbucket-token-sentinel'),
];

const logPrecedenceCase = (field: string, fixtureValue: unknown, expectedValue: unknown): FieldCase =>
  fieldCase({
    schemaPath: `log.${field}`,
    fixtures: [{ path: `log.${field}`, value: fixtureValue }],
    kind: 'transformed',
    reason: 'logging takes precedence over log, and log is published with the logging values',
    expectations: [{ path: `log.${field}`, value: expectedValue }],
  });

const logPrecedenceCases = (loggingDirectory: string, rootDir: string): FieldCase[] => [
  logPrecedenceCase('directory', path.join(rootDir, 'log-ignored'), loggingDirectory),
  logPrecedenceCase('level', 'debug', 'warn'),
];

const loggingCases = (rootDir: string): FieldCase[] => {
  const loggingDirectory = path.join(rootDir, 'logging');
  return [
    plain('logging.directory', loggingDirectory),
    plain('logging.level', 'warn'),
    ...logPrecedenceCases(loggingDirectory, rootDir),
  ];
};

const gitCases: FieldCase[] = [
  plain('git.commitFormat', 'conventional'),
  plain('git.branchNamePattern', '^sentinel/[A-Z]+-[0-9]+$'),
  plain('git.branchPrefixMapping.feature', 'feat-sentinel'),
  plain('git.branchPrefixMapping.fix', 'fix-sentinel'),
  plain('git.branchPrefixMapping.investigate', 'investigate-sentinel'),
  plain('git.protectedBranches', ['release-sentinel', 'prod-sentinel']),
];

const sharedCases: FieldCase[] = [
  plain('tracker', 'github'),
  ...aiProviderCases,
  ...atlassianCases,
  plain('github.token', 'github-token-sentinel'),
  plain('github.defaultRepo', 'owner/repo-sentinel'),
  ...gitCases,
  plain('slack.botToken', 'slack-bot-sentinel'),
  plain('slack.userToken', 'slack-user-sentinel'),
  plain('figma.token', 'figma-token-sentinel'),
  ...stageTargetBaseCases,
  ...stageExtraCases,
  ...stageSpecialCases,
];

/**
 * Build the table that drives both the fixture config and the expectations asserted
 * against `ConfigService`. Keyed by the walker output over `wfConfigSchema`.
 *
 * @param rootDir - Scratch directory that logging and state paths are placed under
 * @returns One case per schema leaf path
 */
export const createFieldCases = (rootDir: string): FieldCase[] => [
  ...sharedCases,
  plain('state.directory', path.join(rootDir, 'state')),
  ...loggingCases(rootDir),
];

const isIndexSegment = (segment: string): boolean => /^\d+$/.test(segment);

const setAtPath = (target: Record<string, unknown>, dottedPath: string, value: unknown): void => {
  const segments = dottedPath.split('.');
  const lastSegment = segments.at(-1) as string;
  const parent = segments.slice(0, -1).reduce<Record<string, unknown>>((node, segment, index) => {
    node[segment] ??= isIndexSegment(segments[index + 1]) ? [] : {};
    return node[segment] as Record<string, unknown>;
  }, target);
  parent[lastSegment] = value;
};

/**
 * Fold every case's fixture entries into a plain config object.
 *
 * @param cases - Field case table
 * @returns Raw config shaped like a consumer-authored `wf.config`
 */
export const buildFixture = (cases: FieldCase[]): Record<string, unknown> => {
  const fixture: Record<string, unknown> = {};
  for (const fieldCaseEntry of cases) {
    for (const entry of fieldCaseEntry.fixtures ?? []) setAtPath(fixture, entry.path, entry.value);
  }
  return fixture;
};
