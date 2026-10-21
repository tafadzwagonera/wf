/**
 * Manual smoke test: designConformance config is validated at load time
 *
 * Run: nr test:manual design-conformance-config-validation.smoke.ts
 *
 * Scenario: issue:implement is started with wf.config.js variants. A provider without a model, an unknown backend
 * and an unknown key must each fail loudly before any CLI runs; a valid provider, model and backend must load.
 *
 * Verify:
 *   1. Each invalid variant exits 1 and names designConformance and the offending field.
 *   2. No fake CLI is spawned for an invalid variant.
 *   3. The valid variant loads without an "Invalid wf config" error.
 *
 * Wire up: compiled CLI via issue:implement with real wf.config.js variants in a temp git repo.
 * Teardown: temp repo, fake CLIs, screenshot dir and stub server removed.
 */

import { countSpawns } from './support/implement-cli-harness';
import {
  readInvocations, runImplementAsync, runSmoke, writeImplementConfig, type SmokeContext,
} from './support/design-conformance-scenario';

const invalid = [
  { name: 'provider without model', value: { enabled: true, provider: 'openai' }, expected: 'designConformance.model' },
  { name: 'unknown backend', value: { enabled: true, backend: 'sdk' }, expected: 'backend' },
  { name: 'unknown key', value: { enabled: true, stallWindow: 3 }, expected: 'stallWindow' },
];

const verifyInvalid = async (context: SmokeContext, testCase: typeof invalid[number]): Promise<void> => {
  const { check, scenario, stub } = context;
  writeImplementConfig(scenario, { designConformance: testCase.value });
  const { exitCode, output } = await runImplementAsync(scenario, stub.baseUrl);
  check(exitCode === 1, `${testCase.name}: exits 1`, `exit ${exitCode}`);
  check(
    output.includes('designConformance') && output.includes(testCase.expected),
    `${testCase.name}: output names designConformance and ${testCase.expected}`, output.slice(-800),
  );
  check(readInvocations(scenario).length === 0 && countSpawns(scenario.harness) === 0, `${testCase.name}: no CLI spawned`);
};

const verifyValid = async ({ check, scenario, stub }: SmokeContext): Promise<void> => {
  const value = { enabled: true, backend: 'cli', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' };
  writeImplementConfig(scenario, { designConformance: value });
  const { output } = await runImplementAsync(scenario, stub.baseUrl);
  check(!output.includes('Invalid wf config'), 'valid provider, model and backend load without a config error', output.slice(-800));
};

void runSmoke({
  prefix: 'wf-dc-config-',
  stage: {},
  verify: async context => {
    for (const testCase of invalid) await verifyInvalid(context, testCase);
    await verifyValid(context);
  },
}).catch(error => {
  console.error(error);
  process.exit(1);
});
