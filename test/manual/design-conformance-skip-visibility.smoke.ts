/**
 * Manual smoke test: an enabled design check says why it did not run, and missing screenshot files are reported
 *
 * Run: nr test:manual design-conformance-skip-visibility.smoke.ts
 *
 * Scenario: issue:implement runs with designConformance enabled in three situations: a plan that lists no
 * screenshots, a plan whose second screenshot file was deleted, and a disabled check on a plan without screenshots.
 *
 * Verify:
 *   1. No screenshots: exit 0, output says the check was skipped because the plan lists no uiDesignScreenshots, and
 *      no model call is made.
 *   2. Deleted file: exit 0, output names the missing file as skipped, the check runs for the remaining screenshot
 *      only (one request, progress 1/1), and the run file carries that screenshot's finding.
 *   3. Disabled check: no skip message is printed at all.
 *
 * Wire up: compiled CLI via issue:implement; fake claude implements; HTTP stub counts requests.
 * Teardown: temp repo, fake CLIs, screenshot dir and stub server removed.
 */

import * as fs from 'node:fs';
import {
  readNewestRunFile, resetRepoForRerun, runImplementAsync, runSmoke, setPlanScreenshots, writeImplementConfig,
  type SmokeContext,
} from './support/design-conformance-scenario';

const enabledStage = {
  designConformance: { enabled: true, backend: 'standard', provider: 'anthropic', model: 'claude-conformance-sentinel' },
};
const skipMessage = 'design conformance check skipped: the plan artifact lists no uiDesignScreenshots';

const verifyNoScreenshots = async ({ check, scenario, stub }: SmokeContext): Promise<void> => {
  setPlanScreenshots(scenario, undefined);
  const { exitCode, output } = await runImplementAsync(scenario, stub.baseUrl);
  check(exitCode === 0, 'no screenshots: run exits 0', output.slice(-800));
  check(output.includes(skipMessage), 'no screenshots: output explains the skip', output.slice(-800));
  check(stub.requests.length === 0, 'no screenshots: no model call was made');
};

const verifyDeletedFile = async ({ check, scenario, stub }: SmokeContext): Promise<void> => {
  const { hero, card } = scenario.screenshots;
  resetRepoForRerun(scenario);
  setPlanScreenshots(scenario, [hero, card]);
  fs.rmSync(card);
  const { exitCode, output } = await runImplementAsync(scenario, stub.baseUrl);
  check(exitCode === 0, 'deleted file: run exits 0', output.slice(-800));
  check(output.includes(`file not found, skipped: ${card}`), 'deleted file: output names the skipped file', output.slice(-800));
  check(output.includes('[design-check] 1/1 hero.png'), 'deleted file: only the remaining screenshot is checked');
  check(stub.requests.length === 1, 'deleted file: exactly one model call', `got ${stub.requests.length}`);
  const findings = readNewestRunFile(scenario)?.run?.designConformance;
  check(findings?.[0]?.screenshot === hero, 'deleted file: run file carries the hero finding', JSON.stringify(findings));
};

const verifyDisabled = async ({ check, scenario, stub }: SmokeContext): Promise<void> => {
  resetRepoForRerun(scenario);
  setPlanScreenshots(scenario, undefined);
  writeImplementConfig(scenario, { designConformance: { enabled: false } });
  const { exitCode, output } = await runImplementAsync(scenario, stub.baseUrl);
  check(exitCode === 0, 'disabled: run exits 0', output.slice(-800));
  check(!output.includes('design conformance check skipped'), 'disabled: no skip message');
};

void runSmoke({
  prefix: 'wf-dc-visibility-',
  stage: enabledStage,
  verify: async context => {
    await verifyNoScreenshots(context);
    await verifyDeletedFile(context);
    await verifyDisabled(context);
  },
}).catch(error => {
  console.error(error);
  process.exit(1);
});
