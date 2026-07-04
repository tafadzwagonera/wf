/**
 * Manual smoke test: prior plan discovery utilities
 *
 * Run: nr test:manual -- test-prior-plan-discovery
 *
 * Verifies:
 *   1. detectPriorPlans discovers canonical plan artifacts and manifest ticket keys
 *   2. mergePriorContexts preserves manifest ticket keys on synthetic recurrence entries
 *   3. mergePriorContexts skips duplicate markdown plan filenames already discovered as prior tickets
 *   4. formatPriorPlansPromptSection includes action, complexity, keywords, and step context
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
  console.log(chalk.bold.cyan('\n🧪 Manual Test: Prior plan discovery utilities\n'));

  const {
    detectPriorPlans,
    mergePriorContexts,
    formatPriorPlansPromptSection,
  } = require('../../src/shared/utils/detect-prior-plans');
  const wfHomeDir = path.join(os.homedir(), '.wf');
  const repoName = `wf-prior-plan-smoke-${Date.now()}`;
  const trackerDir = path.join(wfHomeDir, repoName, 'jira');
  const planPath = path.join(trackerDir, '2026-07-04-abc123-fix-plan.json');
  const manifestPath = path.join(trackerDir, '2026-07-04-abc123-fix-plan.sources.json');

  fs.mkdirSync(trackerDir, { recursive: true });
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        action: 'fix',
        summary: 'Fix PricingService timeout',
        steps: ['Inspect PricingService', 'Patch BookingController timeout handling'],
        estimatedComplexity: 'medium',
        affectedFiles: ['src/pricing/pricing.service.ts'],
        affectedRepositories: ['wf'],
        risks: ['Timeout spikes can still surface ECONNREFUSED'],
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        artifactPath: planPath,
        action: 'fix',
        createdAt: '2026-07-04T00:00:00.000Z',
        format: 'json',
        hash: 'abc123',
        sourceKind: 'ticket',
        sourceName: 'WBP-321',
        ticketKey: 'WBP-321',
      },
      null,
      2
    ),
    'utf8'
  );

  const priorPlans = detectPriorPlans(repoName);
  assert(
    '1. detectPriorPlans discovers canonical plan artifacts and manifest ticket keys',
    priorPlans.plans.length === 1 && priorPlans.plans[0].ticketKey === 'WBP-321'
  );

  const mergedPriorContext = mergePriorContexts(
    {
      repoName,
      tickets: [],
    },
    priorPlans
  );
  assert(
    '2. mergePriorContexts preserves manifest ticket keys on synthetic recurrence entries',
    mergedPriorContext.tickets.length === 1 && mergedPriorContext.tickets[0].ticketKey === 'WBP-321'
  );

  const markdownDuplicateContext = mergePriorContexts(
    {
      repoName,
      tickets: [
        {
          title: 'Fix PricingService timeout',
          summary: 'Fix PricingService timeout',
          filename: '2026-07-04-abc123-fix-plan.md',
          keywords: ['PricingService'],
        },
      ],
    },
    {
      repoName,
      plans: [
        {
          title: 'Fix PricingService timeout',
          summary: 'Fix PricingService timeout',
          filename: '2026-07-04-abc123-fix-plan.md',
          keywords: ['PricingService'],
          steps: ['Inspect PricingService'],
          action: 'fix',
          estimatedComplexity: 'medium',
          ticketKey: null,
        },
      ],
    }
  );
  assert(
    '3. mergePriorContexts skips duplicate markdown plan filenames already discovered as prior tickets',
    markdownDuplicateContext.tickets.length === 1
  );

  const promptSection = formatPriorPlansPromptSection(priorPlans);
  assert(
    '4. formatPriorPlansPromptSection includes action, complexity, keywords, and step context',
    promptSection.includes('Related prior plans') &&
      promptSection.includes('[fix] Fix PricingService timeout') &&
      promptSection.includes('complexity: medium') &&
      promptSection.includes('Steps: 1. Inspect PricingService; 2. Patch BookingController timeout handling')
  );

  fs.rmSync(path.join(wfHomeDir, repoName), { recursive: true, force: true });

  console.log(chalk.bold.cyan(`\n  Results: ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

void run();
