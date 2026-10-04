/**
 * Manual smoke test: formatPlanQualityViolations output format when validateLoadedPlan detects violations
 *
 * Scenario: When PlanStageService.validateLoadedPlan finds quality violations on a plan loaded from
 * disk (rename step without explicit replacement target), the console output must use the new
 * formatPlanQualityViolations layout: a bold-yellow "⚠ Plan quality violations (loaded plan):" header,
 * each [ruleId] rendered on its own before the message body, and consecutive violations separated by
 * a blank line. The raw violation strings appended to plan.risks must be unaffected by the display
 * transform.
 *
 * Run: nr test:manual plan-quality-violation-format-loaded-plan.smoke
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  const restore = () => {
    console.log = original;
  };
  return { lines, restore };
};

const initRepo = (repoDir: string): void => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 'wf@example.test');
  git('config', 'user.name', 'wf');
  git('commit', '--allow-empty', '-m', 'baseline');
};

const singleViolationPlan = {
  action: 'fix' as const,
  summary: 'Rename auth service',
  estimatedComplexity: 'low' as const,
  steps: ['Rename AuthService in wf/src/auth/auth.service.ts.'],
  affectedFiles: [{ filePath: 'wf/src/auth/auth.service.ts', status: 'found' as const }],
  affectedRepositories: ['wf'],
  risks: [] as string[],
};

const twoViolationPlan = {
  ...singleViolationPlan,
  steps: [
    'Rename AuthService in wf/src/auth/auth.service.ts.',
    'Rename UserService in wf/src/user/user.service.ts.',
  ],
  risks: [] as string[],
};

const assertHeaderPresent = (output: string): void => {
  if (output.includes('⚠ Plan quality violations (loaded plan):')) {
    pass('header contains expected text');
  } else {
    fail('header missing expected text', output.slice(0, 200));
  }
};

const assertTagPresent = (output: string): void => {
  if (output.includes('[rename-target-required]')) {
    pass('[rename-target-required] tag present in output');
  } else {
    fail('[rename-target-required] tag missing from output', output.slice(0, 200));
  }
};

const assertTagFollowedBySpace = (output: string): void => {
  const tagIndex = output.indexOf('[rename-target-required]');
  const charAfterTag = output[tagIndex + '[rename-target-required]'.length];
  if (charAfterTag === ' ') {
    pass('[ruleId] tag immediately followed by a space');
  } else {
    fail('[ruleId] tag not followed by a space', `got ${JSON.stringify(charAfterTag)}`);
  }
};

const assertRisksEntry = (plan: typeof singleViolationPlan): void => {
  const riskEntry = plan.risks.find(r => /\[plan-quality\].*\[rename-target-required\]/.test(r));
  if (riskEntry) {
    pass('plan.risks contains [plan-quality]...[rename-target-required] entry');
  } else {
    fail('plan.risks missing expected entry', JSON.stringify(plan.risks));
  }
};

const assertRisksHaveNoDisplayHeader = (plan: typeof singleViolationPlan): void => {
  if (!plan.risks.some(r => r.includes('⚠'))) {
    pass('plan.risks does not contain display header');
  } else {
    fail('plan.risks incorrectly contains ⚠ display header');
  }
};

const assertSingleViolation = (lines: string[], plan: typeof singleViolationPlan): void => {
  const output = lines.join('\n');
  assertHeaderPresent(output);
  assertTagPresent(output);
  assertTagFollowedBySpace(output);
  assertRisksEntry(plan);
  assertRisksHaveNoDisplayHeader(plan);
};

const assertTwoViolations = (lines: string[]): void => {
  const output = lines.join('\n');
  if (output.includes('\n\n')) {
    pass('blank line separates multiple violations');
  } else {
    fail('no blank line found between violations', output.slice(0, 300));
  }
};

const runSingleViolation = async (service: PlanStageService, repoDir: string): Promise<void> => {
  const plan = { ...singleViolationPlan, risks: [] as string[] };
  const { lines, restore } = interceptConsole();
  try {
    await (service as any).validateLoadedPlan(plan, repoDir);
  } finally {
    restore();
  }
  assertSingleViolation(lines, plan);
};

const runTwoViolations = async (service: PlanStageService, repoDir: string): Promise<void> => {
  const plan = { ...twoViolationPlan, risks: [] as string[] };
  const { lines, restore } = interceptConsole();
  try {
    await (service as any).validateLoadedPlan(plan, repoDir);
  } finally {
    restore();
  }
  assertTwoViolations(lines);
};

const main = async (): Promise<void> => {
  console.log(chalk.bold.cyan('\n  plan quality violation format — validateLoadedPlan\n'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-qual-fmt-loaded-'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    initRepo(repoDir);
    const service = app.get(PlanStageService);
    await runSingleViolation(service, repoDir);
    await runTwoViolations(service, repoDir);
  } finally {
    await app.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
  summarise(counts);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
