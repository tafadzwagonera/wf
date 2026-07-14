/**
 * Manual Test: issue:generate with Slack thread permalink query params
 *
 * Run: nr test:manual -- test-issue-generate-slack-query
 *
 * Verifies that:
 *   1. SlackService.fetchThread is called with the correct channelId and threadTs
 *   2. The artifact file is written with formatted messages
 *   3. AiService.execute is called (synthesis ran)
 *   4. Captured stdout contains at least the "### Summary" section
 *
 * No real API calls are made — both SlackService and AiService are mocked.
 */

import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { IssueGenerateCommand } from '../../commands/issue-generate.command';
import { AiService } from '../../integrations/ai/ai.service';
import { SlackService } from '../../integrations/slack/slack.service';
import { getWfHomeDir } from '../../shared/utils/wf-paths';

const SLACK_PERMALINK
  = 'https://myworkspace.slack.com/archives/C01ABC123/p1711234567890000?thread_ts=1711234567.890000&cid=C01ABC123';
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

const MOCK_AI_RESPONSE = `# Heading: Add rate limiting to the API gateway

**Type:** task
**Priority:** medium

## Description

### Summary
The API gateway currently has no rate limiting. Under sustained load, downstream services are overwhelmed.
Add per-client rate limiting using a token-bucket algorithm.

#### Technical Details
- Add a Redis-backed token-bucket middleware to the gateway.

### Acceptance Criteria
- API returns 429 when a client exceeds 100 requests per minute.

### Risks & Assumptions
- Redis availability is assumed.

#### Out of Scope
- Per-endpoint rate limits.
`;

async function testIssueGenerateSlackQuery() {
  console.log('\n🧪 Manual Test: issue:generate with Slack thread permalink query params\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`  ✓ ${msg}`);
    passed++;
  };

  const fail = (msg: string, detail?: string) => {
    console.error(`  ✗ ${msg}${detail ? `\n    → ${detail}` : ''}`);
    failed++;
  };

  const slackServicePrototype = SlackService.prototype;
  let slackFetchCallArgs: [string, string] | null = null;
  const originalFetchThread = slackServicePrototype.fetchThread.bind(slackServicePrototype);
  (slackServicePrototype as any).fetchThread = async (channelId: string, threadTs: string) => {
    slackFetchCallArgs = [channelId, threadTs];
    return {
      channelId,
      threadTs,
      messages: MOCK_SLACK_MESSAGES,
    };
  };

  const aiServicePrototype = AiService.prototype;
  const originalExecute = aiServicePrototype.execute.bind(aiServicePrototype);
  let aiCallCount = 0;
  (aiServicePrototype as any).execute = async () => {
    aiCallCount++;
    return { content: MOCK_AI_RESPONSE };
  };

  let capturedOutput = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any) => {
    capturedOutput += String(chunk);
    return true;
  };

  const threadId = EXPECTED_THREAD_TS.replace('.', '-');
  const artifactDir = path.join(getWfHomeDir(), path.basename(process.cwd()), 'slack');
  const artifactPath = path.join(artifactDir, `slack-thread-${EXPECTED_CHANNEL_ID}-${threadId}.md`);

  const command = app.get(IssueGenerateCommand);

  try {
    await command.run([SLACK_PERMALINK], {} as any);
  } catch {
    // Ignore — assertions are made on side effects
  } finally {
    process.stdout.write = origWrite;
    slackServicePrototype.fetchThread = originalFetchThread;
    aiServicePrototype.execute = originalExecute;
  }

  if (slackFetchCallArgs !== null) {
    const channelId = slackFetchCallArgs[0];
    const threadTs = slackFetchCallArgs[1];
    if (channelId === EXPECTED_CHANNEL_ID && threadTs === EXPECTED_THREAD_TS) {
      pass(`SlackService.fetchThread called with ('${channelId}', '${threadTs}')`);
    } else {
      fail(
        'SlackService.fetchThread called with wrong args',
        `Expected ('${EXPECTED_CHANNEL_ID}', '${EXPECTED_THREAD_TS}') but got ('${channelId}', '${threadTs}')`
      );
    }
  } else {
    fail('SlackService.fetchThread was NOT called');
  }

  let artifactContent = '';
  try {
    artifactContent = fs.readFileSync(artifactPath, 'utf-8');
    const expectedLine0 = `[${MOCK_SLACK_MESSAGES[0].ts}] ${MOCK_SLACK_MESSAGES[0].user}: ${MOCK_SLACK_MESSAGES[0].text}`;
    const expectedLine1 = `[${MOCK_SLACK_MESSAGES[1].ts}] ${MOCK_SLACK_MESSAGES[1].user}: ${MOCK_SLACK_MESSAGES[1].text}`;
    if (artifactContent.includes(expectedLine0) && artifactContent.includes(expectedLine1)) {
      pass(`Artifact file written at ${artifactPath} with formatted messages`);
    } else {
      fail('Artifact file missing expected formatted messages', `Content:\n    ${artifactContent}`);
    }
  } catch {
    fail(`Artifact file not written at ${artifactPath}`);
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

  try {
    if (fs.existsSync(artifactPath)) {
      fs.unlinkSync(artifactPath);
    }
  } catch {
    // Best-effort cleanup
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed! ✓');
  console.log('━'.repeat(60) + '\n');

  await app.close();
  if (failed > 0) process.exit(1);
}

testIssueGenerateSlackQuery();
