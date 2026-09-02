/**
 * Manual smoke test: shared routing module and incomplete-work loop
 *
 * Run: nr test:manual -- test-shared-routing-and-incomplete-work
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

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}`));
    failed++;
  }
};

const adaptersDir = path.join(__dirname, '..', '..', 'src', 'integrations', 'ai', 'adapters');

function main(): void {
  console.log(chalk.bold('\nSmoke test: shared routing and incomplete-work loop\n'));

  const openaiSource = fs.readFileSync(path.join(adaptersDir, 'openai-agent.adapter.ts'), 'utf8');
  const anthropicSource = fs.readFileSync(path.join(adaptersDir, 'anthropic-agent.adapter.ts'), 'utf8');
  const cliSource = fs.readFileSync(path.join(adaptersDir, 'claude-cli.adapter.ts'), 'utf8');

  assert(
    'OpenAI adapter does not define local MECHANICAL_STEP_PATTERNS',
    !openaiSource.includes('const MECHANICAL_STEP_PATTERNS')
  );
  assert(
    'Anthropic adapter does not define local MECHANICAL_STEP_PATTERNS',
    !anthropicSource.includes('const MECHANICAL_STEP_PATTERNS')
  );
  assert('OpenAI adapter imports from shared-routing', openaiSource.includes('from \'./shared-routing\''));
  assert('Anthropic adapter imports from shared-routing', anthropicSource.includes('from \'./shared-routing\''));

  assert(
    'OpenAI adapter builds continuation prompts via buildIterationPrompt',
    openaiSource.includes('buildIterationPrompt')
    && !openaiSource.includes('iterationAgent')
    && !openaiSource.includes('iterationRunner')
  );
  assert(
    'Anthropic adapter resumes session across passes',
    anthropicSource.includes('resume: p.sessionId') && !anthropicSource.includes('lastPassSummary')
  );

  assert('Anthropic adapter uses discoverChangedFiles', anthropicSource.includes('discoverChangedFiles'));

  assert(
    'OpenAI adapter defines MAX_VERIFICATION_OUTPUT_LINES',
    openaiSource.includes('MAX_VERIFICATION_OUTPUT_LINES')
  );
  assert('OpenAI adapter uses truncateOutput in verify_command', openaiSource.includes('truncateOutput('));

  assert('OpenAI edit_file returns existing_code on validation failure', openaiSource.includes('existing_code:'));
  assert(
    'OpenAI edit_file returns hint on validation failure',
    openaiSource.includes('Merge your changes into the existing declaration')
  );

  assert('stripRepoPrefix strips prefix correctly', stripRepoPrefix('primary/src/foo.ts', 'primary') === 'src/foo.ts');
  assert(
    'stripRepoPrefix returns path unchanged when no prefix match',
    stripRepoPrefix('src/foo.ts', 'primary') === 'src/foo.ts'
  );

  assert('isGlobPattern detects star wildcard', isGlobPattern('src/**/*.ts'));
  assert('isGlobPattern detects single star', isGlobPattern('src/*.controller.ts'));
  assert('isGlobPattern detects question mark', isGlobPattern('src/foo?.ts'));
  assert('isGlobPattern returns false for concrete path', !isGlobPattern('src/main.ts'));
  assert('isGlobPattern returns false for path with dots', !isGlobPattern('src/app.module.ts'));
  assert('OpenAI adapter filters glob patterns from unvisited files', openaiSource.includes('isGlobPattern'));
  assert('Anthropic adapter filters glob patterns from unvisited files', anthropicSource.includes('isGlobPattern'));

  assert(
    'Anthropic adapter continuation does not use defaultModel',
    !anthropicSource.includes('iterationModel = modelRoutingResult.defaultModel')
    && !anthropicSource.includes('iterationModel')
  );

  assert(
    'Claude CLI adapter continuation uses routed model',
    !cliSource.includes('modelRoutingResult.defaultModel')
    && cliSource.includes('modelRoutingResult.model')
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
}

main();
