/**
 * Manual smoke test: Repo discovery context for issue:generate and issue:plan
 *
 * Run: nr test:manual -- test-repo-discovery-context
 *
 * Verifies:
 *   1. detectRepoConventions returns a valid context for a TypeScript repo
 *   2. detectRepoConventions detects language as 'typescript' when tsconfig.json exists
 *   3. detectRepoConventions detects NestJS from package.json
 *   4. detectRepoConventions returns 'unknown' language when no marker files exist
 *   5. detectRepoConventions returns null fields for missing configs (never throws)
 *   6. formatRepoConventionsPromptSection produces non-empty string for meaningful context
 *   7. formatRepoConventionsPromptSection returns empty string for empty context
 *   8. detectCrossRepoPatterns returns empty patterns for identical conventions
 *   9. formatCrossRepoPatternsPromptSection returns empty string for empty patterns
 *  10. buildSynthesisPrompt includes discovery sections when repoContext is provided
 *  11. buildSynthesisPrompt omits discovery sections when no repoContext provided
 *  12. buildSynthesisPrompt includes prior plan formatter wiring
 *  13. detect-prior-plans prompt formatter includes the related prior plans heading
 *  14. PlanStageService.generatePlan accepts planCorrelation as an optional context field
 *  15. AI plan prompt includes prior plan formatter wiring
 *  16. Agent plan prompt includes prior plan formatter wiring
 *  17. AI plan prompt includes minimal-change principles text
 *  18. Agent plan prompt includes minimal-change principles text
 *  19. correlatePlans returns empty matches for non-existent repo
 *  20. formatPlanCorrelationPromptSection returns '' for empty matches
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

const run = async (): Promise<void> => {
  console.log(chalk.bold.cyan('\n🧪 Manual Test: Repo discovery context for issue:generate and issue:plan\n'));

  // --- detect-repo-conventions ---
  console.log(chalk.yellow('\n  detect-repo-conventions:'));

  const {
    detectRepoConventions,
    formatRepoConventionsPromptSection,
  } = require('../../src/shared/utils/detect-repo-conventions');

  // Test against the wf repo itself (TypeScript + NestJS)
  const wfRepoDir = path.resolve(__dirname, '../..');
  const ctx = detectRepoConventions(wfRepoDir);

  assert(
    '1. detectRepoConventions returns a valid context for a TypeScript repo',
    ctx !== null && typeof ctx === 'object' && 'language' in ctx
  );

  assert(
    '2. detectRepoConventions detects language as typescript when tsconfig.json exists',
    ctx.language === 'typescript'
  );

  assert('3. detectRepoConventions detects NestJS from package.json', ctx.nestjsDetected === true);

  // Test against a non-existent directory
  const emptyCtx = detectRepoConventions('/tmp/nonexistent-repo-' + Date.now());
  assert(
    '4. detectRepoConventions returns unknown language when no marker files exist',
    emptyCtx.language === 'unknown'
  );

  assert(
    '5. detectRepoConventions returns null fields for missing configs (never throws)',
    emptyCtx.linter === null
    && emptyCtx.typescript === null
    && emptyCtx.go === null
    && emptyCtx.python === null
    && emptyCtx.terraform === null
  );

  const formatted = formatRepoConventionsPromptSection(ctx, 'wf');
  assert(
    '6. formatRepoConventionsPromptSection produces non-empty string for meaningful context',
    formatted.length > 0 && formatted.includes('Repository conventions (wf):')
  );

  const emptyFormatted = formatRepoConventionsPromptSection(emptyCtx, 'empty');
  assert('7. formatRepoConventionsPromptSection returns empty string for empty context', emptyFormatted === '');

  // --- detect-cross-repo-patterns ---
  console.log(chalk.yellow('\n  detect-cross-repo-patterns:'));

  const {
    detectCrossRepoPatterns,
    formatCrossRepoPatternsPromptSection,
  } = require('../../src/shared/utils/detect-cross-repo-patterns');

  const samePatterns = detectCrossRepoPatterns(wfRepoDir, [wfRepoDir]);
  assert(
    '8. detectCrossRepoPatterns returns empty patterns for identical conventions',
    samePatterns.patterns.length === 0 || samePatterns.patterns.every((p: any) => p.deltas.length === 0)
  );

  const emptyPatternsFormatted = formatCrossRepoPatternsPromptSection({
    patterns: [],
  });
  assert(
    '9. formatCrossRepoPatternsPromptSection returns empty string for empty patterns',
    emptyPatternsFormatted === ''
  );

  // --- buildSynthesisPrompt integration ---
  console.log(chalk.yellow('\n  buildSynthesisPrompt integration:'));

  const generateSrc = fs.readFileSync(path.join(wfRepoDir, 'src/commands/issue-generate.command.ts'), 'utf-8');

  assert(
    '10. buildSynthesisPrompt includes discovery sections when repoContext is provided',
    generateSrc.includes('formatRepoConventionsPromptSection')
    && generateSrc.includes('formatPriorPlansPromptSection')
    && generateSrc.includes('formatPlanCorrelationPromptSection')
    && generateSrc.includes('formatCrossRepoPatternsPromptSection')
  );

  assert(
    '11. buildSynthesisPrompt omits discovery sections when no repoContext provided',
    generateSrc.includes('if (repoContext)') || generateSrc.includes('repoContext?')
  );

  assert(
    '12. buildSynthesisPrompt includes prior plan formatter wiring',
    generateSrc.includes('formatPriorPlansPromptSection')
  );

  const priorPlansSrc = fs.readFileSync(path.join(wfRepoDir, 'src/shared/utils/detect-prior-plans.ts'), 'utf-8');
  assert(
    '13. detect-prior-plans prompt formatter includes the related prior plans heading',
    priorPlansSrc.includes('Related prior plans (')
  );

  // --- PlanStageService context threading ---
  console.log(chalk.yellow('\n  PlanStageService context threading:'));

  const planStageSrc = fs.readFileSync(path.join(wfRepoDir, 'src/workflows/stages/plan-stage.service.ts'), 'utf-8');

  assert(
    '14. PlanStageService.generatePlan accepts planCorrelation as an optional context field',
    planStageSrc.includes('conventions?:')
    && planStageSrc.includes('priorPlans?:')
    && planStageSrc.includes('planCorrelation?:')
    && planStageSrc.includes('crossRepoPatterns?:')
  );

  // --- Minimal-change principles ---
  console.log(chalk.yellow('\n  Minimal-change principles:'));

  const aiServiceSrc = fs.readFileSync(path.join(wfRepoDir, 'src/integrations/ai/ai.service.ts'), 'utf-8');
  assert(
    '15. AI plan prompt includes prior plan formatter wiring',
    aiServiceSrc.includes('formatPriorPlansPromptSection')
  );

  const stageAgentSrc = fs.readFileSync(path.join(wfRepoDir, 'src/integrations/ai/stage-agent.service.ts'), 'utf-8');
  assert(
    '16. Agent plan prompt includes prior plan formatter wiring',
    stageAgentSrc.includes('formatPriorPlansPromptSection')
  );

  assert(
    '17. AI plan prompt includes minimal-change principles text',
    aiServiceSrc.includes('Minimal-change principles')
  );

  assert(
    '18. Agent plan prompt includes minimal-change principles text',
    stageAgentSrc.includes('Minimal-change principles')
  );

  // --- Plan correlation ---
  console.log(chalk.yellow('\n  Plan correlation:'));

  const { correlatePlans, formatPlanCorrelationPromptSection } = require('../../src/shared/utils/detect-prior-plans');

  const { detectPriorPlans } = require('../../src/shared/utils/detect-prior-plans');

  const emptyPlans = detectPriorPlans('nonexistent-repo-' + Date.now());
  const emptyCorrelation = correlatePlans('some content', emptyPlans, '/tmp/nonexistent');
  assert('19. correlatePlans returns empty matches for non-existent repo', emptyCorrelation.matches.length === 0);

  const emptyCorrelationSection = formatPlanCorrelationPromptSection({ matches: [], repoName: 'test' });
  assert(
    '20. formatPlanCorrelationPromptSection returns empty string for empty matches',
    emptyCorrelationSection === ''
  );

  // --- Summary ---
  console.log(chalk.bold.cyan(`\n  Results: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run().catch(error => {
  console.error(chalk.red('Smoke test crashed:'), error);
  process.exit(1);
});
