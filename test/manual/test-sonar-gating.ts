/**
 * Manual smoke test: SonarScanner gating in issue:review
 *
 * Verifies the four gating paths of resolveSonarOutputForTarget:
 *   1. --skip-sonar flag → immediate return
 *   2. stages.review.sonar: false config → immediate return
 *   3. No repoDir → skip with "no repo directory" message
 *   4. No sonar-project.properties → skip with distinct message
 *
 * Run: nr test:manual -- test-sonar-gating
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';

type ResolveFn = (
  target: Record<string, unknown>,
  options: Record<string, unknown>,
  onProgress: (m: string) => void
) => Promise<string | undefined>;

async function run(): Promise<void> {
  console.log('Manual smoke: SonarScanner gating in issue:review\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const command = app.get(IssueReviewCommand);
  const configService = app.get(ConfigService);

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

  const cmd = command as unknown as Record<string, ResolveFn>;
  const resolve: ResolveFn = cmd['resolveSonarOutputForTarget'].bind(command);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-gate-'));
  fs.writeFileSync(path.join(tempDir, 'sonar-project.properties'), 'sonar.projectKey=test\n');

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-no-props-'));

  console.log(chalk.bold.cyan('\nTest 1: --skip-sonar flag bypasses scan'));

  const msgs1: string[] = [];
  const result1 = await resolve(
    { repoDir: tempDir, diff: '', title: '', context: '' },
    { skipSonar: true },
    (m: string) => msgs1.push(m)
  );

  if (result1 === undefined) pass('Returns undefined when skipSonar is true');
  else fail(`Expected undefined, got: ${result1}`);

  if (msgs1.some(m => m.includes('Running SonarScanner'))) fail('Scanner ran despite skipSonar flag');
  else pass('No scanner progress emitted');

  console.log(chalk.bold.cyan('\nTest 2: stages.review.sonar: false config bypasses scan'));

  const msgs2: string[] = [];
  const originalGet = configService.get.bind(configService);
  (configService as unknown as Record<string, unknown>)['get'] = (key: string, ...rest: unknown[]) => {
    if (key === 'stages.review.sonar') return false;
    return originalGet(key, ...rest);
  };

  const result2 = await resolve(
    { repoDir: tempDir, diff: '', title: '', context: '' },
    {},
    (m: string) => msgs2.push(m)
  );

  (configService as unknown as Record<string, unknown>)['get'] = originalGet;

  if (result2 === undefined) pass('Returns undefined when config sonar is false');
  else fail(`Expected undefined, got: ${result2}`);

  if (msgs2.some(m => m.includes('Running SonarScanner'))) fail('Scanner ran despite config gate');
  else pass('No scanner progress emitted');

  console.log(chalk.bold.cyan('\nTest 3: undefined repoDir → distinct skip message'));

  const msgs3: string[] = [];
  const result3 = await resolve(
    { diff: '', title: '', context: '' },
    {},
    (m: string) => msgs3.push(m)
  );

  if (result3 === undefined) pass('Returns undefined when repoDir is undefined');
  else fail(`Expected undefined, got: ${result3}`);

  if (msgs3.some(m => m.includes('no repo directory'))) pass('Progress says "no repo directory"');
  else fail(`Expected "no repo directory", got: ${JSON.stringify(msgs3)}`);

  if (msgs3.some(m => m.includes('sonar-project.properties'))) fail('Incorrectly mentions sonar-project.properties');
  else pass('Does not mention sonar-project.properties');

  console.log(chalk.bold.cyan('\nTest 4: no sonar-project.properties → skip with correct message'));

  const msgs4: string[] = [];
  const result4 = await resolve(
    { repoDir: emptyDir, diff: '', title: '', context: '' },
    {},
    (m: string) => msgs4.push(m)
  );

  if (result4 === undefined) pass('Returns undefined when properties file missing');
  else fail(`Expected undefined, got: ${result4}`);

  if (msgs4.some(m => m.includes('no sonar-project.properties found'))) pass('Progress says "no sonar-project.properties found"');
  else fail(`Expected "no sonar-project.properties found", got: ${JSON.stringify(msgs4)}`);

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: SonarScanner gating');
}

run().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
