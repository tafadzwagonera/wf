/**
 * Manual smoke test: assembled review guidelines include Accessibility and
 * Scope & necessity; standalone Necessity and Scope are absent
 *
 * Verifies that the ReviewStageService's internal guidelines array, resolved
 * through the live NestJS DI graph, contains the updated rubric entries after
 * the F-phase changes. Exercises buildReviewGuidelines via prototype access so
 * no real AI call is made.
 *
 * Run: nr test:manual -- review-rubric-accessibility-scope.smoke
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(chalk.green('  PASS  ' + msg));
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  const suffix = detail ? '\n    → ' + detail : '';
  console.error(chalk.red('  FAIL  ' + msg + suffix));
  failed++;
};

async function main(): Promise<void> {
  console.log('Manual smoke: review rubric Accessibility and Scope & necessity\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });

  try {
    const svc = app.get(ReviewStageService);
    const buildReviewGuidelines = (
      (svc as unknown as Record<string, unknown>)['buildReviewGuidelines'] as (
        opts: { context: string; extraCriteria?: string[] }
      ) => string[]
    ).bind(svc);

    const STUB_CONTEXT = 'ticket WBP-0: smoke test';

    console.log(chalk.bold.cyan('\nTest 1: default guidelines contain required criteria'));
    {
      const guidelines = buildReviewGuidelines({ context: STUB_CONTEXT });

      if (guidelines.some(g => g.includes('Scope & necessity'))) {
        pass('Guidelines include "Scope & necessity"');
      } else {
        fail('"Scope & necessity" missing from guidelines', guidelines.join('\n'));
      }

      if (guidelines.some(g => g.includes('Accessibility'))) {
        pass('Guidelines include "Accessibility"');
      } else {
        fail('"Accessibility" missing from guidelines', guidelines.join('\n'));
      }

      if (guidelines.includes('Necessity')) {
        fail('Standalone "Necessity" criterion still present');
      } else {
        pass('Standalone "Necessity" criterion is absent');
      }

      if (guidelines.includes('Scope')) {
        fail('Standalone "Scope" criterion still present');
      } else {
        pass('Standalone "Scope" criterion is absent');
      }
    }

    console.log(chalk.bold.cyan('\nTest 2: defaultReviewGuidelines has 13 entries (Relevancy added separately)'));
    {
      const guidelines = buildReviewGuidelines({ context: STUB_CONTEXT });
      const defaultCount = guidelines.filter(g => !g.startsWith('Relevancy:')).length;

      if (defaultCount === 13) {
        pass('Default criteria count = 13');
      } else {
        fail('Expected 13 default criteria, got ' + defaultCount, guidelines.map((g, i) => (i + 1) + '. ' + g.slice(0, 60)).join('\n'));
      }
    }

    console.log(chalk.bold.cyan('\nTest 3: extraCriteria appended without removing defaults'));
    {
      const guidelines = buildReviewGuidelines({ context: STUB_CONTEXT, extraCriteria: ['Custom: check X'] });

      if (guidelines.includes('Custom: check X')) {
        pass('extraCriteria entry present');
      } else {
        fail('extraCriteria entry missing');
      }
      if (guidelines.some(g => g.includes('Scope & necessity'))) {
        pass('"Scope & necessity" still present after extraCriteria');
      } else {
        fail('"Scope & necessity" removed by extraCriteria');
      }
      if (guidelines.some(g => g.includes('Accessibility'))) {
        pass('"Accessibility" still present after extraCriteria');
      } else {
        fail('"Accessibility" removed by extraCriteria');
      }
    }
  } finally {
    await app.close();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: review rubric Accessibility and Scope & necessity');
}

main().catch(error => {
  console.error('\nManual smoke test failed: ' + error.message);
  process.exit(1);
});
