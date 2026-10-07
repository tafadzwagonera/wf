/**
 * Manual smoke test: buildInitialUserPrompt shared between Anthropic and CLI adapters
 *
 * Run: nr test:manual initial-user-prompt-dedup.smoke.ts
 *
 * Verifies:
 *   1. buildInitialUserPrompt is exported from shared-routing.ts.
 *   2. Neither Anthropic nor CLI adapter defines a local buildInitialUserPrompt.
 *   3. Both adapters import resolveInitialUserPrompt (which wraps buildInitialUserPrompt) from shared-routing.
 *   4. Live output contains task brief and action instruction, not behavioral context.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildInitialUserPrompt } from '../../src/integrations/ai/adapters/shared-routing';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean): void =>
  condition ? pass(label) : fail(label);

function readAdapterSources(): { anthropicSource: string; cliSource: string; sharedSource: string } {
  const adaptersDir = path.join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters');
  return {
    anthropicSource: fs.readFileSync(path.join(adaptersDir, 'anthropic-agent.adapter.ts'), 'utf8'),
    cliSource: fs.readFileSync(path.join(adaptersDir, 'claude-cli.adapter.ts'), 'utf8'),
    sharedSource: fs.readFileSync(path.join(adaptersDir, 'shared-routing.ts'), 'utf8'),
  };
}

function checkStructuralAssertions(anthropicSource: string, cliSource: string, sharedSource: string): void {
  assert('shared-routing exports buildInitialUserPrompt',
    sharedSource.includes('export const buildInitialUserPrompt'));
  assert('Anthropic adapter does NOT define local buildInitialUserPrompt',
    !anthropicSource.includes('const buildInitialUserPrompt'));
  assert('CLI adapter does NOT define local buildInitialUserPrompt',
    !cliSource.includes('const buildInitialUserPrompt'));
  assert('Anthropic adapter imports resolveInitialUserPrompt from shared-routing',
    anthropicSource.includes('resolveInitialUserPrompt') && anthropicSource.includes("from './shared-routing'"));
  assert('CLI adapter imports resolveInitialUserPrompt from shared-routing',
    cliSource.includes('resolveInitialUserPrompt') && cliSource.includes("from './shared-routing'"));
}

function buildOutputForLiveAssertions(): string {
  return buildInitialUserPrompt({
    ticketKey: 'DEDUP-1',
    repoName: 'repo',
    repoFiles: ['repo/src/main.ts'],
    trackedFilePaths: ['repo/src/main.ts'],
    verificationScripts: [
      { id: 'build', name: 'build', command: 'yarn build', policy: 'enforced', aliases: [] },
    ],
    planSteps: ['Update main'],
    planSummary: 'Refactor entry point',
    planAction: 'feature',
  });
}

function checkLiveOutputAssertions(output: string): void {
  assert('output starts with Ticket key', output.startsWith('Ticket key: DEDUP-1'));
  assert('output contains plan summary', output.includes('Refactor entry point'));
  assert('output contains action instruction',
    output.includes('Implement the changes described above now'));
  assert('output contains Verification commands', output.includes('Verification commands:'));
  assert('output does NOT contain behavioral context',
    !output.includes('You are an expert software engineer'));
  assert('output does NOT contain Repository directory:',
    !output.includes('Repository directory:'));
}

async function main(): Promise<void> {
  const { anthropicSource, cliSource, sharedSource } = readAdapterSources();
  console.log(chalk.bold('\n  Scenario 1: deduplication structural assertions\n'));
  checkStructuralAssertions(anthropicSource, cliSource, sharedSource);
  console.log(chalk.bold('\n  Scenario 2: live output assertions\n'));
  const output = buildOutputForLiveAssertions();
  checkLiveOutputAssertions(output);
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
