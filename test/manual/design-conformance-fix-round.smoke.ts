/**
 * Manual smoke test: a design conformance deviation triggers one fix round that resumes the implement session
 *
 * Run: nr test:manual design-conformance-fix-round.smoke.ts
 *
 * Scenario: issue:implement runs with designConformance { enabled, backend: 'cli', provider: 'anthropic' }.
 * The fake claude reports the hero.png deviation on the first check and nothing on the second.
 *
 * Verify:
 *   1. The run exits 0.
 *   2. Exactly one fix-round invocation happens, and its stdin carries the round-1 deviation text.
 *   3. Conformance runs twice per screenshot (initial check + re-check).
 *   4. The run file carries no designConformance findings once the deviation is resolved.
 *
 * Wire up: compiled CLI via issue:implement; fake claude counts hero.png checks and resolves from the second.
 * Teardown: temp repo, fake CLIs, screenshot dir and stub server removed.
 */

import {
  conformanceInvocations, heroFinding, readInvocations, readNewestRunFile, runImplementAsync, runSmoke,
  type SmokeContext,
} from './support/design-conformance-scenario';

const model = 'claude-haiku-4-5-20251001';
const conformanceMarker = 'You are given one design screenshot';
const fixRoundMarker = 'Design conformance round';

const verifyFixRound = ({ check, scenario }: SmokeContext): void => {
  const implementCalls = readInvocations(scenario).filter(call => !call.stdin.includes(conformanceMarker));
  check(implementCalls.length === 2, 'fake claude ran implement then one fix round', `got ${implementCalls.length}`);
  const [initial, fix] = implementCalls;
  check(initial?.stdin.includes(fixRoundMarker) === false, 'first invocation is the initial implement run');
  check(
    fix?.stdin.includes(fixRoundMarker) === true && fix.stdin.includes(heroFinding.deviation),
    'second invocation is the fix round and carries the round-1 deviation', fix?.stdin.slice(0, 400),
  );
};

const verifyOutcome = ({ check, scenario }: SmokeContext): void => {
  const checks = conformanceInvocations(scenario, 'claude').length;
  check(checks === 4, 'two screenshots checked in each of two rounds', `got ${checks}`);
  const findings = readNewestRunFile(scenario)?.run?.designConformance;
  check(
    findings === undefined || (Array.isArray(findings) && findings.length === 0),
    'run file carries no remaining findings', JSON.stringify(findings),
  );
};

void runSmoke({
  prefix: 'wf-dc-fix-round-',
  stage: { designConformance: { enabled: true, backend: 'cli', provider: 'anthropic', model } },
  resolveHeroOnCall: 2,
  verify: async context => {
    const { exitCode, output } = await runImplementAsync(context.scenario, context.stub.baseUrl);
    context.check(exitCode === 0, 'run exits 0', output.slice(-800));
    verifyFixRound(context);
    verifyOutcome(context);
  },
}).catch(error => {
  console.error(error);
  process.exit(1);
});
