/**
 * Manual smoke test: designConformance backend cli with provider anthropic runs the Claude CLI per screenshot
 *
 * Run: nr test:manual design-conformance-cli-claude.smoke.ts
 *
 * Scenario: issue:implement runs with designConformance { enabled, backend: 'cli', provider: 'anthropic',
 * model: 'claude-haiku-4-5-20251001' }. The check must go through the Claude CLI, not the inline-image API.
 *
 * Verify:
 *   1. The run exits 0 and the advisory block names the hero.png finding.
 *   2. Two conformance claude invocations use --model claude-haiku-4-5-20251001 and --add-dir <screenshot dir>.
 *   3. Each call's stdin lists exactly one screenshot path, in order, and carries the implement diff.
 *   4. The stub receives zero requests and the run file carries the hero.png finding.
 *
 * Wire up: compiled CLI via issue:implement; fake claude records argv and stdin and returns structured_output.
 * Teardown: temp repo, fake CLIs, screenshot dir and stub server removed.
 */

import {
  argAfter, conformanceInvocations, heroFinding, readNewestRunFile, runImplementAsync, runSmoke,
  type SmokeContext,
} from './support/design-conformance-scenario';

const model = 'claude-haiku-4-5-20251001';
const heading = 'Design screenshots (accessible via filesystem)';

const verifyArgs = ({ check, scenario }: SmokeContext): void => {
  const calls = conformanceInvocations(scenario, 'claude');
  check(calls.length === 2, 'two conformance claude invocations', `got ${calls.length}`);
  check(
    calls.length > 0 && calls.every(call => argAfter(call.argv, '--model') === model),
    'each call uses --model from designConformance.model', JSON.stringify(calls.map(call => call.argv)),
  );
  check(
    calls.length > 0 && calls.every(call => argAfter(call.argv, '--add-dir') === scenario.screenshotDir),
    'each call grants --add-dir for the screenshot directory',
  );
};

const verifyStdin = ({ check, scenario }: SmokeContext): void => {
  const calls = conformanceInvocations(scenario, 'claude');
  const { hero, card } = scenario.screenshots;
  check(
    calls[0]?.stdin.includes(`- ${hero}`) && calls[1]?.stdin.includes(`- ${card}`),
    'stdin lists one screenshot path per call in order',
  );
  const carriesAll = (stdin: string): boolean => stdin.includes(heading) && stdin.includes('+// implemented');
  check(calls.length > 0 && calls.every(call => carriesAll(call.stdin)), 'stdin carries the paths section and diff');
};

const verifyOutcome = ({ check, scenario, stub }: SmokeContext, output: string): void => {
  const line = `hero.png — ${heroFinding.area}: ${heroFinding.deviation}`;
  check(output.includes('Design conformance (advisory):') && output.includes(line), 'advisory block shows the finding');
  check(stub.requests.length === 0, 'no inline-image API requests were made', `got ${stub.requests.length}`);
  const findings = readNewestRunFile(scenario)?.run?.designConformance;
  check(Array.isArray(findings) && findings.length === 1, 'run file carries the hero.png finding', JSON.stringify(findings));
};

void runSmoke({
  prefix: 'wf-dc-cli-claude-',
  stage: { designConformance: { enabled: true, backend: 'cli', provider: 'anthropic', model, stallWindow: 1 } },
  verify: async context => {
    const { exitCode, output } = await runImplementAsync(context.scenario, context.stub.baseUrl);
    context.check(exitCode === 0, 'run exits 0', output.slice(-800));
    verifyArgs(context);
    verifyStdin(context);
    verifyOutcome(context, output);
  },
}).catch(error => {
  console.error(error);
  process.exit(1);
});
