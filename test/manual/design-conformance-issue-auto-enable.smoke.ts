/**
 * Manual smoke test: wf issue --ui-design-screenshots enables the design conformance check (implement-stage fallbacks)
 *
 * Run: nr test:manual design-conformance-issue-auto-enable.smoke.ts
 *
 * Scenario: `wf issue -k WBP-901 --action fix --from plan --to implement --ui-design-screenshots <hero> <card>` runs
 * against a repo whose stages.implement uses the Claude CLI backend with an explicit model. The plan stage stores the
 * screenshots, the implement stage edits src/a.ts, and the flag must switch the design check on and merge it with
 * whatever stages.implement.designConformance says in wf.config.js.
 *
 * Verify:
 *   1. Flag, no designConformance block: exit 0, two conformance Claude CLI calls (implement-stage backend and
 *      provider) with the stages.implement model and --add-dir for the screenshot directory; advisory names hero.png.
 *   2. No flag, no block: no design-check output and no conformance calls.
 *   3. No flag, designConformance { enabled: false, ...overrides }: the check does not run (the flag is the trigger).
 *   4. Flag, designConformance { enabled: false, backend: 'standard', provider, model }: the flag overrides enabled
 *      and the block's other fields are used, so the stub API gets two requests with that model and Claude CLI makes
 *      no conformance calls.
 *   5. Flag, designConformance { maxScreenshots: 1 }: exactly one conformance call ("1/1 hero.png", skip notice for
 *      the second file) on the stages.implement backend and model.
 *   6. Flag with --to review: the flag overrides enabled: false, the block is merged, and review still runs.
 *   7. Flag with --from implement against a plan stored without screenshots: the skip is explained.
 *   8. No flag, plan stored with screenshots, --from implement: config decides (enabled: true runs, false does not).
 *
 * Wire up: compiled CLI via `wf issue`; fake claude answers the plan, implement and conformance prompts; the HTTP
 * stub counts inline-image requests. Each case runs in its own temp repo.
 * Teardown: temp repos, fake CLIs, screenshot dirs and stub server removed.
 */

import chalk from 'chalk';
import { createReporter } from './support/reporter';
import {
  argAfter, assertDistExists, cleanupScenario, conformanceInvocations, createScenario, heroFinding,
  readInvocations, runIssueAsync, startStubServer, stopStubServer, writeTicketFixture,
  type Scenario, type StubServer,
} from './support/design-conformance-scenario';

const { counts, pass, fail } = createReporter();
const check = (ok: boolean, label: string, detail?: string): void => (ok ? pass(label) : fail(label, detail));
const sentinelModel = 'claude-conformance-sentinel';
const implementModel = 'claude-implement-sentinel';
const advisoryLine = `hero.png — ${heroFinding.area}: ${heroFinding.deviation}`;

const screenshotArgs = (scenario: Scenario): string[] => [
  '--ui-design-screenshots', scenario.screenshots.hero, scenario.screenshots.card,
];

const withScenario = async (
  stage: Record<string, unknown>, body: (scenario: Scenario) => Promise<void>,
): Promise<void> => {
  const scenario = createScenario('wf-dc-issue-', stage);
  writeTicketFixture(scenario);
  try {
    await body(scenario);
  } finally {
    cleanupScenario(scenario);
  }
};

const verifyFlagCalls = (scenario: Scenario): void => {
  const calls = conformanceInvocations(scenario, 'claude');
  check(calls.length === 2, 'flag, no config: two conformance Claude CLI calls', `got ${calls.length}`);
  check(
    calls.length > 0 && calls.every(call => argAfter(call.argv, '--model') === implementModel),
    'flag, no config: conformance calls use the stages.implement model', JSON.stringify(calls.map(call => call.argv)),
  );
  check(
    calls.length > 0 && calls.every(call => argAfter(call.argv, '--add-dir') === scenario.screenshotDir),
    'flag, no config: screenshot directory is granted with --add-dir',
  );
};

const verifyFlagOutput = (output: string, stub: StubServer): void => {
  const reported = output.includes('Design conformance (advisory):') && output.includes(advisoryLine);
  check(reported, 'flag, no config: advisory block names hero.png', output.slice(-1200));
  check(stub.requests.length === 0, 'flag, no config: no inline-image API requests');
};

const verifyFlagFallbacks = async (stub: StubServer): Promise<void> => {
  await withScenario({ model: implementModel }, async scenario => {
    const { exitCode, output } = await runIssueAsync(scenario, stub.baseUrl, screenshotArgs(scenario));
    check(exitCode === 0, 'flag, no config: run exits 0', output.slice(-1200));
    verifyFlagCalls(scenario);
    verifyFlagOutput(output, stub);
  });
};

const verifyNoFlag = async (stub: StubServer): Promise<void> => {
  await withScenario({}, async scenario => {
    const { exitCode, output } = await runIssueAsync(scenario, stub.baseUrl, []);
    check(exitCode === 0, 'no flag: run exits 0', output.slice(-1200));
    const ran = output.includes('[design-check]') || conformanceInvocations(scenario, 'claude').length > 0;
    check(!ran, 'no flag: the check does not run');
  });
};

const overrides = { backend: 'standard', provider: 'anthropic', model: sentinelModel };

const verifyDisabledWithoutFlag = async (stub: StubServer): Promise<void> => {
  await withScenario({ designConformance: { enabled: false, ...overrides } }, async scenario => {
    const { exitCode, output } = await runIssueAsync(scenario, stub.baseUrl, []);
    check(exitCode === 0, 'no flag + enabled: false: run exits 0', output.slice(-1200));
    const ran = output.includes('[design-check]') || conformanceInvocations(scenario, 'claude').length > 0;
    check(!ran, 'no flag + enabled: false: the check does not run');
  });
};

const verifyFlagOverridesEnabled = async (stub: StubServer): Promise<void> => {
  const before = stub.requests.length;
  await withScenario({ designConformance: { enabled: false, ...overrides } }, async scenario => {
    const { exitCode, output } = await runIssueAsync(scenario, stub.baseUrl, screenshotArgs(scenario));
    const models = stub.requests.slice(before).map(request => request.body.model);
    check(exitCode === 0, 'flag + enabled: false: run exits 0', output.slice(-1200));
    check(
      models.length === 2 && models.every(model => model === sentinelModel),
      'flag + enabled: false: the config block is merged (stub gets two requests with its model)', JSON.stringify(models),
    );
    check(conformanceInvocations(scenario, 'claude').length === 0, 'flag + enabled: false: no Claude CLI conformance calls');
  });
};

const verifyPartialBlock = async (stub: StubServer): Promise<void> => {
  await withScenario({ model: implementModel, designConformance: { maxScreenshots: 1 } }, async scenario => {
    const { exitCode, output } = await runIssueAsync(scenario, stub.baseUrl, screenshotArgs(scenario));
    const calls = conformanceInvocations(scenario, 'claude');
    check(exitCode === 0, 'flag + partial block: run exits 0', output.slice(-1200));
    check(calls.length === 1, 'flag + partial block: maxScreenshots caps the check at one call', `got ${calls.length}`);
    check(argAfter(calls[0]?.argv ?? [], '--model') === implementModel, 'flag + partial block: unset model falls back to stages.implement');
    check(output.includes('[design-check] 1/1 hero.png'), 'flag + partial block: only hero.png is checked', output.slice(-1200));
    check(output.includes('maxScreenshots=1: skipped 1 of 2'), 'flag + partial block: the skipped screenshot is reported');
  });
};

const reviewCalls = (scenario: Scenario): number =>
  readInvocations(scenario).filter(call => call.argv.join(' ').includes('"approved"')).length;

const verifyThroughReview = async (stub: StubServer): Promise<void> => {
  const before = stub.requests.length;
  await withScenario({ designConformance: { enabled: false, ...overrides } }, async scenario => {
    const { exitCode, output } = await runIssueAsync(
      scenario, stub.baseUrl, screenshotArgs(scenario), { to: 'review' },
    );
    const models = stub.requests.slice(before).map(request => request.body.model);
    check(exitCode === 0, 'flag, --to review: run exits 0', output.slice(-1500));
    check(
      models.length === 2 && models.every(model => model === sentinelModel),
      'flag, --to review: the flag overrides enabled: false and the block is merged', JSON.stringify(models),
    );
    check(reviewCalls(scenario) > 0, 'flag, --to review: the review stage still runs after the check', output.slice(-1500));
  });
};

const verifyFromImplementWithoutStoredScreenshots = async (stub: StubServer): Promise<void> => {
  await withScenario({ model: implementModel }, async scenario => {
    await runIssueAsync(scenario, stub.baseUrl, [], { from: 'plan', to: 'plan' });
    const { exitCode, output } = await runIssueAsync(
      scenario, stub.baseUrl, screenshotArgs(scenario), { from: 'implement', to: 'implement' },
    );
    check(exitCode === 0, 'flag, --from implement, plan without screenshots: run exits 0', output.slice(-1500));
    check(
      output.includes('design conformance check skipped: the plan artifact lists no uiDesignScreenshots'),
      'flag, --from implement, plan without screenshots: the skip is explained', output.slice(-1500),
    );
    check(conformanceInvocations(scenario, 'claude').length === 0, 'flag, --from implement, plan without screenshots: no calls');
  });
};

const verifyConfigWinsWithoutFlag = async (stub: StubServer, enabled: boolean): Promise<void> => {
  const label = `no flag + enabled: ${enabled}, --from implement`;
  const stage = { model: implementModel, designConformance: { enabled } };
  await withScenario(stage, async scenario => {
    await runIssueAsync(scenario, stub.baseUrl, screenshotArgs(scenario), { from: 'plan', to: 'plan' });
    const { exitCode, output } = await runIssueAsync(scenario, stub.baseUrl, [], { from: 'implement', to: 'implement' });
    const calls = conformanceInvocations(scenario, 'claude').length;
    check(exitCode === 0, `${label}: run exits 0`, output.slice(-1500));
    check(enabled ? calls === 2 : calls === 0, `${label}: the config decides (${enabled ? 'two calls' : 'no calls'})`, `calls=${calls}`);
    check(output.includes('[design-check]') === enabled, `${label}: design-check output ${enabled ? 'present' : 'absent'}`);
  });
};

const runAllCases = async (stub: StubServer): Promise<void> => {
  await verifyFlagFallbacks(stub);
  await verifyNoFlag(stub);
  await verifyDisabledWithoutFlag(stub);
  await verifyFlagOverridesEnabled(stub);
  await verifyPartialBlock(stub);
  await verifyThroughReview(stub);
  await verifyFromImplementWithoutStoredScreenshots(stub);
  await verifyConfigWinsWithoutFlag(stub, true);
  await verifyConfigWinsWithoutFlag(stub, false);
};

async function main(): Promise<void> {
  assertDistExists();
  const stub = await startStubServer();
  try {
    await runAllCases(stub);
  } finally {
    await stopStubServer(stub);
  }
  console.log(chalk.bold(`\nSummary: ${counts.passed} passed, ${counts.failed} failed`));
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
