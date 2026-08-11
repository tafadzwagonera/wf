/**
 * Manual smoke test: SonarScanner gating in issue:review
 *
 * Verifies the four gating paths:
 *   1. --skip-sonar flag → immediate return, no progress
 *   2. stages.review.sonar: false config → immediate return, no progress
 *   2b. stages.review.sonar: undefined (default) → immediate return, no progress
 *   3. No repoDir (with sonar: true) → throws a terminal error
 *   4. No sonar-project.properties (with sonar: true) → skip with distinct message
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

  console.log(chalk.bold.cyan('\nTest 2b: stages.review.sonar: undefined (default) bypasses scan'));

  const msgs2b: string[] = [];
  await resolve(
    { repoDir: tempDir, diff: '', title: '', context: '' },
    {},
    (m: string) => msgs2b.push(m)
  );

  if (msgs2b.length === 0) pass('No progress emitted when config sonar is undefined');
  else fail(`Expected no messages, got: ${JSON.stringify(msgs2b)}`);

  const sonarEnabledGet = (key: string, ...rest: unknown[]) => {
    if (key === 'stages.review.sonar') return true;
    return originalGet(key, ...rest);
  };
  (configService as unknown as Record<string, unknown>)['get'] = sonarEnabledGet;

  console.log(chalk.bold.cyan('\nTest 3: undefined repoDir now throws an error'));

  const msgs3: string[] = [];
  try {
    await resolve(
      { diff: '', title: '', context: '' },
      {},
      (m: string) => msgs3.push(m)
    );
    fail('Expected an error for missing repoDir');
  } catch (error) {
    if (error instanceof Error && error.message.includes('repository directory')) pass('Missing repoDir throws a terminal error');
    else fail(`Unexpected error for missing repoDir: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (msgs3.length === 0) pass('No progress emitted before the terminal error');
  else fail(`Expected no progress messages, got: ${JSON.stringify(msgs3)}`);

  console.log(chalk.bold.cyan('\nTest 4: no sonar-project.properties → skip with correct message'));

  const msgs4: string[] = [];
  await resolve(
    { repoDir: emptyDir, diff: '', title: '', context: '' },
    {},
    (m: string) => msgs4.push(m)
  );

  (configService as unknown as Record<string, unknown>)['get'] = originalGet;

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
