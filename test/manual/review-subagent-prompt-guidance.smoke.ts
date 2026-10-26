/**
 * Manual smoke test: the review prompt delivered to the backend contains the sub-agent delegation
 * guidance with the file:line evidence requirement
 *
 * Run (after `yarn build`): nr test:manual review-subagent-prompt-guidance.smoke
 *
 * Scenario: `node dist/main.js issue:review --silent --skip-verification` with the review stage on the
 * claude CLI backend and an uncommitted change in a temp git repo. A fake `claude` records the main
 * review turn's argv and stdin prompt, then returns a minimal approved review.
 *
 * Config under test:
 *   stages: { review: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. The review command exits 0.
 *   2. The main-turn prompt contains the "Sub-agent delegation" section.
 *   3. It requires file:line evidence and discards unevidenced claims.
 *   4. It hunts dead or unreachable code and impossible states.
 *   5. It carries the inline fallback clause for backends without a sub-agent tool.
 *   6. The section sits after "Trace principles" and before "Return ONLY a valid JSON object".
 *
 * Wire up: support/review-cli-harness.ts (temp git repo, fake `claude` on PATH, isolated HOME);
 * requires `yarn build`.
 * Teardown: the harness temp root (repo, bin, home, prompts) is removed.
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupReviewHarness, distMainPath, readReviewPrompt, runReview, setupReviewHarness,
} from './support/review-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const review = {
  summary: 'Smoke review',
  issues: [],
  suggestions: [],
  approved: true,
};

function verifyGuidanceContent(prompt: string): void {
  assert('prompt contains the Sub-agent delegation section', prompt.includes('Sub-agent delegation'),
    prompt.slice(0, 400));
  assert('prompt requires file:line evidence', prompt.includes('file:line'));
  assert('prompt discards unevidenced claims', prompt.includes('discard unevidenced claims'));
  assert('prompt hunts dead or unreachable code', prompt.includes('dead or unreachable code'));
  assert('prompt hunts impossible states', prompt.includes('impossible states'));
  assert('prompt carries the inline fallback clause', prompt.includes('Without a sub-agent tool'));
}

function verifyGuidancePosition(prompt: string): void {
  const tracePosition = prompt.indexOf('Trace principles');
  const guidancePosition = prompt.indexOf('Sub-agent delegation');
  const schemaPosition = prompt.indexOf('Return ONLY a valid JSON object');
  assert('sub-agent guidance follows the trace principles',
    tracePosition >= 0 && guidancePosition > tracePosition,
    `trace=${tracePosition} guidance=${guidancePosition}`);
  assert('sub-agent guidance precedes the output schema',
    schemaPosition >= 0 && guidancePosition < schemaPosition,
    `guidance=${guidancePosition} schema=${schemaPosition}`);
}

function verifyReviewPromptGuidance(): void {
  const harness = setupReviewHarness('wf-review-subagent-prompt-', review);
  try {
    const { exitCode, output } = runReview(harness);
    assert('review command exits 0', exitCode === 0, output.slice(-600));
    const prompt = readReviewPrompt(harness, 1);
    verifyGuidanceContent(prompt);
    verifyGuidancePosition(prompt);
  } finally {
    cleanupReviewHarness(harness);
  }
}

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Review sub-agent prompt guidance — smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  verifyReviewPromptGuidance();
  summarise(counts);
}

main();
