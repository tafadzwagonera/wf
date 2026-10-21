/**
 * Manual smoke test: designConformance provider and model overrides send inline images through the provider API
 *
 * Run: nr test:manual design-conformance-standard-overrides.smoke.ts
 *
 * Scenario: issue:implement runs with designConformance { enabled, backend: 'standard', provider: 'anthropic',
 * model: <sentinel> } while stages.implement uses the CLI backend. Each screenshot becomes one inline-image API
 * request to a local stub, so the explicit backend must win over the implement stage.
 *
 * Verify:
 *   1. The run exits 0 even though a finding is reported (advisory only).
 *   2. Progress lines and the advisory block name hero.png and its finding.
 *   3. The stub receives one request per screenshot, each with one image block, the diff and the sentinel model.
 *   4. The newest run file carries exactly the hero.png finding.
 *
 * Wire up: compiled CLI via issue:implement, fake claude for implementation, stub via ANTHROPIC_BASE_URL.
 * Teardown: temp repo, fake CLIs, screenshot dir and stub server removed.
 */

import {
  heroFinding, readNewestRunFile, runImplementAsync, runSmoke, type SmokeContext,
} from './support/design-conformance-scenario';

const sentinelModel = 'claude-conformance-sentinel';

const textOf = (body: Record<string, any>): string =>
  (body.messages?.[0]?.content as Array<Record<string, any>>)
    .filter(block => block.type === 'text').map(block => block.text).join('\n');

const imageCount = (body: Record<string, any>): number =>
  (body.messages?.[0]?.content as Array<Record<string, any>>).filter(block => block.type === 'image').length;

const verifyOutput = ({ check }: SmokeContext, output: string, exitCode: number | null): void => {
  check(exitCode === 0, 'run exits 0 even with a reported finding', output.slice(-800));
  const first = output.indexOf('[design-check] 1/2 hero.png');
  check(first >= 0 && output.indexOf('[design-check] 2/2 card.png') > first, 'progress lines appear in order');
  const line = `hero.png — ${heroFinding.area}: ${heroFinding.deviation}`;
  check(output.includes('Design conformance (advisory):') && output.includes(line), 'advisory block names hero.png');
};

const verifyRequests = ({ check, stub }: SmokeContext): void => {
  const bodies = stub.requests.map(request => request.body);
  check(bodies.length === 2, 'stub received exactly 2 requests', `got ${bodies.length}`);
  check(bodies.length > 0 && bodies.every(body => imageCount(body) === 1), 'each request has one image block');
  check(
    bodies.length > 0 && bodies.every(body => textOf(body).includes('+// implemented')),
    'each request carries the diff',
  );
  check(
    bodies.length > 0 && bodies.every(body => body.model === sentinelModel),
    'model comes from designConformance.model', JSON.stringify(bodies.map(body => body.model)),
  );
};

const verifyRunFile = ({ check, scenario }: SmokeContext): void => {
  const findings = readNewestRunFile(scenario)?.run?.designConformance;
  const ok = Array.isArray(findings) && findings.length === 1 && findings[0].screenshot === scenario.screenshots.hero;
  check(ok, 'run file carries exactly the hero.png finding', JSON.stringify(findings));
};

void runSmoke({
  prefix: 'wf-dc-standard-',
  stage: { designConformance: { enabled: true, backend: 'standard', provider: 'anthropic', model: sentinelModel } },
  verify: async context => {
    const { exitCode, output } = await runImplementAsync(context.scenario, context.stub.baseUrl);
    verifyOutput(context, output, exitCode);
    verifyRequests(context);
    verifyRunFile(context);
  },
}).catch(error => {
  console.error(error);
  process.exit(1);
});
