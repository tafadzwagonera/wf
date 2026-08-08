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

interface TestCounter { passed: number; failed: number }

const pass = (counter: TestCounter, msg: string) => {
  console.log(`  ✔ ${msg}`);
  counter.passed++;
};

const fail = (counter: TestCounter, msg: string, detail?: string) => {
  console.error(`  ✗ ${msg}${detail ? `\n    → ${detail}` : ''}`);
  counter.failed++;
};

function assertSlackFetchArgs(
  counter: TestCounter, callArgs: [string, string] | null
): void {
  if (callArgs === null) return fail(counter, 'SlackService.fetchThread was NOT called');
  const [channelId, threadTs] = callArgs;
  if (channelId === EXPECTED_CHANNEL_ID && threadTs === EXPECTED_THREAD_TS) {
    return pass(counter, `SlackService.fetchThread called with ('${channelId}', '${threadTs}')`);
  }
  fail(
    counter, 'SlackService.fetchThread called with wrong args',
    `Expected ('${EXPECTED_CHANNEL_ID}', '${EXPECTED_THREAD_TS}') but got ('${channelId}', '${threadTs}')`
  );
}

function assertArtifactWritten(counter: TestCounter, artifactPath: string): void {
  try {
    const content = fs.readFileSync(artifactPath, 'utf-8');
    const expectedLine0 = `[${MOCK_SLACK_MESSAGES[0].ts}] ${MOCK_SLACK_MESSAGES[0].user}: ${MOCK_SLACK_MESSAGES[0].text}`;
    const expectedLine1 = `[${MOCK_SLACK_MESSAGES[1].ts}] ${MOCK_SLACK_MESSAGES[1].user}: ${MOCK_SLACK_MESSAGES[1].text}`;
    if (content.includes(expectedLine0) && content.includes(expectedLine1)) {
      return pass(counter, `Artifact file written at ${artifactPath} with formatted messages`);
    }
    fail(counter, 'Artifact file missing expected formatted messages', `Content:\n    ${content}`);
  } catch {
    fail(counter, `Artifact file not written at ${artifactPath}`);
  }
}

function assertOutputContainsSummary(counter: TestCounter, output: string): void {
  if (output.includes('### Summary')) return pass(counter, 'Output contains "### Summary" section');
  fail(counter, 'Output missing "### Summary" section', `Captured output (first 600 chars):\n    ${output.slice(0, 600)}`);
}

function mockSlackService() {
  let callArgs: [string, string] | null = null;
  const original = SlackService.prototype.fetchThread.bind(SlackService.prototype);
  (SlackService.prototype as any).fetchThread = async (channelId: string, threadTs: string) => {
    callArgs = [channelId, threadTs];
    return { channelId, threadTs, messages: MOCK_SLACK_MESSAGES };
  };
  const restore = () => {
    SlackService.prototype.fetchThread = original;
  };
  return { getCallArgs: () => callArgs, restore };
}

function mockAiService() {
  let callCount = 0;
  const original = AiService.prototype.execute.bind(AiService.prototype);
  (AiService.prototype as any).execute = async () => {
    callCount++;
    return { content: MOCK_AI_RESPONSE };
  };
  const restore = () => {
    AiService.prototype.execute = original;
  };
  return { getCallCount: () => callCount, restore };
}

function captureStdout() {
  let output = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any) => {
    output += String(chunk);
    return true;
  };
  const restore = () => {
    process.stdout.write = origWrite;
  };
  return { getOutput: () => output, restore };
}

function buildArtifactPath(): string {
  const threadId = EXPECTED_THREAD_TS.replace('.', '-');
  return path.join(
    getWfHomeDir(), path.basename(process.cwd()),
    'slack', `slack-thread-${EXPECTED_CHANNEL_ID}-${threadId}.md`
  );
}

function printResults(counter: TestCounter): void {
  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ${counter.passed} passed   ${counter.failed} failed`);
  if (counter.failed === 0) console.log('All tests passed! ✔');
  console.log('━'.repeat(60) + '\n');
}

function runAssertions(
  counter: TestCounter, slack: ReturnType<typeof mockSlackService>,
  ai: ReturnType<typeof mockAiService>, stdout: ReturnType<typeof captureStdout>,
  artifactPath: string
): void {
  assertSlackFetchArgs(counter, slack.getCallArgs());
  assertArtifactWritten(counter, artifactPath);
  if (ai.getCallCount() > 0) pass(counter, `AiService.execute was called (${ai.getCallCount()} time(s))`);
  else fail(counter, 'AiService.execute was NOT called — synthesis did not run');
  assertOutputContainsSummary(counter, stdout.getOutput());
}

function cleanup(artifactPath: string): void {
  try {
    fs.unlinkSync(artifactPath);
  } catch { /* best-effort */ }
}

async function executeCommand(app: any, mocks: { restore: () => void }[]) {
  try {
    await app.get(IssueGenerateCommand).run([SLACK_PERMALINK], {} as any);
  } catch { /* assertions on side effects */ } finally {
    for (const m of mocks) m.restore();
  }
}

async function testIssueGenerateSlackQuery() {
  console.log('\n🧪 Manual Test: issue:generate with Slack thread permalink query params\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const counter: TestCounter = { passed: 0, failed: 0 };
  const slack = mockSlackService();
  const ai = mockAiService();
  const stdout = captureStdout();

  await executeCommand(app, [slack, ai, stdout]);
  const artifactPath = buildArtifactPath();
  runAssertions(counter, slack, ai, stdout, artifactPath);
  cleanup(artifactPath);
  printResults(counter);
  await app.close();
  if (counter.failed > 0) process.exit(1);
}

testIssueGenerateSlackQuery();
