/**
 * Manual smoke test: SonarScanner output threads to presenter and artifact
 *
 * Verifies that sonarOutput flows correctly through:
 *   1. ReviewPresenter.displayReview → terminal shows static analysis section
 *   2. ReviewPresenter.displayReview without sonarOutput → no section shown
 *   3. ReviewStageService.createReviewArtifact → markdown contains ## Static Analysis
 *
 * Run: nr test:manual -- test-sonar-output-threading
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ReviewPresenter } from '../../src/shared/presentation/review-presenter.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import chalk from 'chalk';
import type { CodeReview } from '../../src/shared/types/review.types';

const SAMPLE_SONAR_OUTPUT = [
  'INFO: Scanner configuration file: /tmp/sonar-scanner.properties',
  'INFO: 12 files indexed',
  'WARN: 3 issues found',
  'INFO: ANALYSIS SUCCESSFUL',
].join('\n');

const SAMPLE_REVIEW: CodeReview = {
  summary: 'Code looks reasonable',
  issues: [{ severity: 'info', message: 'Minor style nit' }],
  suggestions: [],
  approved: true,
};

async function run(): Promise<void> {
  console.log('Manual smoke: SonarScanner output threading\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const presenter = app.get(ReviewPresenter);
  const reviewService = app.get(ReviewStageService);

  let passed = 0;
  let failed = 0;
  const pass = (msg: string) => {
    console.log(chalk.green(`  PASS  ${msg}`));
    passed++;
  };
  const fail = (msg: string) => {
    console.error(chalk.red(`  FAIL  ${msg}`));
    failed++;
  };

  const ESC = String.fromCharCode(27);
  const ansiGlobal = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
  const stripAnsi = (s: string) => s.replaceAll(ansiGlobal, '');

  console.log(chalk.bold.cyan('\nTest 1: displayReview with sonarOutput shows static analysis'));

  const captured1: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => captured1.push(args.map(String).join(' '));
  presenter.displayReview(SAMPLE_REVIEW, SAMPLE_SONAR_OUTPUT);
  console.log = originalLog;

  const clean1 = stripAnsi(captured1.join('\n'));

  if (clean1.includes('Static Analysis (SonarScanner)')) pass('Terminal contains static analysis heading');
  else fail('Missing static analysis heading in terminal output');

  if (clean1.includes('12 files indexed')) pass('Terminal contains scanner output line');
  else fail('Missing scanner output content');

  if (clean1.includes('3 issues found')) pass('Terminal contains scanner warning line');
  else fail('Missing scanner warning content');

  console.log(chalk.bold.cyan('\nTest 2: displayReview without sonarOutput omits section'));

  const captured2: string[] = [];
  console.log = (...args: unknown[]) => captured2.push(args.map(String).join(' '));
  presenter.displayReview(SAMPLE_REVIEW);
  console.log = originalLog;

  const clean2 = stripAnsi(captured2.join('\n'));

  if (clean2.includes('Static Analysis')) fail('Static analysis section shown when sonarOutput is undefined');
  else pass('Static analysis section correctly omitted');

  console.log(chalk.bold.cyan('\nTest 3: createReviewArtifact includes ## Static Analysis'));

  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-artifact-'));
  const ticketDir = path.join(artifactDir, 'TEST-001');
  fs.mkdirSync(ticketDir, { recursive: true });
  const ticketPath = path.join(ticketDir, 'ticket.json');
  fs.writeFileSync(ticketPath, JSON.stringify({ key: 'TEST-001' }));

  const artifact = reviewService.createReviewArtifact(
    { ticketKey: 'TEST-001', path: ticketPath, content: 'Test ticket content' },
    SAMPLE_REVIEW,
    undefined,
    SAMPLE_SONAR_OUTPUT
  );

  const markdown = fs.readFileSync(artifact.path, 'utf-8');

  if (markdown.includes('## Static Analysis (SonarScanner)')) pass('Markdown contains static analysis heading');
  else fail('Missing static analysis heading in markdown artifact');

  if (markdown.includes('12 files indexed')) pass('Markdown contains scanner output');
  else fail('Missing scanner output in markdown');

  console.log(chalk.bold.cyan('\nTest 4: createReviewArtifact without sonarOutput omits section'));

  const artifact2 = reviewService.createReviewArtifact(
    { ticketKey: 'TEST-001', path: ticketPath, content: 'Test ticket content' },
    SAMPLE_REVIEW,
    undefined
  );

  const markdown2 = fs.readFileSync(artifact2.path, 'utf-8');

  if (markdown2.includes('Static Analysis')) fail('Static analysis section present when sonarOutput is undefined');
  else pass('Static analysis section correctly omitted from markdown');

  fs.rmSync(artifactDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: SonarScanner output threading');
}

run().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
