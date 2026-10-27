/**
 * Manual Test: issue:plan on the Anthropic Agent SDK backend narrates tool activity
 *
 * Run: nr test:manual issue-plan-anthropic-agent-sdk-tool-activity-narration-live.smoke
 *
 * Calls the real Anthropic API; requires ANTHROPIC_API_KEY. Skips with exit 0 when it is absent.
 *
 * Verifies:
 *   1. issue:plan exits 0 on the agent backend
 *   2. stdout shows a `[claude-agent-sdk] Running: <Tool>(...)` line
 *   3. stdout shows a `[claude-agent-sdk] Tool completed` or `Tool failed` line
 *   4. no tool-activity line uses the `[claude-cli]` label
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  cleanupPlanHarness, runPlanCli, setupPlanHarness, type PlanHarness, type PlanRunResult,
} from './support/plan-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const SOURCE_TEXT = [
  '# Smoke source',
  '',
  'Before planning, use your Read tool to open `notes.txt` in the repository root and quote its first line',
  'in the plan summary. Then plan a trivial fix.',
  '',
].join('\n');

const WALL_CLOCK_TIMEOUT_IN_MS = 300_000;

const check = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

const buildAgentConfig = (apiKey: string): string => [
  'module.exports = {',
  '  ai: [',
  `    { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: ${JSON.stringify(apiKey)} },`,
  '  ],',
  '  stages: {',
  "    plan: { provider: 'anthropic', backend: 'agent', model: 'claude-sonnet-4-6' },",
  '  },',
  '};',
  '',
].join('\n');

const runScenario = (harness: PlanHarness, apiKey: string): PlanRunResult => {
  fs.writeFileSync(path.join(harness.repoDir, 'wf.config.js'), buildAgentConfig(apiKey), 'utf-8');
  fs.writeFileSync(path.join(harness.repoDir, 'source.md'), SOURCE_TEXT, 'utf-8');
  fs.writeFileSync(path.join(harness.repoDir, 'notes.txt'), 'Smoke notes line one\n', 'utf-8');
  return runPlanCli(
    harness,
    ['--action', 'fix', '--custom-plan', path.join(harness.repoDir, 'source.md')],
    WALL_CLOCK_TIMEOUT_IN_MS
  );
};

const runChecks = ({ exitCode, output }: PlanRunResult): void => {
  const tail = output.slice(-800);
  const toolLines = output.split('\n').filter(line => /Running: \w+\(|Tool (?:completed|failed)/.test(line));
  check(exitCode === 0, 'issue:plan exits 0', tail);
  check(/\[claude-agent-sdk\] Running: \w+\(.+\)/.test(output), 'shows [claude-agent-sdk] Running: line', tail);
  check(/\[claude-agent-sdk\] Tool (?:completed|failed)/.test(output), 'shows [claude-agent-sdk] Tool result line', tail);
  check(!toolLines.some(line => line.includes('[claude-cli]')), 'no tool line uses the [claude-cli] label', toolLines.join('\n'));
};

const main = async (): Promise<void> => {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    console.log('SKIP: ANTHROPIC_API_KEY is not set');
    return;
  }
  console.log('\n issue:plan Anthropic Agent SDK tool activity narration\n');
  const harness = setupPlanHarness('wf-agent-sdk-tool-activity-', {});
  try {
    runChecks(runScenario(harness, apiKey));
  } finally {
    cleanupPlanHarness(harness);
  }
  summarise(counts);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
