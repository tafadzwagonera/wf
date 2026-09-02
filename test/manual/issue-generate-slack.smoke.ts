/**
 * Manual Test: issue:generate with Slack thread permalink source
 *
 * Run: nr test:manual -- test-issue-generate-slack
 *
 * Verifies that:
 *   1. SlackService.fetchThread is called with the correct channelId and threadTs
 *   2. The artifact file is written with formatted messages
 *   3. AiService.execute is called (synthesis ran)
 *   4. Captured stdout contains at least the "### Summary" section
 *
 * No real API calls are made — both SlackService and AiService are mocked.
 */

import * as fs from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { SlackService } from '../../src/integrations/slack/slack.service';
import { createReporter } from './support/reporter';

const SLACK_PERMALINK = 'https://myworkspace.slack.com/archives/C01ABC123/p1711234567890000';
const EXPECTED_CHANNEL_ID = 'C01ABC123';
const EXPECTED_THREAD_TS = '1711234567.890000';

const MOCK_SLACK_MESSAGES = [
  {
    user: 'U111',
    ts: '1711234567.890000',
    text: 'Hello, this is the thread root.',
  },
  { user: 'U222', ts: '1711234568.000000', text: 'And this is a reply.' },
];

const MOCK_AI_RESPONSE = JSON.stringify({
  title: 'Add rate limiting to the API gateway',
  type: 'task',
  priority: 'medium',
  description: [
    '## Description',
    '',
    '### Summary',
    'The API gateway currently has no rate limiting. Under sustained load, downstream services are overwhelmed.',
    'Add per-client rate limiting using a token-bucket algorithm.',
    '',
    '#### Technical Details',
    '- Add a Redis-backed token-bucket middleware to the gateway.',
    '',
    '### Acceptance Criteria',
    '- API returns 429 when a client exceeds 100 requests per minute.',
    '',
    '### Risks & Assumptions',
    '- Redis availability is assumed.',
    '',
    '#### Out of Scope',
    '- Per-endpoint rate limits.',
  ].join('\n'),
});

async function main(): Promise<void> {
  console.log('\n🧪 Manual Test: issue:generate with Slack thread permalink\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const { counts, pass, fail } = createReporter();

  let slackFetchCallArgs: [string, string] | null = null;
  const originalFetchThread = SlackService.prototype.fetchThread;
  (SlackService.prototype as any).fetchThread = async (channelId: string, threadTs: string) => {
    slackFetchCallArgs = [channelId, threadTs];
    return {
      channelId,
      threadTs,
      messages: MOCK_SLACK_MESSAGES,
    };
  };

  const originalExecute = AiService.prototype.execute;
  const originalGenerateFromPrompt = StageAgentService.prototype.generateFromPrompt;
  let aiCallCount = 0;
  (AiService.prototype as any).execute = async () => {
    aiCallCount++;
    return { content: MOCK_AI_RESPONSE };
  };
  (StageAgentService.prototype as any).generateFromPrompt = async () => {
    aiCallCount++;
    return { content: MOCK_AI_RESPONSE };
  };

  // Capture stdout and intercept fs.promises.writeFile to capture the artifact path/content.
  let capturedOutput = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (chunk: any) => boolean) = (chunk: any, ...args: any[]) => {
    capturedOutput += String(chunk);
    return true;
  };

  const originalMkdir = fs.promises.mkdir;
  const originalWriteFile = fs.promises.writeFile;
  let artifactWritePath: string | null = null;
  let artifactWriteContent: string | null = null;
  (fs.promises as any).mkdir = async () => undefined;
  (fs.promises as any).writeFile = async (filePath: string, content: string) => {
    artifactWritePath = filePath;
    artifactWriteContent = content;
  };

  const command = app.get(IssueGenerateCommand);

  try {
    await command.run([SLACK_PERMALINK], {} as any);
  } catch {
    // Ignore
  } finally {
    process.stdout.write = origWrite;
    SlackService.prototype.fetchThread = originalFetchThread;
    AiService.prototype.execute = originalExecute;
    StageAgentService.prototype.generateFromPrompt = originalGenerateFromPrompt;
    fs.promises.mkdir = originalMkdir;
    fs.promises.writeFile = originalWriteFile;
  }

  if (slackFetchCallArgs === null) {
    fail('SlackService.fetchThread was NOT called');
  } else {
    const channelId = (slackFetchCallArgs as string[])[0];
    const threadTs = (slackFetchCallArgs as string[])[1];
    if (channelId === EXPECTED_CHANNEL_ID && threadTs === EXPECTED_THREAD_TS) {
      pass(`SlackService.fetchThread called with ('${channelId}', '${threadTs}')`);
    } else {
      fail(
        'SlackService.fetchThread called with wrong args',
        `Expected ('${EXPECTED_CHANNEL_ID}', '${EXPECTED_THREAD_TS}') but got ('${channelId}', '${threadTs}')`
      );
    }
  }

  const threadId = EXPECTED_THREAD_TS.replace('.', '-');
  const artifactWritePathString = artifactWritePath ? String(artifactWritePath) : '';
  const artifactWriteContentString = artifactWriteContent ? String(artifactWriteContent) : '';
  const expectedLine0 = `[${MOCK_SLACK_MESSAGES[0].ts}] ${MOCK_SLACK_MESSAGES[0].user}: ${MOCK_SLACK_MESSAGES[0].text}`;
  const expectedLine1 = `[${MOCK_SLACK_MESSAGES[1].ts}] ${MOCK_SLACK_MESSAGES[1].user}: ${MOCK_SLACK_MESSAGES[1].text}`;
  const hasExpectedArtifactPath = artifactWritePathString.endsWith(`slack-thread-${EXPECTED_CHANNEL_ID}-${threadId}.md`);
  const hasExpectedArtifactContent
    = artifactWriteContentString.includes(expectedLine0) && artifactWriteContentString.includes(expectedLine1);
  if (hasExpectedArtifactPath && hasExpectedArtifactContent) {
    pass(`Artifact write captured at ${artifactWritePath}`);
  } else {
    fail(
      'Artifact write was not captured with expected content',
      `Path: ${artifactWritePathString || 'null'}\n    Content:\n    ${artifactWriteContentString || 'null'}`
    );
  }

  if (aiCallCount > 0) {
    pass(`AI synthesis ran (${aiCallCount} call(s))`);
  } else {
    fail('AI synthesis did NOT run — both backends were idle');
  }

  if (capturedOutput.includes('### Summary')) {
    pass('Output contains "### Summary" section');
  } else {
    fail(
      'Output missing "### Summary" section',
      `Captured output (first 600 chars):\n    ${capturedOutput.slice(0, 600)}`
    );
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ${counts.passed} passed   ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed! ✓');
  console.log('━'.repeat(60) + '\n');

  await app.close();
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
