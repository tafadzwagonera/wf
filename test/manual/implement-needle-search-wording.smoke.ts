/**
 * Manual smoke test: the claude-cli implement run tells the model to search the needle case-insensitively across
 * the whole repository and to delete orphans
 *
 * Run (after `yarn build`): nr test:manual implement-needle-search-wording.smoke
 *
 * Scenario: `node dist/main.js issue:implement <plan> --silent --no-branch --skip-install` on the claude CLI backend
 * with a 3-file plan and a fake `claude` that never edits anything. Spawn 1 carries the append-system prompt (argv)
 * and the task brief; spawn 2 is the continuation prompt. The fake claude records argv plus stdin per spawn.
 *
 * Config under test:
 *   stages: { implement: { provider: 'anthropic', backend: 'cli' } }
 *
 * Verify:
 *   1. The first prompt contains the broad case-insensitive substring search rule exactly once.
 *   2. The first prompt contains the delete-orphan rule.
 *   3. The first prompt asks for "the needle, case-insensitive, across the whole repository including non-code files"
 *      and no longer says "remaining migration patterns".
 *   4. The continuation prompt carries the same needle sentence and not "remaining migration patterns".
 *
 * Wire up: support/implement-cli-harness.ts (temp git repo, fake `claude` on PATH, isolated HOME); needs `yarn build`.
 * Teardown: the temp root (repo, bin, home, prompts) is removed.
 */
import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  cleanupHarness, distMainPath, readPrompt, runImplement, setupImplementHarness, type ImplementHarness,
} from './support/implement-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const NEEDLE_SENTENCE = 'the needle, case-insensitive, across the whole repository including non-code files';
const OLD_WORDING = 'remaining migration patterns';
const SEARCH_RULE = 'search with a broad case-insensitive substring search';
const plannedFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;

function verifyInitialPrompt(prompt: string): void {
  assert('search rule is present exactly once', countOccurrences(prompt, SEARCH_RULE) === 1, `count=${countOccurrences(prompt, SEARCH_RULE)}`);
  assert('delete-orphan rule is present', prompt.includes('delete it rather than leaving an orphaned module behind'));
  assert('needle sentence is present', prompt.includes(NEEDLE_SENTENCE));
  assert('old wording is gone', !prompt.includes(OLD_WORDING));
}

function verifyContinuationPrompt(prompt: string): void {
  assert('continuation prompt exists', prompt.length > 0, 'fake claude was not spawned a second time');
  assert('continuation prompt carries the needle sentence', prompt.includes(NEEDLE_SENTENCE), prompt.slice(-600));
  assert('continuation prompt dropped the old wording', !prompt.includes(OLD_WORDING));
}

function verifyWording(harness: ImplementHarness): void {
  runImplement(harness);
  verifyInitialPrompt(readPrompt(harness, 1));
  verifyContinuationPrompt(readPrompt(harness, 2));
}

function verifyImplementWording(): void {
  const harness = setupImplementHarness('wf-needle-wording-', 'noop', plannedFiles);
  try {
    verifyWording(harness);
  } finally {
    cleanupHarness(harness);
  }
  summarise(counts);
}

const failMissingDist = (): never => {
  fail('dist/main.js must exist', 'Run `yarn build` first.');
  return process.exit(1);
};

function main(): void {
  console.log(chalk.bold.cyan('\n  Implement needle-search wording — live smoke test\n'));
  const run = fs.existsSync(distMainPath) ? verifyImplementWording : failMissingDist;
  run();
}

main();
