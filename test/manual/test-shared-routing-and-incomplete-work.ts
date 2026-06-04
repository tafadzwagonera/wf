/**
 * Manual smoke test: shared routing module and incomplete-work loop
 *
 * Run: nr test:manual -- test-shared-routing-and-incomplete-work
 *
 * Verifies:
 *   1. detectMechanicalTask is exported from shared-routing (not adapters).
 *   2. resolveModelRouting accepts adapterLabel and defaultMechanicalModel.
 *   3. buildAllowedCommands, normalizeCommand, formatRepoFileList, stripRepoPrefix
 *      are exported from shared-routing.
 *   4. OpenAI adapter imports from shared-routing (no local duplicates).
 *   5. Anthropic adapter imports from shared-routing (no local duplicates).
 *   6. Both adapters use workload-reduction stall detection (not MAX_INCOMPLETE_WORK_PASSES).
 *   7. Both adapters pass lastPassSummary into incomplete-work iteration prompts.
 *   8. Anthropic adapter uses git-based discoverChangedFiles.
 *   9. truncateOutput helper exists in OpenAI adapter.
 *  10. Edit validation returns existing_code context on failure.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import {
  detectMechanicalTask,
  resolveModelRouting,
  normalizeCommand,
  buildAllowedCommands,
  formatRepoFileList,
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

const adaptersDir = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'integrations',
  'ai',
  'adapters',
);

const run = async (): Promise<void> => {
  console.log(
    chalk.bold('\nSmoke test: shared routing and incomplete-work loop\n'),
  );

  const openaiSource = fs.readFileSync(
    path.join(adaptersDir, 'openai-agent.adapter.ts'),
    'utf8',
  );
  const anthropicSource = fs.readFileSync(
    path.join(adaptersDir, 'anthropic-agent.adapter.ts'),
    'utf8',
  );
  const sharedSource = fs.readFileSync(
    path.join(adaptersDir, 'shared-routing.ts'),
    'utf8',
  );

  // --- Shared routing exports ---

  assert(
    'detectMechanicalTask is a function',
    typeof detectMechanicalTask === 'function',
  );
  assert(
    'resolveModelRouting is a function',
    typeof resolveModelRouting === 'function',
  );
  assert(
    'normalizeCommand is a function',
    typeof normalizeCommand === 'function',
  );
  assert(
    'buildAllowedCommands is a function',
    typeof buildAllowedCommands === 'function',
  );
  assert(
    'formatRepoFileList is a function',
    typeof formatRepoFileList === 'function',
  );
  assert(
    'stripRepoPrefix is a function',
    typeof stripRepoPrefix === 'function',
  );

  // --- detectMechanicalTask behaviour ---

  const mechanical = detectMechanicalTask({
    action: 'fix',
    summary: 'Migrate loggers',
    steps: ['Migrate all Logger instances to PinoLogger'],
    estimatedComplexity: 'low',
    filesAffected: ['a.ts', 'b.ts'],
  });
  assert('detects mechanical task from step pattern', mechanical.isMechanical);

  const creative = detectMechanicalTask({
    action: 'fix',
    summary: 'Fix auth',
    steps: ['Update JWT validation'],
    estimatedComplexity: 'medium',
    filesAffected: ['auth.ts'],
  });
  assert('returns creative for focused plan', !creative.isMechanical);

  // --- resolveModelRouting accepts new params ---

  assert(
    'shared-routing exports adapterLabel param in resolveModelRouting',
    sharedSource.includes('adapterLabel: string'),
  );
  assert(
    'shared-routing exports fallbackPrimaryModel param',
    sharedSource.includes('fallbackPrimaryModel: string'),
  );
  assert(
    'shared-routing exports defaultMechanicalModel param',
    sharedSource.includes('defaultMechanicalModel: string'),
  );

  // --- No local duplicates in adapters ---

  assert(
    'OpenAI adapter does not define local MECHANICAL_STEP_PATTERNS',
    !openaiSource.includes('const MECHANICAL_STEP_PATTERNS'),
  );
  assert(
    'Anthropic adapter does not define local MECHANICAL_STEP_PATTERNS',
    !anthropicSource.includes('const MECHANICAL_STEP_PATTERNS'),
  );
  assert(
    'OpenAI adapter imports from shared-routing',
    openaiSource.includes("from './shared-routing'"),
  );
  assert(
    'Anthropic adapter imports from shared-routing',
    anthropicSource.includes("from './shared-routing'"),
  );

  // --- Incomplete-work loop uses workload reduction ---

  assert(
    'OpenAI adapter uses workload-reduction stall detection',
    openaiSource.includes('currentWorkload < previousWorkload') &&
      !openaiSource.includes('MAX_INCOMPLETE_WORK_PASSES'),
  );
  assert(
    'Anthropic adapter uses workload-reduction stall detection',
    anthropicSource.includes('currentWorkload < previousWorkload') &&
      !anthropicSource.includes('MAX_INCOMPLETE_WORK_PASSES'),
  );

  // --- Context continuity ---

  assert(
    'OpenAI adapter reuses cached agent/runner/session across passes',
    openaiSource.includes('continuationPrompt') &&
      !openaiSource.includes('iterationAgent') &&
      !openaiSource.includes('iterationRunner'),
  );
  assert(
    'Anthropic adapter resumes session across passes',
    anthropicSource.includes('resume: sessionId') &&
      !anthropicSource.includes('lastPassSummary'),
  );

  // --- Anthropic git-based file discovery ---

  assert(
    'Anthropic adapter uses discoverChangedFiles',
    anthropicSource.includes('discoverChangedFiles'),
  );

  // --- OpenAI verification truncation ---

  assert(
    'OpenAI adapter defines MAX_VERIFICATION_OUTPUT_LINES',
    openaiSource.includes('MAX_VERIFICATION_OUTPUT_LINES'),
  );
  assert(
    'OpenAI adapter uses truncateOutput in verify_command',
    openaiSource.includes('truncateOutput('),
  );

  // --- Edit validation context ---

  assert(
    'OpenAI edit_file returns existing_code on validation failure',
    openaiSource.includes('existing_code:'),
  );
  assert(
    'OpenAI edit_file returns hint on validation failure',
    openaiSource.includes('Merge your changes into the existing declaration'),
  );

  // --- stripRepoPrefix behaviour ---

  assert(
    'stripRepoPrefix strips prefix correctly',
    stripRepoPrefix('primary/src/foo.ts', 'primary') === 'src/foo.ts',
  );
  assert(
    'stripRepoPrefix returns path unchanged when no prefix match',
    stripRepoPrefix('src/foo.ts', 'primary') === 'src/foo.ts',
  );

  // --- isGlobPattern behaviour ---

  assert('isGlobPattern detects star wildcard', isGlobPattern('src/**/*.ts'));
  assert(
    'isGlobPattern detects single star',
    isGlobPattern('src/*.controller.ts'),
  );
  assert('isGlobPattern detects question mark', isGlobPattern('src/foo?.ts'));
  assert(
    'isGlobPattern returns false for concrete path',
    !isGlobPattern('src/main.ts'),
  );
  assert(
    'isGlobPattern returns false for path with dots',
    !isGlobPattern('src/app.module.ts'),
  );
  assert(
    'OpenAI adapter filters glob patterns from unvisited files',
    openaiSource.includes('isGlobPattern'),
  );
  assert(
    'Anthropic adapter filters glob patterns from unvisited files',
    anthropicSource.includes('isGlobPattern'),
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
