/**
 * Manual smoke test: Enhanced mechanical task detection
 *
 * Run: nr test:manual -- test-enhanced-mechanical-detection
 *
 * Verifies the six-step detection cascade:
 *   1. Low estimatedComplexity routes mechanical immediately.
 *   2. High estimatedComplexity routes creative immediately.
 *   3. High file-to-step ratio (>3) signals mechanical.
 *   4. Keyword patterns signal mechanical (expanded list).
 *   5. Semantic signals: mechanical wins only when count exceeds creative.
 *   6. Fallback is creative.
 *
 * Also verifies:
 *   - New keyword patterns (find-and-replace, bulk update, etc.)
 *   - Semantic tie falls through to creative.
 *   - Incidental "repeat" does not false-positive.
 *   - High complexity overrides mechanical keywords.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { detectMechanicalTask } from '../../src/integrations/ai/adapters/shared-routing';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }

  fail(message, detail);
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 Enhanced mechanical task detection smoke test\n'));

  // ── Step 1: Low complexity → mechanical immediately ──────────────────
  console.log(chalk.bold('Step 1: Low complexity short-circuit'));

  const lowNoFiles = detectMechanicalTask({
    action: 'fix',
    summary: 'Trivial config tweak',
    steps: ['Change one value'],
    estimatedComplexity: 'low',
    affectedFiles: [],
  });
  assert('low complexity with 0 files is mechanical', lowNoFiles.isMechanical === true);
  assert('reason mentions low complexity', lowNoFiles.reason.includes('low complexity'), lowNoFiles.reason);

  const lowFewFiles = detectMechanicalTask({
    action: 'fix',
    summary: 'Small rename',
    steps: ['Rename variable'],
    estimatedComplexity: 'low',
    affectedFiles: ['src/a.ts', 'src/b.ts'],
  });
  assert('low complexity with 2 files is mechanical', lowFewFiles.isMechanical === true);

  // ── Step 2: High complexity → creative immediately ───────────────────
  console.log(chalk.bold('\nStep 2: High complexity short-circuit'));

  const highWithMechanicalKeyword = detectMechanicalTask({
    action: 'feature',
    summary: 'Migrate all services to new architecture',
    steps: ['Migrate all services', 'Replace every config pattern'],
    estimatedComplexity: 'high',
    affectedFiles: Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`),
  });
  assert(
    'high complexity overrides mechanical keywords and high file count',
    highWithMechanicalKeyword.isMechanical === false,
    `isMechanical=${highWithMechanicalKeyword.isMechanical}`
  );
  assert(
    'reason is "high complexity task"',
    highWithMechanicalKeyword.reason === 'high complexity task',
    highWithMechanicalKeyword.reason
  );

  // ── Step 3: File-to-step ratio ───────────────────────────────────────
  console.log(chalk.bold('\nStep 3: File-to-step ratio'));

  const highRatio = detectMechanicalTask({
    action: 'fix',
    summary: 'Update imports',
    steps: ['Update the import path'],
    estimatedComplexity: 'medium',
    affectedFiles: Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`),
  });
  assert('10 files / 1 step is mechanical', highRatio.isMechanical === true);
  assert('reason mentions file-to-step', highRatio.reason.includes('file-to-step'), highRatio.reason);

  const lowRatio = detectMechanicalTask({
    action: 'fix',
    summary: 'Update imports',
    steps: ['Step 1', 'Step 2', 'Step 3'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  });
  assert('3 files / 3 steps (ratio=1) is not caught by ratio check', lowRatio.reason !== 'high file-to-step ratio');

  // ── Step 4: Expanded keyword patterns ────────────────────────────────
  console.log(chalk.bold('\nStep 4: Keyword patterns'));

  const findReplace = detectMechanicalTask({
    action: 'fix',
    summary: 'Find and replace old API',
    steps: ['Find and replace the deprecated endpoint across all files'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/a.ts'],
  });
  assert('find-and-replace pattern detected', findReplace.isMechanical === true);
  assert('reason contains "pattern"', findReplace.reason.includes('pattern'), findReplace.reason);

  const bulkUpdate = detectMechanicalTask({
    action: 'fix',
    summary: 'Bulk update configs',
    steps: ['Bulk update all configuration files'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/a.ts'],
  });
  assert('bulk update pattern detected', bulkUpdate.isMechanical === true);

  const batchRename = detectMechanicalTask({
    action: 'fix',
    summary: 'Batch rename',
    steps: ['Batch rename all exported symbols'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/a.ts'],
  });
  assert('batch rename pattern detected', batchRename.isMechanical === true);

  const removeFromAll = detectMechanicalTask({
    action: 'fix',
    summary: 'Cleanup',
    steps: ['Remove the deprecated flag from all modules'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/a.ts'],
  });
  assert('remove-from-all pattern detected', removeFromAll.isMechanical === true);

  const applyAcross = detectMechanicalTask({
    action: 'fix',
    summary: 'Apply fix',
    steps: ['Apply the patch across all services'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/a.ts'],
  });
  assert('apply-across pattern detected', applyAcross.isMechanical === true);

  // ── Step 5: Semantic signals ─────────────────────────────────────────
  console.log(chalk.bold('\nStep 5: Semantic signals'));

  const mechanicalSemantic = detectMechanicalTask({
    action: 'fix',
    summary: 'Standardize format',
    steps: ['Standardize the naming convention', 'Apply the same approach in each module'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/a.ts', 'src/b.ts'],
  });
  assert('semantic mechanical signals win (2 vs 0)', mechanicalSemantic.isMechanical === true);
  assert('reason mentions semantic', mechanicalSemantic.reason.includes('semantic'), mechanicalSemantic.reason);

  const semanticTie = detectMechanicalTask({
    action: 'feature',
    summary: 'Normalize and refactor',
    steps: ['Normalize the config format', 'Refactor the parser module'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/config.ts', 'src/parser.ts'],
  });
  assert('semantic tie (1 vs 1) falls through to creative', semanticTie.isMechanical === false);
  assert('reason is "creative task"', semanticTie.reason === 'creative task', semanticTie.reason);

  const creativeWins = detectMechanicalTask({
    action: 'feature',
    summary: 'Design and investigate',
    steps: ['Design the architecture', 'Investigate the root cause', 'Research alternatives'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/a.ts'],
  });
  assert('creative signals dominate (0 vs 3)', creativeWins.isMechanical === false);

  // ── Step 6: Fallback creative ────────────────────────────────────────
  console.log(chalk.bold('\nStep 6: Fallback creative'));

  const neutralPlan = detectMechanicalTask({
    action: 'fix',
    summary: 'Fix the widget',
    steps: ['Update the handler', 'Adjust the response'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/handler.ts'],
  });
  assert('neutral plan falls through to creative', neutralPlan.isMechanical === false);
  assert('reason is "creative task"', neutralPlan.reason === 'creative task', neutralPlan.reason);

  // ── False-positive protection ────────────────────────────────────────
  console.log(chalk.bold('\nFalse-positive protection'));

  const incidentalRepeat = detectMechanicalTask({
    action: 'fix',
    summary: 'Prevent repeat failures',
    steps: ['Do not repeat this mistake in production'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/handler.ts'],
  });
  assert(
    'incidental "repeat" without directional context is not mechanical',
    incidentalRepeat.isMechanical === false,
    `isMechanical=${incidentalRepeat.isMechanical}, reason=${incidentalRepeat.reason}`
  );

  const repeatAcross = detectMechanicalTask({
    action: 'fix',
    summary: 'Apply fix',
    steps: ['Repeat the same fix across all modules'],
    estimatedComplexity: 'medium',
    affectedFiles: ['src/a.ts'],
  });
  assert(
    '"repeat across" with directional context IS mechanical',
    repeatAcross.isMechanical === true,
    `isMechanical=${repeatAcross.isMechanical}, reason=${repeatAcross.reason}`
  );

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
