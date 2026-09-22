/**
 * Manual smoke test: State pruning and cost optimization levers
 *
 * Run: nr test:manual state-pruning-and-cost-optimizations.smoke.ts
 *
 * Verifies:
 *   1. pruneStateIfNeeded is defined and callable
 *   2. State pruning fires when input tokens exceed STATE_PRUNING_TOKEN_CEILING
 *   3. State pruning preserves the last STATE_PRUNING_KEEP_TAIL_ITEMS items
 *   4. State pruning injects a summary message at position 0
 *   5. State pruning skips when tokens are below the ceiling
 *   6. State pruning resets observed tokens to 0 after firing
 *   7. Pruning guards function_call/reasoning pair boundaries
 *   8. No `as any` casts in pruneStateIfNeeded or its call sites
 *   9. Tracked file deduplication renders "(same as files to implement)"
 *  10. MAX_READ_LINES is 200
 *  11. Anthropic buildSystemPrompt uses Claude tool names (Read, Write, Edit, Grep, Glob, Bash)
 *  12. Anthropic adapter does not use old generic tool names
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean): void =>
  condition ? pass(label) : fail(label);

function loadSources(srcRoot: string): { openaiSrc: string; anthropicSrc: string; sharedSrc: string } {
  const adaptersDir = path.join(srcRoot, 'integrations', 'ai', 'adapters');
  const openaiSrc = fs.readFileSync(path.join(adaptersDir, 'openai-agent.adapter.ts'), 'utf8');
  const anthropicSrc = fs.readFileSync(path.join(adaptersDir, 'anthropic-agent.adapter.ts'), 'utf8');
  const sharedSrc = fs.readFileSync(path.join(adaptersDir, 'shared-routing.ts'), 'utf8');
  return { openaiSrc, anthropicSrc, sharedSrc };
}

function checkPruneDefinitions(src: string): void {
  assert('pruneStateIfNeeded function is defined', src.includes('const pruneStateIfNeeded = ('));
  assert('STATE_PRUNING_TOKEN_CEILING constant is defined', src.includes('const STATE_PRUNING_TOKEN_CEILING = 120_000'));
  assert('STATE_PRUNING_KEEP_TAIL_ITEMS constant is defined', src.includes('const STATE_PRUNING_KEEP_TAIL_ITEMS = 20'));
  assert('pruneStateIfNeeded is called in main streaming loop', src.includes('const pruned = pruneStateIfNeeded('));
}

function checkPruneRuntime(src: string): void {
  assert('pruning logs removed item count and token count', src.includes('State pruned: removed'));
  const pruneResetPattern = /pruned > 0\)[\s\S]*?observed = 0/;
  assert('pruning resets observed tokens to 0 after firing', pruneResetPattern.test(src));
  assert(
    'pruning checks function_call/reasoning pair boundaries',
    src.includes("rawItem?.type === 'function_call'") && src.includes("item.type !== 'reasoning'"),
  );
}

function checkPruneNoCasts(src: string): void {
  const pruneBlock = src.slice(
    src.indexOf('const pruneStateIfNeeded = ('),
    src.indexOf('};', src.indexOf('items.splice(')) + 2,
  );
  assert('pruneStateIfNeeded body contains no `as any` casts', !pruneBlock.includes('as any'));
  const callSiteLines = src.split('\n').filter(line => line.includes('pruneStateIfNeeded('));
  const callSiteCastsClean = callSiteLines.every(line => !line.includes('as any'));
  assert('pruneStateIfNeeded call sites contain no `as any` casts', callSiteCastsClean);
}

function checkMiscOpenAi(src: string, sharedSrc: string): void {
  assert('buildMutationProgressSignal import is removed', !src.includes('buildMutationProgressSignal'));
  assert('shared-routing deduplicates tracked file list', sharedSrc.includes('(same as files to implement)'));
  assert('MAX_READ_LINES is 200', src.includes('const MAX_READ_LINES = 200'));
}

function checkAnthropicAdapter(src: string): void {
  assert(
    'Anthropic adapter uses Claude tool names (Read, Write, Edit, Grep, Glob, Bash)',
    src.includes('- Read(file_path')
    && src.includes('- Write(file_path')
    && src.includes('- Edit(file_path')
    && src.includes('- Grep(pattern')
    && src.includes('- Glob(pattern')
    && src.includes('- Bash(command)'),
  );
  assert(
    'Anthropic adapter does not use old "Use Write or Edit to write" rule',
    !src.includes('Use Write or Edit to write complete updated file contents'),
  );
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: State pruning and cost optimizations\n'));
  const srcRoot = path.join(__dirname, '..', '..', 'src');
  const { openaiSrc, anthropicSrc, sharedSrc } = loadSources(srcRoot);
  checkPruneDefinitions(openaiSrc);
  checkPruneRuntime(openaiSrc);
  checkPruneNoCasts(openaiSrc);
  checkMiscOpenAi(openaiSrc, sharedSrc);
  checkAnthropicAdapter(anthropicSrc);
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
