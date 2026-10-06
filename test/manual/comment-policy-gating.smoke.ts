/**
 * Manual smoke test: CommentPolicyStageService respects flag and config gating
 *
 * Run: nr test:manual comment-policy-gating.smoke.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { CommentPolicyStageService } from '../../src/review/comment-policy-stage.service';
import { ConfigService } from '@nestjs/config';
import { createReporter, summarise } from './support/reporter';

const SAMPLE_DIFF = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n const x = 1;\n+// added comment\n`;

const { counts, pass, fail } = createReporter();

async function checkNoForceNoConfig(service: CommentPolicyStageService): Promise<void> {
  const result = await service.scanIfEnabled({ diff: SAMPLE_DIFF });
  if (result === undefined) pass('Returns undefined when neither force nor config is set');
  else fail('Expected undefined', `got ${JSON.stringify(result)}`);
}

async function checkForceFalse(service: CommentPolicyStageService, configService: ConfigService): Promise<void> {
  const orig = configService.get.bind(configService);
  (configService as any).get = (key: string, ...rest: unknown[]) =>
    key === 'stages.review.commentPolicy' ? false : orig(key, ...rest);
  const result = await service.scanIfEnabled({ diff: SAMPLE_DIFF, force: false });
  (configService as any).get = orig;
  if (result === undefined) pass('Returns undefined when force is false and config is false');
  else fail('Expected undefined', `got ${JSON.stringify(result)}`);
}

async function checkForceTrue(service: CommentPolicyStageService): Promise<void> {
  const result = await service.scanIfEnabled({ diff: SAMPLE_DIFF, force: true });
  if (result?.findings) pass('Returns CommentPolicyResult when force is true');
  else fail('Expected CommentPolicyResult', `got ${JSON.stringify(result)}`);
}

async function checkConfigTrue(service: CommentPolicyStageService, configService: ConfigService): Promise<void> {
  const orig = configService.get.bind(configService);
  (configService as any).get = (key: string, ...rest: unknown[]) =>
    key === 'stages.review.commentPolicy' ? true : orig(key, ...rest);
  const result = await service.scanIfEnabled({ diff: SAMPLE_DIFF });
  (configService as any).get = orig;
  if (result?.findings) pass('Returns CommentPolicyResult when config is true');
  else fail('Expected CommentPolicyResult', `got ${JSON.stringify(result)}`);
}

async function main(): Promise<void> {
  console.log('Manual smoke: CommentPolicyStageService gating\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const service = app.get(CommentPolicyStageService);
  const configService = app.get(ConfigService);
  await checkNoForceNoConfig(service);
  await checkForceFalse(service, configService);
  await checkForceTrue(service);
  await checkConfigTrue(service, configService);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
