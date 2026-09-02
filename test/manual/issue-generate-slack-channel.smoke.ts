/**
 * Manual Test: issue:generate with Slack channel archive URL source
 *
 * Run: yarn test:manual test-issue-generate-slack-channel
 *
 * Verifies that:
 *   1. SlackService.fetchChannelHistory is called with the correct channelId and limit
 *   2. The artifact file is written with formatted messages
 *   3. AiService.execute is called (synthesis ran)
 *   4. Captured stdout contains at least the "### Summary" section
 *
 * No real API calls are made — both SlackService and AiService are mocked.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import { SlackService } from '../../src/integrations/slack/slack.service';
import { createReporter } from './support/reporter';

const SLACK_CHANNEL_URL = 'https://myworkspace.slack.com/archives/C0AP5MMCP53';
const EXPECTED_CHANNEL_ID = 'C0AP5MMCP53';
const EXPECTED_LIMIT = 50;

const MOCK_SLACK_MESSAGES = [
  {
    user: 'U111',
    ts: '1711234567.890000',
    text: 'The importer is reading Slack shell HTML instead of messages.',
  },
  {
    user: 'U222',
    ts: '1711234568.000000',
    text: 'Use channel history for archive URLs without a message timestamp.',
  },
];

const MOCK_AI_RESPONSE = JSON.stringify({
  title: 'Fix Slack channel issue generation',
  type: 'task',
  priority: 'medium',
  description: [
    '## Description',
    '',
    '### Summary',
    'Issue generation now reads recent Slack channel messages for bare archive URLs.',
    '',
    '#### Technical Details',
    '- Route archive URLs to Slack conversations.history.',
    '',
    '### Acceptance Criteria',
    '- Bare Slack archive URLs synthesize from message text instead of page HTML.',
    '',
    '### Risks & Assumptions',
    '- Slack bot access is still required for real workspace runs.',
    '',
    '#### Out of Scope',
    '- Full channel export pagination.',
  ].join('\n'),
});

async function main(): Promise<void> {
  console.log('\n🧪 Manual Test: issue:generate with Slack channel archive URL\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const { counts, pass, fail } = createReporter();

  let slackFetchCallArgs: [string, number] | null = null;
  const originalFetchChannelHistory = SlackService.prototype.fetchChannelHistory;
  (SlackService.prototype as any).fetchChannelHistory = async (channelId: string, limit: number) => {
    slackFetchCallArgs = [channelId, limit];
    return {
      channelId,
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

  let capturedOutput = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (chunk: any) => boolean) = (chunk: any, ..._args: any[]) => {
    capturedOutput += String(chunk);
    return true;
  };

  let artifactWritePath: string | null = null;
  let artifactWriteContent: string | null = null;
  const originalMkdir = fs.promises.mkdir;
  const originalWriteFile = fs.promises.writeFile;
  (fs.promises as any).mkdir = async () => undefined;
  (fs.promises as any).writeFile = async (filePath: string, content: string) => {
    artifactWritePath = filePath;
    artifactWriteContent = content;
  };

  const command = app.get(IssueGenerateCommand);

  try {
    await command.run([SLACK_CHANNEL_URL], {} as any);
  } catch (_) {
    // Ignore — assertions are made on side effects.
  } finally {
    process.stdout.write = originalWrite;
    SlackService.prototype.fetchChannelHistory = originalFetchChannelHistory;
    AiService.prototype.execute = originalExecute;
    StageAgentService.prototype.generateFromPrompt = originalGenerateFromPrompt;
    fs.promises.mkdir = originalMkdir;
    fs.promises.writeFile = originalWriteFile;
  }

  if (slackFetchCallArgs !== null) {
    const channelId = slackFetchCallArgs[0];
    const limit = slackFetchCallArgs[1];
    if (channelId === EXPECTED_CHANNEL_ID && limit === EXPECTED_LIMIT) {
      pass(`SlackService.fetchChannelHistory called with ('${channelId}', ${limit})`);
    } else {
      fail(
        'SlackService.fetchChannelHistory called with wrong args',
        `Expected ('${EXPECTED_CHANNEL_ID}', ${EXPECTED_LIMIT}) but got ('${channelId}', ${limit})`
      );
    }
  } else {
    fail('SlackService.fetchChannelHistory was NOT called');
  }

  const expectedLine0 = `[${MOCK_SLACK_MESSAGES[0].ts}] ${MOCK_SLACK_MESSAGES[0].user}: ${MOCK_SLACK_MESSAGES[0].text}`;
  const expectedLine1 = `[${MOCK_SLACK_MESSAGES[1].ts}] ${MOCK_SLACK_MESSAGES[1].user}: ${MOCK_SLACK_MESSAGES[1].text}`;
  const artifactWritePathString = artifactWritePath ? String(artifactWritePath) : '';
  const artifactWriteContentString = artifactWriteContent ? String(artifactWriteContent) : '';
  const earliestTs = MOCK_SLACK_MESSAGES.map(m => m.ts).sort()[0].replace('.', '-');
  const hasExpectedArtifactPath = artifactWritePathString.endsWith(`slack-thread-${EXPECTED_CHANNEL_ID}-${earliestTs}.md`);
  const hasExpectedArtifactContent
    = artifactWriteContentString.includes(expectedLine0) && artifactWriteContentString.includes(expectedLine1);

  if (hasExpectedArtifactPath && hasExpectedArtifactContent) {
    pass(`Artifact write captured at ${artifactWritePath}`);
  } else {
    fail(
      'Artifact write was not captured with the expected content',
      `Path: ${artifactWritePathString || 'null'}\n    Content:\n    ${artifactWriteContentString || 'null'}`
    );
  }

  if (aiCallCount > 0) {
    pass(`AiService.execute was called (${aiCallCount} time(s))`);
  } else {
    fail('AiService.execute was NOT called — synthesis did not run');
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
  console.error(error);
  process.exit(1);
});
