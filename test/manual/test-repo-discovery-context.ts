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
 *   8. detectPriorTickets returns empty tickets when repo directory does not exist
 *   9. extractTicketKeywords extracts file paths with multi-dot names
 *  10. extractTicketKeywords extracts PascalCase component names
 *  11. extractTicketKeywords extracts error patterns
 *  12. filterRecurrenceCandidates returns empty array when no keyword overlap
 *  13. filterRecurrenceCandidates returns candidates above 0.2 Jaccard threshold
 *  14. detectCrossRepoPatterns returns empty patterns for identical conventions
 *  15. formatCrossRepoPatternsPromptSection returns empty string for empty patterns
 *  16. buildSynthesisPrompt includes discovery sections when repoContext is provided
 *  17. buildSynthesisPrompt omits discovery sections when no repoContext provided
 *  18. PlanStageService.generatePlan accepts new optional context fields without error
 *  19. AI plan prompt includes minimal-change principles text
 *  20. Agent plan prompt includes minimal-change principles text
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
  console.log(
    chalk.bold.cyan(
      '\n🧪 Manual Test: Repo discovery context for issue:generate and issue:plan\n',
    ),
  );

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
    ctx !== null && typeof ctx === 'object' && 'language' in ctx,
  );

  assert(
    '2. detectRepoConventions detects language as typescript when tsconfig.json exists',
    ctx.language === 'typescript',
  );

  assert(
    '3. detectRepoConventions detects NestJS from package.json',
    ctx.nestjsDetected === true,
  );

  // Test against a non-existent directory
  const emptyCtx = detectRepoConventions('/tmp/nonexistent-repo-' + Date.now());
  assert(
    '4. detectRepoConventions returns unknown language when no marker files exist',
    emptyCtx.language === 'unknown',
  );

  assert(
    '5. detectRepoConventions returns null fields for missing configs (never throws)',
    emptyCtx.linter === null &&
      emptyCtx.typescript === null &&
      emptyCtx.go === null &&
      emptyCtx.python === null &&
      emptyCtx.terraform === null,
  );

  const formatted = formatRepoConventionsPromptSection(ctx, 'wf');
  assert(
    '6. formatRepoConventionsPromptSection produces non-empty string for meaningful context',
    formatted.length > 0 && formatted.includes('Repository conventions (wf):'),
  );

  const emptyFormatted = formatRepoConventionsPromptSection(emptyCtx, 'empty');
  assert(
    '7. formatRepoConventionsPromptSection returns empty string for empty context',
    emptyFormatted === '',
  );

  // --- detect-prior-tickets ---
  console.log(chalk.yellow('\n  detect-prior-tickets:'));

  const {
    detectPriorTickets,
    extractTicketKeywords,
  } = require('../../src/shared/utils/detect-prior-tickets');

  const priorTickets = detectPriorTickets('nonexistent-repo-' + Date.now());
  assert(
    '8. detectPriorTickets returns empty tickets when repo directory does not exist',
    priorTickets.tickets.length === 0,
  );

  const keywords = extractTicketKeywords(
    'Fix PricingService timeout',
    'Error in src/pricing/pricing.service.ts causing ECONNREFUSED',
  );
  assert(
    '9. extractTicketKeywords extracts file paths with multi-dot names',
    keywords.some((k) => k.includes('pricing.service.ts')),
  );
  assert(
    '10. extractTicketKeywords extracts PascalCase component names',
    keywords.includes('PricingService'),
  );
  assert(
    '11. extractTicketKeywords extracts error patterns',
    keywords.some((k) => k.toLowerCase() === 'econnrefused') &&
      keywords.some((k) => k.toLowerCase() === 'timeout'),
  );

  // --- detect-recurrence-gaps ---
  console.log(chalk.yellow('\n  detect-recurrence-gaps:'));

  const {
    filterRecurrenceCandidates,
  } = require('../../src/shared/utils/detect-recurrence-gaps');

  const noOverlapCandidates = filterRecurrenceCandidates(
    '# Update README\n\nJust a documentation change',
    {
      tickets: [
        {
          title: 'Fix pricing bug',
          summary: 'ECONNREFUSED in payment flow',
          filename: 'WBP-123.md',
          keywords: ['ECONNREFUSED', 'PricingService'],
        },
      ],
      repoName: 'test',
    },
  );
  assert(
    '12. filterRecurrenceCandidates returns empty array when no keyword overlap',
    noOverlapCandidates.length === 0,
  );

  const overlapCandidates = filterRecurrenceCandidates(
    '# Fix PricingService ECONNREFUSED\n\nTimeout in src/pricing/pricing.service.ts',
    {
      tickets: [
        {
          title: 'Fix pricing timeout',
          summary:
            'ECONNREFUSED in PricingService at src/pricing/pricing.service.ts',
          filename: 'WBP-123.md',
          keywords: [
            'ECONNREFUSED',
            'PricingService',
            'src/pricing/pricing.service.ts',
            'timeout',
          ],
        },
      ],
      repoName: 'test',
    },
  );
  assert(
    '13. filterRecurrenceCandidates returns candidates above 0.2 Jaccard threshold',
    overlapCandidates.length > 0 && overlapCandidates[0].overlapScore >= 0.2,
  );

  // --- detect-cross-repo-patterns ---
  console.log(chalk.yellow('\n  detect-cross-repo-patterns:'));

  const {
    detectCrossRepoPatterns,
    formatCrossRepoPatternsPromptSection,
  } = require('../../src/shared/utils/detect-cross-repo-patterns');

  const samePatterns = detectCrossRepoPatterns(wfRepoDir, [wfRepoDir]);
  assert(
    '14. detectCrossRepoPatterns returns empty patterns for identical conventions',
    samePatterns.patterns.length === 0 ||
      samePatterns.patterns.every((p) => p.deltas.length === 0),
  );

  const emptyPatternsFormatted = formatCrossRepoPatternsPromptSection({
    patterns: [],
  });
  assert(
    '15. formatCrossRepoPatternsPromptSection returns empty string for empty patterns',
    emptyPatternsFormatted === '',
  );

  // --- buildSynthesisPrompt integration ---
  console.log(chalk.yellow('\n  buildSynthesisPrompt integration:'));

  const generateSrc = fs.readFileSync(
    path.join(wfRepoDir, 'src/commands/issue-generate.command.ts'),
    'utf-8',
  );

  assert(
    '16. buildSynthesisPrompt includes discovery sections when repoContext is provided',
    generateSrc.includes('formatRepoConventionsPromptSection') &&
      generateSrc.includes('formatPriorTicketsPromptSection') &&
      generateSrc.includes('formatCrossRepoPatternsPromptSection') &&
      generateSrc.includes('formatRecurrenceGapsPromptSection'),
  );

  assert(
    '17. buildSynthesisPrompt omits discovery sections when no repoContext provided',
    generateSrc.includes('if (repoContext)') ||
      generateSrc.includes('repoContext?'),
  );

  // --- PlanStageService context threading ---
  console.log(chalk.yellow('\n  PlanStageService context threading:'));

  const planStageSrc = fs.readFileSync(
    path.join(wfRepoDir, 'src/workflows/stages/plan-stage.service.ts'),
    'utf-8',
  );

  assert(
    '18. PlanStageService.generatePlan accepts new optional context fields',
    planStageSrc.includes('conventions?:') &&
      planStageSrc.includes('priorTickets?:') &&
      planStageSrc.includes('crossRepoPatterns?:') &&
      planStageSrc.includes('recurrenceGaps?:'),
  );

  // --- Minimal-change principles ---
  console.log(chalk.yellow('\n  Minimal-change principles:'));

  const aiServiceSrc = fs.readFileSync(
    path.join(wfRepoDir, 'src/integrations/ai/ai.service.ts'),
    'utf-8',
  );
  assert(
    '19. AI plan prompt includes minimal-change principles text',
    aiServiceSrc.includes('Minimal-change principles'),
  );

  const stageAgentSrc = fs.readFileSync(
    path.join(wfRepoDir, 'src/integrations/ai/stage-agent.service.ts'),
    'utf-8',
  );
  assert(
    '20. Agent plan prompt includes minimal-change principles text',
    stageAgentSrc.includes('Minimal-change principles'),
  );

  // --- Summary ---
  console.log(
    chalk.bold.cyan(`\n  Results: ${passed} passed, ${failed} failed\n`),
  );

  if (failed > 0) {
    process.exit(1);
  }
};

run().catch((error) => {
  console.error(chalk.red('Smoke test crashed:'), error);
  process.exit(1);
});
