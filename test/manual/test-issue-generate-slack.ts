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

import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { SlackService } from '../../src/integrations/slack/slack.service';

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

async function testIssueGenerateSlack() {
  console.log('\n🧪 Manual Test: issue:generate with Slack thread permalink\n');

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

  // Mock SlackService.fetchThread
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

  // Mock AiService.execute
  const originalExecute = AiService.prototype.execute;
  let aiCallCount = 0;
  (AiService.prototype as any).execute = async () => {
    aiCallCount++;
    return { content: MOCK_AI_RESPONSE };
  };

  // Capture stdout
  let capturedOutput = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any, ...args: any[]) => {
    capturedOutput += String(chunk);
    return true;
  };

  // Derive expected artifact path
  const threadId = EXPECTED_THREAD_TS.replace('.', '-');
  const artifactDir = path.join(process.cwd(), '.wf', 'slack');
  const artifactPath = path.join(artifactDir, `slack-thread-${EXPECTED_CHANNEL_ID}-${threadId}.md`);

  const command = app.get(IssueGenerateCommand);

  try {
    await command.run([SLACK_PERMALINK], {} as any);
  } catch (_) {
    // Ignore — assertions are made on side effects
  } finally {
    process.stdout.write = origWrite;
    SlackService.prototype.fetchThread = originalFetchThread;
    AiService.prototype.execute = originalExecute;
  }

  // Assertion 1: SlackService.fetchThread called with correct args
  if (slackFetchCallArgs !== null) {
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
  } else {
    fail('SlackService.fetchThread was NOT called');
  }

  // Assertion 2: Artifact file written and contains formatted messages
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

  // Assertion 3: AiService.execute was called
  if (aiCallCount > 0) {
    pass(`AiService.execute was called (${aiCallCount} time(s))`);
  } else {
    fail('AiService.execute was NOT called — synthesis did not run');
  }

  // Assertion 4: Captured stdout contains "### Summary"
  if (capturedOutput.includes('### Summary')) {
    pass('Output contains "### Summary" section');
  } else {
    fail(
      'Output missing "### Summary" section',
      `Captured output (first 600 chars):\n    ${capturedOutput.slice(0, 600)}`
    );
  }

  // Cleanup
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

testIssueGenerateSlack();
