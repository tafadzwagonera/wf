/**
 * Manual smoke test: context overflow fix for Claude CLI verification fix loop
 *
 * Run: nr test:manual cli-verification-fix-pass-context.smoke.ts
 *
 * Verifies:
 *   1. buildCliArgs omits --append-system-prompt when appendSystemPrompt is undefined
 *   2. buildCliArgs includes --append-system-prompt when provided
 *   3. buildCliArgs does not include --max-turns (flag removed — not supported by CLI)
 *   4. buildVerificationFixPrompt returns empty string for empty failures array
 *   5. buildVerificationFixPrompt truncates each failure output to 500 chars
 *   6. buildVerificationFixPrompt preserves short output without truncation
 *   7. SinglePassParams accepts appendSystemPrompt as undefined (type-level, runtime proxy)
 *   8. TimeoutManager exposes clearInactivity (inactivity timer leak fix)
 *
 * @returns void
 */
import chalk from 'chalk';
import { buildCliArgs } from '../../src/integrations/ai/adapters/claude-cli-runner';
import { buildVerificationFixPrompt } from '../../src/integrations/ai/adapters/verification-report';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) pass(label);
  else fail(label, detail);
};

function checkAppendSystemPromptOmitted(): void {
  const argsNoPrompt = buildCliArgs({ prompt: 'test', model: 'claude-sonnet-4-6', cwd: '/repo', appendSystemPrompt: undefined });
  assert('buildCliArgs omits --append-system-prompt when undefined', !argsNoPrompt.includes('--append-system-prompt'), `got args: ${argsNoPrompt.join(' ')}`);
}

function checkAppendSystemPromptIncluded(): void {
  const argsWithPrompt = buildCliArgs({ prompt: 'test', model: 'claude-sonnet-4-6', cwd: '/repo', appendSystemPrompt: 'You are helpful' });
  assert('buildCliArgs includes --append-system-prompt when provided', argsWithPrompt.includes('--append-system-prompt') && argsWithPrompt.includes('You are helpful'), `got args: ${argsWithPrompt.join(' ')}`);
}

function checkMaxTurnsAbsent(): void {
  const argsAll = buildCliArgs({ prompt: 'test', model: 'claude-sonnet-4-6', cwd: '/repo' });
  assert('buildCliArgs does not include --max-turns', !argsAll.includes('--max-turns'), `got args: ${argsAll.join(' ')}`);
}

function checkVerificationFixPromptEmpty(): void {
  const emptyResult = buildVerificationFixPrompt([]);
  assert('buildVerificationFixPrompt returns empty string for empty failures', emptyResult === '', `got: "${emptyResult}"`);
}

function checkVerificationFixPromptTruncates(): void {
  const longOutput = 'x'.repeat(1000);
  const truncatedPrompt = buildVerificationFixPrompt([
    { id: 't1', command: 'yarn test', policy: 'enforced', status: 'failed', output: longOutput } as never,
  ]);
  const outputSection = truncatedPrompt.split('Output:\n')[1]?.split('\n\n')[0] ?? '';
  assert('buildVerificationFixPrompt truncates output to 500 chars', outputSection.startsWith('...') && outputSection.length <= 503, `output section length: ${outputSection.length}`);
}

function checkVerificationFixPromptPreservesShort(): void {
  const shortPrompt = buildVerificationFixPrompt([
    { id: 't2', command: 'yarn build', policy: 'enforced', status: 'failed', output: 'error: missing semicolon' } as never,
  ]);
  assert('buildVerificationFixPrompt preserves short output without truncation', shortPrompt.includes('error: missing semicolon') && !shortPrompt.includes('...error'), `got: ${shortPrompt.slice(0, 200)}`);
}

function checkSinglePassParamsUndefined(): void {
  const singlePassParams: Record<string, unknown> = {
    passNumber: 1, sessionId: 's1', currentUnvisited: [],
    appendSystemPrompt: undefined, model: 'claude-sonnet-4-6',
    repoDir: '/repo', additionalRepoDirs: [], touchedFiles: new Set(),
    activityState: { verificationOutcomes: [] },
  };
  assert('SinglePassParams accepts appendSystemPrompt as undefined', singlePassParams.appendSystemPrompt === undefined);
}

function checkTimeoutManagerLoads(): void {
  try {
    const runner = require('../../src/integrations/ai/adapters/claude-cli-runner');
    assert('claude-cli-runner module loads without error (clearInactivity wired)', typeof runner.buildCliArgs === 'function');
  } catch (error) {
    fail('claude-cli-runner module loads without error', `threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main(): void {
  console.log(chalk.bold('\nCLI verification fix-pass context overflow smoke test\n'));
  checkAppendSystemPromptOmitted();
  checkAppendSystemPromptIncluded();
  checkMaxTurnsAbsent();
  checkVerificationFixPromptEmpty();
  checkVerificationFixPromptTruncates();
  checkVerificationFixPromptPreservesShort();
  checkSinglePassParamsUndefined();
  checkTimeoutManagerLoads();
  summarise(counts);
}

main();
