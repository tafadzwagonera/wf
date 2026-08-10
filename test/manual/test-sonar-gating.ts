/**
 * Manual smoke test: SonarScanner gating in issue:review
 *
 * Verifies the six gating paths:
 *   1. --skip-sonar flag → immediate return, no progress
 *   2. stages.review.sonar: false config → immediate return, no progress
 *   3. No repoDir → skip with "no repo directory" message
 *   4. No sonar-project.properties → skip with distinct message
 *   5. sonar.host.url present → skip with remote analysis message
 *   6. skipForFork=true → skip with "review session forked" message
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
import { runSonarScanForReview } from '../../src/review/sonar-scanner';
import chalk from 'chalk';

type ResolveFn = (
  target: Record<string, unknown>,
  options: Record<string, unknown>,
  onProgress: (m: string) => void
) => Promise<void>;

async function run(): Promise<void> {
  console.log('Manual smoke: SonarScanner gating\n');

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

  const hostUrlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-host-url-'));
  fs.writeFileSync(
    path.join(hostUrlDir, 'sonar-project.properties'),
    'sonar.projectKey=test\nsonar.host.url=https://sonarcloud.io\n'
  );

  console.log(chalk.bold.cyan('\nTest 1: --skip-sonar flag bypasses scan'));

  const msgs1: string[] = [];
  await resolve(
    { repoDir: tempDir, diff: '', title: '', context: '' },
    { skipSonar: true },
    (m: string) => msgs1.push(m)
  );

  if (msgs1.length === 0) pass('No progress emitted when skipSonar is true');
  else fail(`Expected no messages, got: ${JSON.stringify(msgs1)}`);

  console.log(chalk.bold.cyan('\nTest 2: stages.review.sonar: false config bypasses scan'));

  const msgs2: string[] = [];
  const originalGet = configService.get.bind(configService);
  (configService as unknown as Record<string, unknown>)['get'] = (key: string, ...rest: unknown[]) => {
    if (key === 'stages.review.sonar') return false;
    return originalGet(key, ...rest);
  };

  await resolve(
    { repoDir: tempDir, diff: '', title: '', context: '' },
    {},
    (m: string) => msgs2.push(m)
  );

  (configService as unknown as Record<string, unknown>)['get'] = originalGet;

  if (msgs2.length === 0) pass('No progress emitted when config sonar is false');
  else fail(`Expected no messages, got: ${JSON.stringify(msgs2)}`);

  console.log(chalk.bold.cyan('\nTest 3: undefined repoDir → distinct skip message'));

  const msgs3: string[] = [];
  await resolve(
    { diff: '', title: '', context: '' },
    {},
    (m: string) => msgs3.push(m)
  );

  if (msgs3.some(m => m.includes('no repo directory'))) pass('Progress says "no repo directory"');
  else fail(`Expected "no repo directory", got: ${JSON.stringify(msgs3)}`);

  console.log(chalk.bold.cyan('\nTest 4: no sonar-project.properties → skip with correct message'));

  const msgs4: string[] = [];
  await resolve(
    { repoDir: emptyDir, diff: '', title: '', context: '' },
    {},
    (m: string) => msgs4.push(m)
  );

  if (msgs4.some(m => m.includes('no sonar-project.properties found'))) pass('Progress says "no sonar-project.properties found"');
  else fail(`Expected "no sonar-project.properties found", got: ${JSON.stringify(msgs4)}`);

  console.log(chalk.bold.cyan('\nTest 5: sonar.host.url present → skip with remote analysis message'));

  const msgs5: string[] = [];
  await runSonarScanForReview({
    repoDir: hostUrlDir,
    onProgress: (m: string) => msgs5.push(m),
  });

  if (msgs5.some(m => m.includes('sonar.host.url is configured'))) pass('Progress says "sonar.host.url is configured"');
  else fail(`Expected host.url skip message, got: ${JSON.stringify(msgs5)}`);

  if (msgs5.some(m => m.includes('Running SonarScanner'))) fail('Scanner ran despite sonar.host.url being configured');
  else pass('Scanner did not run');

  console.log(chalk.bold.cyan('\nTest 6: skipForFork=true → skip with review session forked message'));

  const msgs6: string[] = [];
  await runSonarScanForReview({
    repoDir: tempDir,
    onProgress: (m: string) => msgs6.push(m),
    skipForFork: true,
  });

  if (msgs6.some(m => m.includes('review session forked'))) pass('Progress says "review session forked"');
  else fail(`Expected fork skip message, got: ${JSON.stringify(msgs6)}`);

  if (msgs6.some(m => m.includes('Running SonarScanner'))) fail('Scanner ran despite skipForFork being true');
  else pass('Scanner did not run');

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
  fs.rmSync(hostUrlDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  await app.close();
  if (failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: SonarScanner gating');
}

run().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
