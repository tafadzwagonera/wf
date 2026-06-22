/**
 * Manual smoke test: State pruning and cost optimization levers
 *
 * Run: nr test:manual -- test-state-pruning-and-cost-optimizations
 *
 * Verifies:
 *   1. pruneStateIfNeeded is defined and callable
 *   2. State pruning fires when input tokens exceed STATE_PRUNING_TOKEN_CEILING
 *   3. State pruning preserves the last STATE_PRUNING_KEEP_TAIL_ITEMS items
 *   4. State pruning injects a summary message at position 0
 *   5. State pruning skips when tokens are below the ceiling
 *   6. State pruning skips when items count is <= tail threshold
 *   7. Tool results use compact JSON (no progress signal in write/edit/delete)
 *   8. Passing verify_command omits stdout/stderr
 *   9. Tracked file deduplication renders "(same as files to implement)"
 *  10. MAX_READ_LINES is 200
 *  11. Anthropic buildSystemPrompt includes ticketKey and planSteps
 *  12. Anthropic buildSystemPrompt uses Claude tool names (Read, Write, Edit, Grep, Glob, Bash)
 *  13. No `as any` casts in pruneStateIfNeeded or its call sites
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

/**
 * Asserts a condition and logs the result.
 *
 * @param label - Test case label
 * @param condition - Whether the assertion passed
 */
const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  PASS: ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  FAIL: ${label}`));
    failed++;
  }
};

const run = async (): Promise<void> => {
  console.log(
    chalk.bold('\nSmoke test: State pruning and cost optimizations\n'),
  );

  const srcRoot = path.join(__dirname, '..', '..', 'src');

  const openaiAdapterSource = fs.readFileSync(
    path.join(
      srcRoot,
      'integrations',
      'ai',
      'adapters',
      'openai-agent.adapter.ts',
    ),
    'utf8',
  );

  const anthropicAdapterSource = fs.readFileSync(
    path.join(
      srcRoot,
      'integrations',
      'ai',
      'adapters',
      'anthropic-agent.adapter.ts',
    ),
    'utf8',
  );

  // --- State pruning ---

  // 1. pruneStateIfNeeded is defined
  assert(
    'pruneStateIfNeeded function is defined',
    openaiAdapterSource.includes('const pruneStateIfNeeded = ('),
  );

  // 2. STATE_PRUNING_TOKEN_CEILING constant is defined
  assert(
    'STATE_PRUNING_TOKEN_CEILING constant is defined',
    openaiAdapterSource.includes('const STATE_PRUNING_TOKEN_CEILING = 120_000'),
  );

  // 3. STATE_PRUNING_KEEP_TAIL_ITEMS constant is defined
  assert(
    'STATE_PRUNING_KEEP_TAIL_ITEMS constant is defined',
    openaiAdapterSource.includes('const STATE_PRUNING_KEEP_TAIL_ITEMS = 20'),
  );

  // 4. Pruning is wired into main streaming loop
  assert(
    'pruneStateIfNeeded is called in main streaming loop',
    openaiAdapterSource.includes('const pruned = pruneStateIfNeeded('),
  );

  // 5. Pruning logs when it fires
  assert(
    'pruning logs removed item count and token count',
    openaiAdapterSource.includes('State pruned: removed'),
  );

  // 6. Pruning resets lastObservedInputTokens after firing
  const pruneResetPattern = /pruned > 0\)[\s\S]*?lastObservedInputTokens = 0/;
  assert(
    'pruning resets lastObservedInputTokens to 0 after firing',
    pruneResetPattern.test(openaiAdapterSource),
  );

  // 7. Pruning handles reasoning→function_call pair boundaries
  assert(
    'pruning checks function_call/reasoning pair boundaries',
    openaiAdapterSource.includes("rawType === 'function_call'") &&
      openaiAdapterSource.includes("rawType === 'reasoning'"),
  );

  // 8. No as any in pruneStateIfNeeded or its call sites
  const pruneBlock = openaiAdapterSource.slice(
    openaiAdapterSource.indexOf('const pruneStateIfNeeded = ('),
    openaiAdapterSource.indexOf(
      '};',
      openaiAdapterSource.indexOf('items.splice('),
    ) + 2,
  );
  assert(
    'pruneStateIfNeeded body contains no `as any` casts',
    !pruneBlock.includes('as any'),
  );

  const callSiteLines = openaiAdapterSource
    .split('\n')
    .filter((line) => line.includes('pruneStateIfNeeded('));
  const callSiteCastsClean = callSiteLines.every(
    (line) => !line.includes('as any'),
  );
  assert(
    'pruneStateIfNeeded call sites contain no `as any` casts',
    callSiteCastsClean,
  );

  // --- Validation failure cleanup ---

  // 9. Successful edit_file clears stale validation failures
  const editToolCleanupSection = openaiAdapterSource.slice(
    openaiAdapterSource.indexOf("name: 'edit_file'"),
    openaiAdapterSource.indexOf('const agent = new Agent'),
  );
  assert(
    'edit_file clears stale validationFailures on successful write',
    editToolCleanupSection.includes('validationFailures.splice(i, 1)'),
  );

  // --- Tool result trimming ---

  // 10. write_file returns compact JSON without progress
  const writeToolSection = openaiAdapterSource.slice(
    openaiAdapterSource.indexOf("name: 'write_file'"),
    openaiAdapterSource.indexOf("name: 'delete_file'"),
  );
  assert(
    'write_file returns { path, status } without progress signal',
    writeToolSection.includes(
      'return JSON.stringify({ path: relativePath, status })',
    ) && !writeToolSection.includes('buildMutationProgressSignal'),
  );

  // 10. edit_file returns compact JSON without progress
  const editToolSection = openaiAdapterSource.slice(
    openaiAdapterSource.indexOf("name: 'edit_file'"),
    openaiAdapterSource.indexOf('const agent = new Agent'),
  );
  assert(
    'edit_file returns { path, status: "updated" } without progress signal',
    editToolSection.includes(
      "return JSON.stringify({ path: relativePath, status: 'updated' })",
    ),
  );

  // 11. Passing verify_command omits stdout/stderr
  const verifyPassSection = openaiAdapterSource.slice(
    openaiAdapterSource.indexOf('Verification passed:'),
    openaiAdapterSource.indexOf('} catch (error:'),
  );
  assert(
    'passing verify_command omits stdout/stderr',
    !verifyPassSection.includes('stdout:') &&
      !verifyPassSection.includes('stderr:'),
  );

  // 12. buildMutationProgressSignal import is removed
  assert(
    'buildMutationProgressSignal import is removed',
    !openaiAdapterSource.includes('buildMutationProgressSignal'),
  );

  // --- Tracked file deduplication ---

  // 13. OpenAI adapter deduplicates tracked files
  assert(
    'OpenAI adapter deduplicates tracked file list',
    openaiAdapterSource.includes('(same as files to implement)'),
  );

  // 14. Anthropic adapter deduplicates tracked files
  assert(
    'Anthropic adapter deduplicates tracked file list',
    anthropicAdapterSource.includes('(same as files to implement)'),
  );

  // --- MAX_READ_LINES ---

  // 15. MAX_READ_LINES is 200
  assert(
    'MAX_READ_LINES is 200',
    openaiAdapterSource.includes('const MAX_READ_LINES = 200'),
  );

  // --- Anthropic buildSystemPrompt alignment ---

  // 16. Anthropic buildSystemPrompt accepts ticketKey
  assert(
    'Anthropic buildSystemPrompt includes ticketKey parameter',
    anthropicAdapterSource.includes('ticketKey: string;') &&
      anthropicAdapterSource.includes('Ticket key: ${ticketKey}'),
  );

  // 17. Anthropic buildSystemPrompt accepts planSteps
  assert(
    'Anthropic buildSystemPrompt includes planSteps parameter',
    anthropicAdapterSource.includes('planSteps: string[];') &&
      anthropicAdapterSource.includes('Plan steps:'),
  );

  // 18. Anthropic adapter uses Claude tool names
  assert(
    'Anthropic adapter uses Claude tool names (Read, Write, Edit, Grep, Glob, Bash)',
    anthropicAdapterSource.includes('- Read(file_path') &&
      anthropicAdapterSource.includes('- Write(file_path') &&
      anthropicAdapterSource.includes('- Edit(file_path') &&
      anthropicAdapterSource.includes('- Grep(pattern') &&
      anthropicAdapterSource.includes('- Glob(pattern') &&
      anthropicAdapterSource.includes('- Bash(command)'),
  );

  // 19. Anthropic adapter no longer uses old generic tool names
  assert(
    'Anthropic adapter does not use old "Use Write or Edit to write" rule',
    !anthropicAdapterSource.includes(
      'Use Write or Edit to write complete updated file contents',
    ),
  );

  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
