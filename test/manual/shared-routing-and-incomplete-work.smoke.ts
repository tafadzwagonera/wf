/**
 * Manual smoke test: shared routing module and incomplete-work loop
 *
 * Run: nr test:manual shared-routing-and-incomplete-work.smoke.ts
 *
 * Verifies source-level structural invariants and utility behaviour not covered
 * by framework specs (detectMechanicalTask cascade, resolveModelRouting config
 * precedence, and workload-reduction stall detection are in *.spec.ts).
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  stripRepoPrefix,
  isGlobPattern,
} from '../../src/integrations/ai/adapters/shared-routing';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean): void =>
  condition ? pass(label) : fail(label);

const adaptersDir = path.join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters');

function checkMechanicalPatterns(openaiSource: string, anthropicSource: string): void {
  assert('OpenAI adapter does not define local MECHANICAL_STEP_PATTERNS', !openaiSource.includes('const MECHANICAL_STEP_PATTERNS'));
  assert('Anthropic adapter does not define local MECHANICAL_STEP_PATTERNS', !anthropicSource.includes('const MECHANICAL_STEP_PATTERNS'));
  assert('OpenAI adapter imports from shared-routing', openaiSource.includes('from \'./shared-routing\''));
  assert('Anthropic adapter imports from shared-routing', anthropicSource.includes('from \'./shared-routing\''));
}

function checkCodexCliAdapter(codexCliSource: string): void {
  assert('Codex CLI adapter imports from shared-routing', codexCliSource.includes('from \'./shared-routing\''));
  assert('Codex CLI adapter resolves model routing through shared-routing', codexCliSource.includes('resolveModelRouting'));
}

function checkIterationPatterns(openaiSource: string, anthropicSource: string): void {
  assert(
    'OpenAI adapter builds continuation prompts via buildIterationPrompt',
    openaiSource.includes('buildIterationPrompt') && !openaiSource.includes('iterationAgent') && !openaiSource.includes('iterationRunner')
  );
  assert('Anthropic adapter resumes session across passes', anthropicSource.includes('resume: p.sessionId') && !anthropicSource.includes('lastPassSummary'));
  assert('Anthropic adapter uses discoverChangedFiles', anthropicSource.includes('discoverChangedFiles'));
}

function checkOutputTruncation(openaiSource: string): void {
  assert('OpenAI adapter defines MAX_VERIFICATION_OUTPUT_LINES', openaiSource.includes('MAX_VERIFICATION_OUTPUT_LINES'));
  assert('OpenAI adapter uses truncateOutput in verify_command', openaiSource.includes('truncateOutput('));
  assert('OpenAI edit_file returns existing_code on validation failure', openaiSource.includes('existing_code:'));
  assert('OpenAI edit_file returns hint on validation failure', openaiSource.includes('Merge your changes into the existing declaration'));
}

function checkStripAndGlob(): void {
  assert('stripRepoPrefix strips prefix correctly', stripRepoPrefix('primary/src/foo.ts', 'primary') === 'src/foo.ts');
  assert('stripRepoPrefix returns path unchanged when no prefix match', stripRepoPrefix('src/foo.ts', 'primary') === 'src/foo.ts');
  assert('isGlobPattern detects star wildcard', isGlobPattern('src/**/*.ts'));
  assert('isGlobPattern detects single star', isGlobPattern('src/*.controller.ts'));
  assert('isGlobPattern detects question mark', isGlobPattern('src/foo?.ts'));
  assert('isGlobPattern returns false for concrete path', !isGlobPattern('src/main.ts'));
  assert('isGlobPattern returns false for path with dots', !isGlobPattern('src/app.module.ts'));
}

function checkGlobFiltering(openaiSource: string, anthropicSource: string): void {
  assert('OpenAI adapter filters glob patterns from unvisited files', openaiSource.includes('isGlobPattern'));
  assert('Anthropic adapter filters glob patterns from unvisited files', anthropicSource.includes('isGlobPattern'));
}

function checkModelRoutingContinuation(anthropicSource: string, cliSource: string): void {
  assert(
    'Anthropic adapter continuation does not use defaultModel',
    !anthropicSource.includes('iterationModel = modelRoutingResult.defaultModel') && !anthropicSource.includes('iterationModel')
  );
  assert(
    'Claude CLI adapter continuation uses routed model',
    !cliSource.includes('modelRoutingResult.defaultModel') && cliSource.includes('modelRoutingResult.model')
  );
}

type AdapterSources = { openaiSource: string; anthropicSource: string; cliSource: string; codexCliSource: string };

function readAdapterSources(): AdapterSources {
  const read = (fileName: string): string => fs.readFileSync(path.join(adaptersDir, fileName), 'utf8');
  return {
    openaiSource: read('openai-agent.adapter.ts'),
    anthropicSource: read('anthropic-agent.adapter.ts'),
    cliSource: read('claude-cli.adapter.ts'),
    codexCliSource: read('codex-cli.adapter.ts'),
  };
}

function main(): void {
  console.log(chalk.bold('\nSmoke test: shared routing and incomplete-work loop\n'));
  const { openaiSource, anthropicSource, cliSource, codexCliSource } = readAdapterSources();
  checkMechanicalPatterns(openaiSource, anthropicSource);
  checkCodexCliAdapter(codexCliSource);
  checkIterationPatterns(openaiSource, anthropicSource);
  checkOutputTruncation(openaiSource);
  checkStripAndGlob();
  checkGlobFiltering(openaiSource, anthropicSource);
  checkModelRoutingContinuation(anthropicSource, cliSource);
  summarise(counts);
}

main();
