/**
 * Manual smoke test: formatPlanQualityViolations output format in applyQualityViolationsToRisks
 *
 * Scenario: When PlanStageService.applyQualityViolationsToRisks is called with pre-formatted
 * "[ruleId] message" strings (the shape built by validatePlanViolations), the console output must
 * use the new formatPlanQualityViolations layout: a bold-yellow header, each [ruleId] tag on its
 * own line before the message body, and blank-line separation between violations. The original
 * violations array and the attempt plan must be unmodified by the display call.
 *
 * Run: nr test:manual plan-quality-violation-format-persisted.smoke
 */
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const ANSI_PATTERN = new RegExp(String.fromCodePoint(27) + String.raw`\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replaceAll(ANSI_PATTERN, '');

const interceptConsole = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(String).join(' ')));
    original(...args);
  };
  const restore = (): void => {
    console.log = original;
  };
  return { lines, restore };
};

const makePlanAttempt = () => ({
  plan: {
    action: 'fix' as const,
    summary: 'Fix auth handler',
    estimatedComplexity: 'low' as const,
    steps: ['Update AuthHandler'],
    affectedFiles: [],
    affectedRepositories: ['wf'],
    risks: ['[existing-risk] Prior risk entry'],
  },
  sessionId: 'test-session-id',
  modelUsed: 'claude-haiku-4-5-20251001',
});

const VIOLATIONS = [
  '[rename-target-required] Step 1 must state the replacement target explicitly.',
  '[no-inline-test-run] Verification command must use a package-manager script, not inline runner.',
];

const assertHeaderAndSeparator = (output: string): void => {
  if (output.includes('⚠ Plan quality violations persisted after retry:')) {
    pass('header contains expected text');
  } else {
    fail('header missing expected text', output.slice(0, 200));
  }
  if (output.includes('\n\n')) {
    pass('blank line separates the two violations');
  } else {
    fail('no blank-line separator found between violations', output.slice(0, 300));
  }
};

const assertTagsPresent = (output: string): void => {
  if (output.includes('[rename-target-required]')) {
    pass('[rename-target-required] tag present in output');
  } else {
    fail('[rename-target-required] tag missing from output', output.slice(0, 200));
  }
  if (output.includes('[no-inline-test-run]')) {
    pass('[no-inline-test-run] tag present in output');
  } else {
    fail('[no-inline-test-run] tag missing from output', output.slice(0, 200));
  }
};

const assertViolationsUnmodified = (originalViolations: string[]): void => {
  if (originalViolations.length === 2 && originalViolations[0].startsWith('[rename-target-required]')) {
    pass('original violations array is unmodified after the call');
  } else {
    fail('original violations array was mutated', JSON.stringify(originalViolations));
  }
};

const assertFormatOutput = (lines: string[], originalViolations: string[]): void => {
  const output = lines.join('\n');
  assertHeaderAndSeparator(output);
  assertTagsPresent(output);
  assertViolationsUnmodified(originalViolations);
};

type RiskHolder = { plan: { risks: string[] } };

const assertReturnedRisks = (result: RiskHolder): void => {
  if (result.plan.risks.some(r => r.startsWith('[plan-quality]'))) {
    pass('returned plan.risks contains [plan-quality] entries');
  } else {
    fail('returned plan.risks missing [plan-quality] entries', JSON.stringify(result.plan.risks));
  }
  if (result.plan.risks.includes('[existing-risk] Prior risk entry')) {
    pass('returned plan.risks preserves the original risk entry');
  } else {
    fail('original risk entry missing from returned plan', JSON.stringify(result.plan.risks));
  }
};

const assertRisksUpdated = (result: RiskHolder, originalAttempt: RiskHolder): void => {
  assertReturnedRisks(result);
  if (originalAttempt.plan.risks.length === 1) {
    pass('original attempt.plan.risks is unmodified (no mutation)');
  } else {
    fail('original attempt.plan.risks was mutated', JSON.stringify(originalAttempt.plan.risks));
  }
};

const runScenario = (service: PlanStageService): void => {
  const attempt = makePlanAttempt();
  const violations = [...VIOLATIONS];
  const { lines, restore } = interceptConsole();
  let result: ReturnType<typeof makePlanAttempt>;
  try {
    result = (service as any).applyQualityViolationsToRisks(attempt, violations);
  } finally {
    restore();
  }
  assertFormatOutput(lines, violations);
  assertRisksUpdated(result, attempt);
};

const main = async (): Promise<void> => {
  console.log(chalk.bold.cyan('\n  plan quality violation format — applyQualityViolationsToRisks\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    runScenario(app.get(PlanStageService));
  } finally {
    await app.close();
  }
  summarise(counts);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
