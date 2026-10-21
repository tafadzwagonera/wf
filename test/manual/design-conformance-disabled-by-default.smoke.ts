/**
 * Manual smoke test: without designConformance.enabled, issue:implement makes no screenshot check calls
 *
 * Run: nr test:manual design-conformance-disabled-by-default.smoke.ts
 *
 * Scenario: issue:implement runs against a plan listing screenshots, once with the key absent and once with
 * enabled: false plus backend, provider and model set.
 *
 * Verify (per run):
 *   1. The run exits 0 with no design-check output.
 *   2. No conformance CLI calls, no HTTP requests and no designConformance in the run file.
 *
 * Wire up: compiled CLI via issue:implement; fake claude and codex record calls; stub counts HTTP requests.
 * Teardown: temp repo, fake CLIs, screenshot dir and stub server removed.
 */

import {
  conformanceCallCount, readNewestRunFile, resetRepoForRerun, runImplementAsync, runSmoke, writeImplementConfig,
  type SmokeContext,
} from './support/design-conformance-scenario';

const runs = [
  { name: 'key absent', stage: {} },
  {
    name: 'enabled: false with overrides',
    stage: {
      designConformance: { enabled: false, backend: 'cli', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    },
  },
];

const verifyRun = async (context: SmokeContext, run: typeof runs[number]): Promise<void> => {
  const { check, scenario, stub } = context;
  resetRepoForRerun(scenario);
  writeImplementConfig(scenario, run.stage);
  const { exitCode, output } = await runImplementAsync(scenario, stub.baseUrl);
  check(exitCode === 0, `${run.name}: run exits 0`, output.slice(-800));
  check(
    !output.includes('[design-check]') && !output.includes('Design conformance (advisory)'),
    `${run.name}: no design-check output`,
  );
  check(conformanceCallCount(scenario) === 0, `${run.name}: no conformance CLI calls`);
  check(readNewestRunFile(scenario)?.run?.designConformance === undefined, `${run.name}: no run-file findings`);
};

void runSmoke({
  prefix: 'wf-dc-disabled-',
  stage: {},
  verify: async context => {
    for (const run of runs) await verifyRun(context, run);
    context.check(context.stub.requests.length === 0, 'stub received 0 requests across both runs');
  },
}).catch(error => {
  console.error(error);
  process.exit(1);
});
