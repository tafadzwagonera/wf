/**
 * Manual smoke test: an unresolved deviation stops fix rounds after stallWindow rounds and is reported once
 *
 * Run: nr test:manual design-conformance-stall-window.smoke.ts
 *
 * Scenario: issue:implement runs with designConformance
 * { enabled, backend: 'cli', provider: 'anthropic', stallWindow: 2 }.
 * The fake claude reports the hero.png deviation on every check, so the pending count never shrinks.
 *
 * Verify:
 *   1. The run exits 0.
 *   2. Exactly one fix round runs, and its stdin names round 1 and stall window 2.
 *   3. Conformance runs twice per screenshot (initial check + one re-check).
 *   4. The output lists the hero deviation once under Design conformance (advisory).
 *   5. The run file carries exactly one remaining finding.
 *
 * Wire up: compiled CLI via issue:implement; the fake claude never resolves the hero finding.
 * Teardown: temp repo, fake CLIs, screenshot dir and stub server removed.
 */

import {
  conformanceInvocations, heroFinding, readInvocations, readNewestRunFile, runImplementAsync, runSmoke,
  type SmokeContext,
} from './support/design-conformance-scenario';

const model = 'claude-haiku-4-5-20251001';
const conformanceMarker = 'You are given one design screenshot';
const fixRoundMarker = 'Design conformance round 1 (stall window: 2)';

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const verifyFixRounds = ({ check, scenario }: SmokeContext): void => {
  const implementCalls = readInvocations(scenario).filter(call => !call.stdin.includes(conformanceMarker));
  check(implementCalls.length === 2, 'fake claude ran implement then exactly one fix round', `got ${implementCalls.length}`);
  check(
    implementCalls[1]?.stdin.includes(fixRoundMarker) === true,
    'fix round prompt names round 1 and stall window 2', implementCalls[1]?.stdin.slice(0, 400),
  );
  const checks = conformanceInvocations(scenario, 'claude').length;
  check(checks === 4, 'two screenshots checked in each of two rounds', `got ${checks}`);
};

const verifyReport = ({ check, scenario }: SmokeContext, output: string): void => {
  const reported = countOccurrences(output, heroFinding.deviation);
  check(output.includes('Design conformance (advisory)'), 'output has the advisory section', output.slice(-800));
  check(reported === 1, 'hero deviation is listed once', `got ${reported}`);
  const findings = readNewestRunFile(scenario)?.run?.designConformance;
  check(Array.isArray(findings) && findings.length === 1, 'run file carries one remaining finding', JSON.stringify(findings));
};

void runSmoke({
  prefix: 'wf-dc-stall-',
  stage: { designConformance: { enabled: true, backend: 'cli', provider: 'anthropic', model, stallWindow: 2 } },
  verify: async context => {
    const { exitCode, output } = await runImplementAsync(context.scenario, context.stub.baseUrl);
    context.check(exitCode === 0, 'run exits 0', output.slice(-800));
    verifyFixRounds(context);
    verifyReport(context, output);
  },
}).catch(error => {
  console.error(error);
  process.exit(1);
});
