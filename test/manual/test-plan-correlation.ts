/**
 * Manual smoke test: Plan correlation (Jaccard keyword matching + source reading)
 *
 * Run: nr test:manual -- test-plan-correlation
 *
 * Verifies:
 *   1. correlatePlans returns empty matches when prior plans have no keyword overlap
 *   2. correlatePlans returns keyword-matched results above Jaccard threshold
 *   3. correlatePlans reads source files from repoDir for matched plans
 *   4. correlatePlans skips missing source files without throwing
 *   5. correlatePlans respects maxTotalChars budget
 *   6. formatPlanCorrelationPromptSection formats keyword matches with overlap and shared keywords
 *   7. formatPlanCorrelationPromptSection returns empty string for zero matches
 *   8. correlatePlans is synchronous (no AI call on critical path)
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed += 1;
    return;
  }
  console.log(chalk.red(`  ✗ ${label}`));
  failed += 1;
};

const run = async (): Promise<void> => {
  console.log(chalk.bold.cyan('\n🧪 Manual Test: Plan correlation (Jaccard keyword matching + source reading)\n'));

  const { correlatePlans, formatPlanCorrelationPromptSection } = require('../../src/shared/utils/detect-prior-plans');

  // Set up a temporary repo with a source file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-corr-'));
  const srcDir = path.join(tmpDir, 'src', 'pricing');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, 'pricing.service.ts'),
    'export class PricingService {\n  getPrice() { return 42; }\n}'
  );

  // Set up a plan artifact on disk for detail loading
  const wfHomeDir = path.join(os.homedir(), '.wf');
  const repoName = `wf-corr-smoke-${Date.now()}`;
  const trackerDir = path.join(wfHomeDir, repoName, 'jira');
  const planPath = path.join(trackerDir, '2026-07-07-aaa111-fix-plan.json');
  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      action: 'fix',
      summary: 'Fix PricingService timeout',
      steps: ['Inspect PricingService', 'Patch timeout handling'],
      estimatedComplexity: 'medium',
      affectedFiles: ['src/pricing/pricing.service.ts', 'src/nonexistent/missing.ts'],
      risks: ['ECONNREFUSED can surface during spikes'],
    })
  );

  const priorPlans = {
    repoName,
    plans: [
      {
        title: 'Fix PricingService timeout',
        summary: 'Fix PricingService timeout',
        filename: '2026-07-07-aaa111-fix-plan.json',
        artifactPath: planPath,
        keywords: ['PricingService', 'timeout', 'src/pricing/pricing.service.ts', 'ECONNREFUSED'],
        steps: ['Inspect PricingService'],
        action: 'fix',
        estimatedComplexity: 'medium',
        ticketKey: null,
      },
    ],
  };

  // 1. No overlap
  const noOverlap = correlatePlans('# Update README\n\nJust documentation', priorPlans, tmpDir);
  assert(
    '1. correlatePlans returns empty matches when prior plans have no keyword overlap',
    noOverlap.matches.length === 0
  );

  // 2. Keyword overlap above threshold
  const withOverlap = correlatePlans(
    '# Fix PricingService ECONNREFUSED\n\nTimeout in src/pricing/pricing.service.ts causing PricingService failures',
    priorPlans,
    tmpDir
  );
  assert(
    '2. correlatePlans returns keyword-matched results above Jaccard threshold',
    withOverlap.matches.length === 1 && withOverlap.matches[0].overlapScore >= 0.2
  );

  // 3. Source files read from repoDir
  assert(
    '3. correlatePlans reads source files from repoDir for matched plans',
    withOverlap.matches[0].sourceSnippets.length >= 1 &&
      withOverlap.matches[0].sourceSnippets[0].content.includes('PricingService')
  );

  // 4. Missing files skipped
  const missingFileSnippets = withOverlap.matches[0].sourceSnippets.filter((s: any) =>
    s.filePath.includes('missing.ts')
  );
  assert('4. correlatePlans skips missing source files without throwing', missingFileSnippets.length === 0);

  // 5. maxTotalChars budget
  const capped = correlatePlans(
    '# Fix PricingService ECONNREFUSED timeout in src/pricing/pricing.service.ts',
    priorPlans,
    tmpDir,
    { maxTotalChars: 10 }
  );
  const totalChars = capped.matches[0]?.sourceSnippets.reduce((sum: number, s: any) => sum + s.content.length, 0) ?? 0;
  assert('5. correlatePlans respects maxTotalChars budget', totalChars <= 10);

  // 6. Format keyword matches
  const formatted = formatPlanCorrelationPromptSection(withOverlap);
  assert(
    '6. formatPlanCorrelationPromptSection formats keyword matches with overlap and shared keywords',
    formatted.includes('Prior plan correlation') &&
      formatted.includes('[fix]') &&
      formatted.includes('overlap:') &&
      formatted.includes('shared:')
  );

  // 7. Empty matches
  const emptyFormatted = formatPlanCorrelationPromptSection({ matches: [], repoName: 'test' });
  assert('7. formatPlanCorrelationPromptSection returns empty string for zero matches', emptyFormatted === '');

  // 8. Synchronous — measure timing (should be < 100ms, not seconds)
  const start = Date.now();
  for (let i = 0; i < 100; i++) {
    correlatePlans('Fix PricingService timeout src/pricing/pricing.service.ts', priorPlans, tmpDir);
  }
  const elapsedMs = Date.now() - start;
  assert(
    `8. correlatePlans is synchronous (no AI call on critical path) — 100 calls in ${elapsedMs}ms`,
    elapsedMs < 5000
  );

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(path.join(wfHomeDir, repoName), { recursive: true, force: true });

  console.log(chalk.bold.cyan(`\n  Results: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

void run();
