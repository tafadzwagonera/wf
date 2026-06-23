/**
 * Manual smoke test: Model routing and mechanical task detection
 *
 * Run: nr test:manual -- test-model-routing
 *
 * Verifies:
 *   1. detectMechanicalTask detects step language patterns (OpenAI).
 *   2. detectMechanicalTask detects high file-to-step ratio (OpenAI).
 *   3. detectMechanicalTask detects low complexity + many files (OpenAI).
 *   4. detectMechanicalTask returns creative for focused plans (OpenAI).
 *   5. detectMechanicalTask detects step language patterns (Anthropic).
 *   6. detectMechanicalTask detects high file-to-step ratio (Anthropic).
 *   7. detectMechanicalTask returns creative for focused plans (Anthropic).
 *   8. ModelRouting type accepts valid values.
 *   9. ImplementerOptions accepts modelRouting field.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { detectMechanicalTask } from '../../src/integrations/ai/adapters/shared-routing';
const openAiDetect = detectMechanicalTask;
const anthropicDetect = detectMechanicalTask;
import type { ModelRouting, ImplementerOptions } from '../../src/agents/interfaces';

let passed = 0;
let failed = 0;

/**
 * Record a passing assertion.
 *
 * @param message Human-readable assertion label
 * @returns Void
 */
const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

/**
 * Record a failing assertion.
 *
 * @param message Human-readable assertion label
 * @param detail Optional failure detail
 * @returns Void
 */
const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

/**
 * Assert a boolean condition and record the result.
 *
 * @param message Human-readable assertion label
 * @param condition Assertion condition
 * @param detail Optional failure detail
 * @returns Void
 */
const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }

  fail(message, detail);
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 Model routing and mechanical task detection smoke test\n'));

  // ── OpenAI detectMechanicalTask ──────────────────────────────────────
  console.log(chalk.bold('Test 1: OpenAI — step language pattern'));
  const openAi1 = openAiDetect({
    action: 'fix',
    summary: 'Migrate all loggers',
    steps: ['Migrate all Logger instances to PinoLogger'],
    estimatedComplexity: 'low',
    filesAffected: ['src/a.ts', 'src/b.ts'],
  });
  assert(
    'detects "migrate all" pattern',
    openAi1.isMechanical === true,
    `isMechanical=${openAi1.isMechanical}, reason=${openAi1.reason}`
  );
  assert('reason contains "pattern"', openAi1.reason.includes('pattern'), openAi1.reason);

  console.log(chalk.bold('\nTest 2: OpenAI — high file-to-step ratio'));
  const openAi2 = openAiDetect({
    action: 'fix',
    summary: 'Update imports',
    steps: ['Update imports'],
    estimatedComplexity: 'medium',
    filesAffected: Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`),
  });
  assert(
    'detects high file-to-step ratio (15 files / 1 step)',
    openAi2.isMechanical === true,
    `isMechanical=${openAi2.isMechanical}, reason=${openAi2.reason}`
  );
  assert('reason contains "file-to-step"', openAi2.reason.includes('file-to-step'), openAi2.reason);

  console.log(chalk.bold('\nTest 3: OpenAI — low complexity + many files'));
  const openAi3 = openAiDetect({
    action: 'fix',
    summary: 'Rename function',
    steps: ['Rename foo to bar everywhere'],
    estimatedComplexity: 'low',
    filesAffected: Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`),
  });
  assert(
    'detects low complexity with 25 files',
    openAi3.isMechanical === true,
    `isMechanical=${openAi3.isMechanical}, reason=${openAi3.reason}`
  );

  console.log(chalk.bold('\nTest 4: OpenAI — creative task'));
  const openAi4 = openAiDetect({
    action: 'feature',
    summary: 'Add auth module',
    steps: ['Design schema', 'Implement middleware', 'Add tests'],
    estimatedComplexity: 'high',
    filesAffected: ['src/auth.ts', 'src/auth.spec.ts'],
  });
  assert(
    'returns creative for small focused plan',
    openAi4.isMechanical === false,
    `isMechanical=${openAi4.isMechanical}`
  );
  assert('reason is "creative task"', openAi4.reason === 'creative task');

  // ── Anthropic detectMechanicalTask ───────────────────────────────────
  console.log(chalk.bold('\nTest 5: Anthropic — step language pattern'));
  const anthropic1 = anthropicDetect({
    action: 'fix',
    summary: 'Replace every old import',
    steps: ['Replace every OldLogger with NewLogger'],
    estimatedComplexity: 'low',
    filesAffected: ['src/a.ts'],
  });
  assert(
    'detects "replace every" pattern',
    anthropic1.isMechanical === true,
    `isMechanical=${anthropic1.isMechanical}, reason=${anthropic1.reason}`
  );

  console.log(chalk.bold('\nTest 6: Anthropic — high file-to-step ratio'));
  const anthropic2 = anthropicDetect({
    action: 'fix',
    summary: 'Update config',
    steps: ['Update config'],
    estimatedComplexity: 'medium',
    filesAffected: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`),
  });
  assert(
    'detects high file-to-step ratio (12 files / 1 step)',
    anthropic2.isMechanical === true,
    `isMechanical=${anthropic2.isMechanical}, reason=${anthropic2.reason}`
  );

  console.log(chalk.bold('\nTest 7: Anthropic — creative task'));
  const anthropic3 = anthropicDetect({
    action: 'feature',
    summary: 'Build dashboard',
    steps: ['Design UI', 'Implement API', 'Write tests'],
    estimatedComplexity: 'high',
    filesAffected: ['src/dashboard.ts'],
  });
  assert('returns creative for focused plan', anthropic3.isMechanical === false);

  // ── Type-level checks ────────────────────────────────────────────────
  console.log(chalk.bold('\nTest 8: ModelRouting type values'));
  const validValues: ModelRouting[] = ['auto', 'default', 'mechanical'];
  assert(
    'ModelRouting accepts auto, default, mechanical',
    validValues.length === 3 &&
      validValues.includes('auto') &&
      validValues.includes('default') &&
      validValues.includes('mechanical')
  );

  console.log(chalk.bold('\nTest 9: ImplementerOptions.modelRouting'));
  const opts: ImplementerOptions = {
    trackerName: 'jira',
    modelRouting: 'mechanical',
  };
  assert('ImplementerOptions accepts modelRouting field', opts.modelRouting === 'mechanical');
  const optsNoRouting: ImplementerOptions = { trackerName: 'jira' };
  assert('ImplementerOptions allows undefined modelRouting', optsNoRouting.modelRouting === undefined);

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
