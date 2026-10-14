/**
 * Manual smoke test: assembled review guidelines include Accessibility and
 * Scope & necessity; standalone Necessity and Scope are absent
 *
 * Verifies that the ReviewStageService's internal guidelines array, resolved
 * through the live NestJS DI graph, contains the updated rubric entries after
 * the F-phase changes. Exercises buildReviewGuidelines via prototype access so
 * no real AI call is made.
 *
 * Run: nr test:manual review-rubric-accessibility-scope.smoke.ts
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function checkRequired(g: string[], pass: any, fail: any): void {
  if (g.some(x => x.includes('Scope & necessity'))) pass('Guidelines include "Scope & necessity"');
  else fail('"Scope & necessity" missing from guidelines', g.join('\n'));
  if (g.some(x => x.includes('Accessibility'))) pass('Guidelines include "Accessibility"');
  else fail('"Accessibility" missing from guidelines', g.join('\n'));
}

function checkStandalone(g: string[], pass: any, fail: any): void {
  if (g.includes('Necessity')) fail('Standalone "Necessity" criterion still present');
  else pass('Standalone "Necessity" criterion is absent');
  if (g.includes('Scope')) fail('Standalone "Scope" criterion still present');
  else pass('Standalone "Scope" criterion is absent');
}

function test1(build: any, ctx: string): void {
  const g = build({ context: ctx });
  checkRequired(g, pass, fail);
  checkStandalone(g, pass, fail);
}

function test2(
  build: (o: { context: string; extraCriteria?: string[] }) => string[],
  ctx: string,
): void {
  const g = build({ context: ctx });
  const cnt = g.filter(x => !x.startsWith('Relevancy:')).length;
  if (cnt === 14) {
    pass('Default criteria count = 14');
  } else {
    const details = g.map((x, i) => (i + 1) + '. ' + x.slice(0, 60)).join('\n');
    fail('Expected 14 default criteria, got ' + cnt, details);
  }
}

function checkCustomCriteria(g: string[], pass: any, fail: any): void {
  if (g.includes('Custom: check X')) pass('extraCriteria entry present');
  else fail('extraCriteria entry missing');
}

function checkScopeAndAccess(g: string[], pass: any, fail: any): void {
  if (g.some(x => x.includes('Scope & necessity'))) pass('"Scope & necessity" still present after extraCriteria');
  else fail('"Scope & necessity" removed by extraCriteria');
  if (g.some(x => x.includes('Accessibility'))) pass('"Accessibility" still present after extraCriteria');
  else fail('"Accessibility" removed by extraCriteria');
}

function test3(build: any, ctx: string): void {
  const g = build({ context: ctx, extraCriteria: ['Custom: check X'] });
  checkCustomCriteria(g, pass, fail);
  checkScopeAndAccess(g, pass, fail);
}

function getBuild(svc: ReviewStageService): (opts: { context: string; extraCriteria?: string[] }) => string[] {
  const method = svc['buildReviewGuidelines'];
  return method.bind(svc);
}

function runAllTests(build: any, ctx: string): void {
  console.log(chalk.bold.cyan('\nTest 1: default guidelines contain required criteria'));
  test1(build, ctx);
  console.log(chalk.bold.cyan('\nTest 2: defaultReviewGuidelines has 14 entries (Relevancy added separately)'));
  test2(build, ctx);
  console.log(chalk.bold.cyan('\nTest 3: extraCriteria appended without removing defaults'));
  test3(build, ctx);
}

async function main(): Promise<void> {
  console.log('Manual smoke: review rubric Accessibility and Scope & necessity\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const build = getBuild(app.get(ReviewStageService));
  try {
    runAllTests(build, 'ticket WBP-0: smoke test');
  } finally {
    await app.close();
  }
  console.log('\n' + counts.passed + ' passed, ' + counts.failed + ' failed');
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: review rubric Accessibility and Scope & necessity');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
