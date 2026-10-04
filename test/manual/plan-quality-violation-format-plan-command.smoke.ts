/**
 * Manual smoke test: formatPlanQualityViolations output format in IssuePlanCommand
 *
 * Scenario: When IssuePlanCommand.validatePlanQualityRules detects plan quality violations
 * (a rename step without explicit replacement target), the console output must use the new
 * formatPlanQualityViolations layout: a bold-yellow "⚠ Plan quality violations:" header, the
 * [ruleId] tag rendered inline before the message body. The old "    •" bullet prefix must not
 * appear. The plan.risks array must receive [plan-quality] entries; the plan object itself must
 * not be otherwise mutated.
 *
 * Run: nr test:manual plan-quality-violation-format-plan-command.smoke
 */
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssuePlanCommand } from '../../src/commands/issue-plan.command';
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

const makePlan = () => ({
  action: 'fix' as const,
  summary: 'Fix auth handler by renaming AuthService',
  estimatedComplexity: 'low' as const,
  steps: ['Rename AuthService in wf/src/auth/auth.service.ts.'],
  affectedFiles: [{ filePath: 'wf/src/auth/auth.service.ts', status: 'found' as const }],
  affectedRepositories: ['wf'],
  risks: [] as string[],
});

const assertFormatOutput = (lines: string[], plan: ReturnType<typeof makePlan>): void => {
  const output = lines.join('\n');

  if (output.includes('⚠ Plan quality violations:')) {
    pass('header contains expected text');
  } else {
    fail('header missing expected text', output.slice(0, 200));
  }

  if (output.includes('[rename-target-required]')) {
    pass('[rename-target-required] tag present in output');
  } else {
    fail('[rename-target-required] tag missing from output', output.slice(0, 200));
  }

  const tagIndex = output.indexOf('[rename-target-required]');
  const charAfterTag = output[tagIndex + '[rename-target-required]'.length];
  if (charAfterTag === ' ') {
    pass('[ruleId] tag immediately followed by a space');
  } else {
    fail('[ruleId] tag not followed by a space', `got ${JSON.stringify(charAfterTag)}`);
  }

  if (!output.includes('    •')) {
    pass('old bullet prefix "    •" absent from output');
  } else {
    fail('old bullet prefix "    •" still present in output');
  }

  const riskEntry = plan.risks.find(r => /\[plan-quality\].*\[rename-target-required\]/.test(r));
  if (riskEntry) {
    pass('plan.risks contains [plan-quality]...[rename-target-required] entry');
  } else {
    fail('plan.risks missing expected entry', JSON.stringify(plan.risks));
  }

  if (!plan.risks.some(r => r.includes('⚠'))) {
    pass('plan.risks does not contain display header');
  } else {
    fail('plan.risks incorrectly contains ⚠ display header');
  }
};

const main = async (): Promise<void> => {
  console.log(chalk.bold.cyan('\n  plan quality violation format — IssuePlanCommand.validatePlanQualityRules\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const command = app.get(IssuePlanCommand);
    const plan = makePlan();
    const { lines, restore } = interceptConsole();
    try {
      (command as any).validatePlanQualityRules(plan, ['wf']);
    } finally {
      restore();
    }
    assertFormatOutput(lines, plan);
  } finally {
    await app.close();
  }
  summarise(counts);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
