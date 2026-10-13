/**
 * Manual smoke test: a stage-level model whose prefix belongs to another provider is rejected at config load
 *
 * Run: nr test:manual config-stage-model-provider-mismatch.smoke
 *
 * Verifies:
 *   1. stages.review, implement.models.mechanical and planStepVerification mismatches exit non-zero
 *      with the mismatch message
 *   2. The command body never runs when config load fails
 *   3. Matching and inherited models load and exit 0
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const distMainPath = path.join(__dirname, '../../dist/main.js');
const { counts, pass, fail } = createReporter();

type Scenario = { name: string; stages: string; expectedError?: RegExp };

const scenarios: Scenario[] = [
  {
    name: 'stages.review explicit mismatched model',
    stages: "{ review: { provider: 'anthropic', model: 'gpt-5.4' } }",
    expectedError: /model "gpt-5\.4" does not match provider "anthropic"[\s\S]*"gpt-"[\s\S]*"openai"/,
  },
  {
    name: 'implement.models.mechanical mismatched model',
    stages: "{ implement: { provider: 'anthropic', models: { mechanical: 'gpt-5.4' } } }",
    expectedError: /model "gpt-5\.4" does not match provider "anthropic"/,
  },
  {
    name: 'planStepVerification model-only mismatch against the implement provider',
    stages: "{ implement: { provider: 'anthropic', planStepVerification: { model: 'gpt-5.4' } } }",
    expectedError: /model "gpt-5\.4" does not match provider "anthropic"/,
  },
  {
    name: 'planStepVerification explicit provider with mismatched model',
    stages: "{ implement: { provider: 'anthropic', planStepVerification: { provider: 'openai', model: 'claude-sonnet-4-6' } } }",
    expectedError: /model "claude-sonnet-4-6" does not match provider "openai"[\s\S]*"claude-"[\s\S]*"anthropic"/,
  },
  { name: 'matching explicit model', stages: "{ review: { provider: 'openai', model: 'gpt-5.4' } }" },
  { name: 'inherited model', stages: "{ review: { provider: 'openai' } }" },
];

const writeConfig = (repoDir: string, stages: string): void => {
  const config = [
    'module.exports = {',
    "  ai: [{ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'k', default: true },",
    "        { provider: 'openai', model: 'gpt-5.4', apiKey: 'k' }],",
    `  stages: ${stages},`,
    '};',
  ].join('\n');
  fs.writeFileSync(path.join(repoDir, 'wf.config.js'), config);
};

type CowsayRun = { status: number | null; output: string };

const runCowsay = (tempRoot: string, repoDir: string): CowsayRun => {
  const result = spawnSync(process.execPath, [distMainPath, 'issue:cowsay'], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, HOME: path.join(tempRoot, 'home'), WF_SKIP_CLI_VERSION_CHECK: '1' },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const createRepo = (tempRoot: string, name: string, stages: string): string => {
  const repoDir = path.join(tempRoot, name);
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  writeConfig(repoDir, stages);
  return repoDir;
};

const assertRejected = (scenario: Scenario, run: CowsayRun): void => {
  const rejected = run.status !== 0 && Boolean(scenario.expectedError?.test(run.output));
  if (rejected) pass(`${scenario.name}: rejected at config load`);
  else fail(`${scenario.name}: expected non-zero exit with mismatch message`, `status=${run.status} output=${run.output}`);
};

const assertAccepted = (scenario: Scenario, run: CowsayRun): void => {
  const accepted = run.status === 0 && !run.output.includes('does not match provider');
  if (accepted) pass(`${scenario.name}: loaded`);
  else fail(`${scenario.name}: expected exit 0 and no mismatch message`, `status=${run.status} output=${run.output}`);
};

const runScenario = (tempRoot: string, scenario: Scenario, index: number): CowsayRun => {
  const run = runCowsay(tempRoot, createRepo(tempRoot, `repo-${index}`, scenario.stages));
  if (scenario.expectedError) assertRejected(scenario, run);
  else assertAccepted(scenario, run);
  return run;
};

const assertCommandBodySkipped = (rejectedRun: CowsayRun, acceptedRun: CowsayRun): void => {
  const bodyOutput = acceptedRun.output.trim();
  const bodyRanDespiteFailure = bodyOutput.length > 0 && rejectedRun.output.includes(bodyOutput);
  if (bodyRanDespiteFailure) fail('cowsay output appeared despite config failure', rejectedRun.output);
  else pass('command output is absent when config load fails');
};

const main = (): void => {
  if (!fs.existsSync(distMainPath)) throw new Error('dist/main.js must exist. Run `yarn build` first.');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-model-mismatch-'));
  try {
    const runs = scenarios.map((scenario, index) => runScenario(tempRoot, scenario, index));
    assertCommandBodySkipped(runs[0], runs[4]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
};

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
