/**
 * Smoke test: "No conversation found with session ID" triggers a fresh retry
 *
 * Run: nr test:manual -- no-conversation-found-stale-resume-retry
 *
 * Scenario: When dispatchToBackend throws an error whose message matches
 * "No conversation found with session ID: <id>", runStagePrompt must catch it,
 * treat it as a stale-resume condition, and retry by calling dispatchToBackend a
 * second time WITHOUT resumeProviderSessionId. This exercises the /no conversation
 * found/i entry added to STALE_RESUME_PATTERNS.
 *
 * Verify:
 *   1. dispatchToBackend is called twice — once with the session ID, once without.
 *   2. The first call carries resumeProviderSessionId: 'stale-sid'.
 *   3. The second (retry) call has no resumeProviderSessionId.
 *   4. runStagePrompt returns the fresh result, not the stale error.
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

type RunStagePromptFn = (params: {
  stage: string;
  prompt: string;
  systemPrompt: string;
  resumeProviderSessionId?: string;
}) => Promise<{ content: string; sessionId?: string }>;

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: no-conversation-found stale-resume retry\n'));

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const service = app.get(StageAgentService);

    const capturedParams: { resumeProviderSessionId?: string }[] = [];
    (service as any).dispatchToBackend = async (params: { resumeProviderSessionId?: string }) => {
      capturedParams.push({ resumeProviderSessionId: params.resumeProviderSessionId });
      if (capturedParams.length === 1) {
        throw new Error('No conversation found with session ID: stale-sid');
      }
      return { content: 'fresh result', sessionId: 'new-sid' };
    };

    const runStagePrompt = (service as unknown as { runStagePrompt: RunStagePromptFn }).runStagePrompt.bind(service);

    const result = await runStagePrompt({
      stage: 'implement',
      prompt: 'test prompt',
      systemPrompt: 'test system prompt',
      resumeProviderSessionId: 'stale-sid',
    });

    const firstCall = capturedParams[0];
    const secondCall = capturedParams[1];

    if (capturedParams.length === 2) {
      pass('dispatchToBackend called exactly twice (initial + retry)');
    } else {
      fail(`expected 2 dispatchToBackend calls, got ${capturedParams.length}`);
    }

    if (firstCall?.resumeProviderSessionId === 'stale-sid') {
      pass('first call carries resumeProviderSessionId: stale-sid');
    } else {
      fail('first call should carry resumeProviderSessionId', JSON.stringify(firstCall));
    }

    if (!secondCall?.resumeProviderSessionId) {
      pass('retry call has no resumeProviderSessionId (fresh start)');
    } else {
      fail('retry call should NOT carry resumeProviderSessionId', JSON.stringify(secondCall));
    }

    if (result?.content === 'fresh result') {
      pass('runStagePrompt returns the fresh retry result');
    } else {
      fail('runStagePrompt should return fresh result', JSON.stringify(result));
    }
  } finally {
    await app.close();
  }

  console.log(chalk.bold(`\nSummary: ${counts.passed} passed, ${counts.failed} failed`));
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
