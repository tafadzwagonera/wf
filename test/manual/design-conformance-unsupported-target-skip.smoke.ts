/**
 * Manual smoke test: designConformance skips with a named warning when the backend or provider cannot read images
 *
 * Run: nr test:manual design-conformance-unsupported-target-skip.smoke.ts
 *
 * Scenario: issue:implement runs twice, once with designConformance { backend: 'agent', provider: 'openai' } and
 * once with provider 'google'. Neither can show the screenshots to a model.
 *
 * Verify (per case):
 *   1. The run exits 0 and prints "design conformance check skipped" with the cause.
 *   2. No advisory block, no conformance CLI calls, no HTTP requests, and no designConformance in the run file.
 *
 * Wire up: compiled CLI via issue:implement with real wf.config.js variants; fake claude and codex record calls.
 * Teardown: temp repo, fake CLIs, screenshot dir and stub server removed.
 */

import {
  conformanceCallCount, readNewestRunFile, resetRepoForRerun, runImplementAsync, runSmoke, writeImplementConfig,
  type SmokeContext,
} from './support/design-conformance-scenario';

const cases = [
  {
    name: 'agent + openai',
    stage: { designConformance: { enabled: true, backend: 'agent', provider: 'openai', model: 'gpt-5.6-luna' } },
    expected: 'OpenAI agent backend cannot read screenshots',
  },
  {
    name: 'provider google',
    stage: { designConformance: { enabled: true, provider: 'google', model: 'gemini-2.5-flash' } },
    expected: "provider 'google' cannot read screenshots",
  },
];

const extraAi = [
  { provider: 'openai', model: 'gpt-5.6-luna', apiKey: 'test-key' },
  { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'test-key' },
];

const verifyCase = async (context: SmokeContext, testCase: typeof cases[number]): Promise<void> => {
  const { check, scenario, stub } = context;
  resetRepoForRerun(scenario);
  writeImplementConfig(scenario, testCase.stage, extraAi);
  const before = stub.requests.length;
  const { exitCode, output } = await runImplementAsync(scenario, stub.baseUrl);
  check(exitCode === 0, `${testCase.name}: run exits 0`, output.slice(-800));
  check(
    output.includes('design conformance check skipped') && output.includes(testCase.expected),
    `${testCase.name}: output names the cause`, output.slice(-800),
  );
  check(!output.includes('Design conformance (advisory)'), `${testCase.name}: no advisory block`);
  check(conformanceCallCount(scenario) === 0 && stub.requests.length === before, `${testCase.name}: no conformance calls were made`);
  check(readNewestRunFile(scenario)?.run?.designConformance === undefined, `${testCase.name}: no run-file findings`);
};

void runSmoke({
  prefix: 'wf-dc-skip-',
  stage: {},
  extraAi,
  verify: async context => {
    for (const testCase of cases) await verifyCase(context, testCase);
  },
}).catch(error => {
  console.error(error);
  process.exit(1);
});
