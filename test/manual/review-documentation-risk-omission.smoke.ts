/**
 * Manual smoke test: the review prompt instructs the model to omit risk entirely for
 * documentation issues
 *
 * Run (after `yarn build`): nr test:manual review-documentation-risk-omission.smoke
 *
 * Scenario: `node dist/main.js issue:review --silent --skip-verification` with the review stage on
 * the claude CLI backend and an uncommitted change in a temp git repo. A fake `claude` records the
 * main review turn's argv and stdin prompt, then returns a minimal approved review. This exercises
 * the fix to `reviewInstructions`/`reviewOutputSchema` in src/integrations/ai/prompt-fragments.ts:
 * the prompt previously said to "give [documentation issues] a severity without a risk score" (the
 * model still attached a `risk` value in practice — e.g. `risk 0.9` on a code-comment finding in a
 * real review run); it now explicitly says to "never attach a risk score" and to
 * "omit the \"risk\" field entirely", and the schema example now shows a risk-less documentation
 * issue alongside risk-carrying code issues.
 *
 * Config under test:
 *   stages: { review: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. The review command exits 0.
 *   2. The main-turn prompt contains the literal phrase "never attach a risk score to them".
 *   3. The main-turn prompt contains the literal phrase `omit the "risk" field entirely`.
 *   4. The JSON schema example embedded in the prompt is valid JSON and contains at least one
 *      `issues[]` entry with no `risk` key at all, alongside at least one entry that does carry a
 *      numeric `risk`.
 *
 * Wire up: support/review-cli-harness.ts (temp git repo, fake `claude` on PATH, isolated HOME) —
 * the same harness as review-subagent-prompt-guidance.smoke.ts.
 * Teardown: the harness temp root (repo, bin, home, prompts) is removed via cleanupReviewHarness.
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

const extractSchemaExample = (prompt: string): Record<string, unknown> | null => {
  const referenceMarker = prompt.indexOf('Return ONLY a valid JSON object. Reference:');
  if (referenceMarker < 0) return null;
  const start = prompt.indexOf('{"summary"', referenceMarker);
  if (start < 0) return null;
  const end = prompt.indexOf('\n', start);
  const line = end < 0 ? prompt.slice(start) : prompt.slice(start, end);
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

function verifyGuidanceWording(prompt: string): void {
  assert('prompt forbids attaching a risk score to documentation issues',
    prompt.includes('never attach a risk score to them'), prompt.slice(0, 400));
  assert('prompt tells the model to omit the "risk" field entirely',
    prompt.includes('omit the "risk" field entirely'));
}

const extractIssues = (parsed: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(parsed['issues']) ? parsed['issues'] as Record<string, unknown>[] : [];

function verifySchemaExample(prompt: string): void {
  const parsed = extractSchemaExample(prompt);
  if (!parsed) {
    fail('schema example JSON should parse', prompt.slice(0, 400));
    return;
  }
  const issues = extractIssues(parsed);
  const hasRiskless = issues.some(issue => !('risk' in issue));
  const hasRisk = issues.some(issue => typeof issue['risk'] === 'number');
  assert('schema example includes a documentation issue with no risk key', hasRiskless,
    JSON.stringify(issues));
  assert('schema example still includes a code issue carrying a numeric risk', hasRisk,
    JSON.stringify(issues));
}

function verifyReviewPromptGuidance(): void {
  const harness = setupReviewHarness('wf-review-doc-risk-', review);
  try {
    const { exitCode, output } = runReview(harness);
    assert('review command exits 0', exitCode === 0, output.slice(-600));
    const prompt = readReviewPrompt(harness, 1);
    verifyGuidanceWording(prompt);
    verifySchemaExample(prompt);
  } finally {
    cleanupReviewHarness(harness);
  }
}

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Review documentation risk omission — smoke test\n'));
  if (!fs.existsSync(distMainPath)) failMissingDist();
  verifyReviewPromptGuidance();
  summarise(counts);
}

main();
