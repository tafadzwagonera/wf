/**
 * Manual smoke test: designConformance backend cli with provider openai runs Codex CLI per screenshot
 *
 * Run: nr test:manual design-conformance-cli-codex.smoke.ts
 *
 * Scenario: issue:implement runs with designConformance { enabled, backend: 'cli', provider: 'openai',
 * model: 'gpt-5.6-luna' } while the implement stage itself stays on the Claude CLI.
 *
 * Verify:
 *   1. The run exits 0 and the advisory block names the hero.png finding.
 *   2. Two codex invocations use --model gpt-5.6-luna and list one screenshot path each in stdin, in order.
 *   3. No conformance call goes through claude and the stub receives zero requests.
 *   4. The run file carries the hero.png finding.
 *
 * Wire up: compiled CLI via issue:implement; fake claude implements; fake codex records argv and stdin and emits
 * an agent_message with findings.
 * Teardown: temp repo, fake CLIs, screenshot dir and stub server removed.
 */

import {
  argAfter, conformanceInvocations, heroFinding, readNewestRunFile, runImplementAsync, runSmoke,
  type SmokeContext,
} from './support/design-conformance-scenario';

const heading = 'Design screenshots (accessible via filesystem)';

const verifyCalls = ({ check, scenario }: SmokeContext): void => {
  const calls = conformanceInvocations(scenario, 'codex');
  check(calls.length === 2, 'two conformance codex invocations', `got ${calls.length}`);
  check(
    calls.length > 0 && calls.every(call => argAfter(call.argv, '--model') === 'gpt-5.6-luna'),
    'each call uses --model gpt-5.6-luna', JSON.stringify(calls.map(call => call.argv)),
  );
  check(
    calls[0]?.stdin.includes(heading) && calls[0].stdin.includes(`- ${scenario.screenshots.hero}`)
    && calls[1]?.stdin.includes(`- ${scenario.screenshots.card}`),
    'stdin lists one screenshot path per call in order',
  );
  check(conformanceInvocations(scenario, 'claude').length === 0, 'no conformance call went through claude');
};

const verifyOutcome = ({ check, scenario, stub }: SmokeContext, output: string): void => {
  const line = `hero.png — ${heroFinding.area}: ${heroFinding.deviation}`;
  check(output.includes('Design conformance (advisory):') && output.includes(line), 'advisory block shows the finding');
  check(stub.requests.length === 0, 'no inline-image API requests were made', `got ${stub.requests.length}`);
  const findings = readNewestRunFile(scenario)?.run?.designConformance;
  check(Array.isArray(findings) && findings.length === 1, 'run file carries the hero.png finding', JSON.stringify(findings));
};

void runSmoke({
  prefix: 'wf-dc-cli-codex-',
  stage: { designConformance: { enabled: true, backend: 'cli', provider: 'openai', model: 'gpt-5.6-luna' } },
  extraAi: [{ provider: 'openai', model: 'gpt-5.6-luna', apiKey: 'test-key' }],
  verify: async context => {
    const { exitCode, output } = await runImplementAsync(context.scenario, context.stub.baseUrl);
    context.check(exitCode === 0, 'run exits 0', output.slice(-800));
    verifyCalls(context);
    verifyOutcome(context, output);
  },
}).catch(error => {
  console.error(error);
  process.exit(1);
});
