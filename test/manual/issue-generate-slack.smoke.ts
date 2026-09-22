/**
 * Manual Test: issue:generate with Slack thread permalink source
 *
 * Run: nr test:manual issue-generate-slack.smoke.ts
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

const { counts, pass, fail } = createReporter();

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

function verifySlackFetchArgs(channelId: string, threadTs: string): boolean {
  return channelId === EXPECTED_CHANNEL_ID && threadTs === EXPECTED_THREAD_TS;
}

function verifySlackFetch(slackFetchCallArgs: [string, string] | null): void {
  if (slackFetchCallArgs === null) {
    fail('SlackService.fetchThread was NOT called');
    return;
  }
  const [channelId, threadTs] = slackFetchCallArgs;
  if (verifySlackFetchArgs(channelId, threadTs)) {
    pass(`SlackService.fetchThread called with ('${channelId}', '${threadTs}')`);
  } else {
    fail(
      'SlackService.fetchThread called with wrong args',
      `Expected ('${EXPECTED_CHANNEL_ID}', '${EXPECTED_THREAD_TS}') but got ('${channelId}', '${threadTs}')`
    );
  }
}

function buildExpectedArtifactLines(): [string, string] {
  const line0 = `[${MOCK_SLACK_MESSAGES[0].ts}] ${MOCK_SLACK_MESSAGES[0].user}: ${MOCK_SLACK_MESSAGES[0].text}`;
  const line1 = `[${MOCK_SLACK_MESSAGES[1].ts}] ${MOCK_SLACK_MESSAGES[1].user}: ${MOCK_SLACK_MESSAGES[1].text}`;
  return [line0, line1];
}

function validateArtifactPath(pathStr: string): boolean {
  const threadId = EXPECTED_THREAD_TS.replace('.', '-');
  return pathStr.endsWith(`slack-thread-${EXPECTED_CHANNEL_ID}-${threadId}.md`);
}

function validateArtifactContent(contentStr: string): boolean {
  const [line0, line1] = buildExpectedArtifactLines();
  return contentStr.includes(line0) && contentStr.includes(line1);
}

function verifyArtifactWrite(
  artifactWritePath: string | null,
  artifactWriteContent: string | null
): void {
  const pathStr = artifactWritePath ? String(artifactWritePath) : '';
  const contentStr = artifactWriteContent ? String(artifactWriteContent) : '';
  if (validateArtifactPath(pathStr) && validateArtifactContent(contentStr)) {
    pass(`Artifact write captured at ${artifactWritePath}`);
  } else {
    fail(
      'Artifact write was not captured with expected content',
      `Path: ${pathStr || 'null'}\n    Content:\n    ${contentStr || 'null'}`
    );
  }
}

function verifySynthesis(aiCallCount: number): void {
  if (aiCallCount > 0) {
    pass(`AI synthesis ran (${aiCallCount} call(s))`);
  } else {
    fail('AI synthesis did NOT run — both backends were idle');
  }
}

function verifyOutputContent(capturedOutput: string): void {
  if (capturedOutput.includes('### Summary')) {
    pass('Output contains "### Summary" section');
  } else {
    fail(
      'Output missing "### Summary" section',
      `Captured output (first 600 chars):\n    ${capturedOutput.slice(0, 600)}`
    );
  }
}

interface TestState {
  slackFetchCallArgs: [string, string] | null;
  aiCallCount: number;
  capturedOutput: string;
  artifactWritePath: string | null;
  artifactWriteContent: string | null;
}

interface OriginalMocks {
  originalFetchThread: any;
  originalExecute: any;
  originalGenerateFromPrompt: any;
  origWrite: any;
  originalMkdir: any;
  originalWriteFile: any;
}

function setupSlackMock(state: TestState): any {
  const originalFetchThread = SlackService.prototype.fetchThread;
  (SlackService.prototype as any).fetchThread = async (channelId: string, threadTs: string) => {
    state.slackFetchCallArgs = [channelId, threadTs];
    return { channelId, threadTs, messages: MOCK_SLACK_MESSAGES };
  };
  return originalFetchThread;
}

function setupAiMocks(state: TestState): [any, any] {
  const originalExecute = AiService.prototype.execute;
  const originalGenerateFromPrompt = StageAgentService.prototype.generateFromPrompt;
  (AiService.prototype as any).execute = async () => {
    state.aiCallCount++;
    return { content: MOCK_AI_RESPONSE };
  };
  (StageAgentService.prototype as any).generateFromPrompt = async () => {
    state.aiCallCount++;
    return { content: MOCK_AI_RESPONSE };
  };
  return [originalExecute, originalGenerateFromPrompt];
}

function setupStdoutCapture(state: TestState): any {
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any) => {
    state.capturedOutput += String(chunk);
    return true;
  };
  return origWrite;
}

function setupFsMocks(): [any, any] {
  const originalMkdir = fs.promises.mkdir;
  const originalWriteFile = fs.promises.writeFile;
  (fs.promises as any).mkdir = async () => undefined;
  (fs.promises as any).writeFile = async (filePath: string, content: string) => {
    throw new Error('Should not reach here');
  };
  return [originalMkdir, originalWriteFile];
}

function setupFsWriteMock(state: TestState): void {
  (fs.promises as any).writeFile = async (filePath: string, content: string) => {
    state.artifactWritePath = filePath;
    state.artifactWriteContent = content;
  };
}

function setupMocks(state: TestState): OriginalMocks {
  const originalFetchThread = setupSlackMock(state);
  const [originalExecute, originalGenerateFromPrompt] = setupAiMocks(state);
  const origWrite = setupStdoutCapture(state);
  const [originalMkdir, originalWriteFile] = setupFsMocks();
  setupFsWriteMock(state);
  return {
    originalFetchThread,
    originalExecute,
    originalGenerateFromPrompt,
    origWrite,
    originalMkdir,
    originalWriteFile,
  };
}

function restoreMocks(originals: OriginalMocks): void {
  process.stdout.write = originals.origWrite;
  SlackService.prototype.fetchThread = originals.originalFetchThread;
  AiService.prototype.execute = originals.originalExecute;
  StageAgentService.prototype.generateFromPrompt = originals.originalGenerateFromPrompt;
  fs.promises.mkdir = originals.originalMkdir;
  fs.promises.writeFile = originals.originalWriteFile;
}

function runVerifications(state: TestState): void {
  verifySlackFetch(state.slackFetchCallArgs);
  verifyArtifactWrite(state.artifactWritePath, state.artifactWriteContent);
  verifySynthesis(state.aiCallCount);
  verifyOutputContent(state.capturedOutput);
}

function printResults(): void {
  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ${counts.passed} passed   ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed! ✓');
  console.log('━'.repeat(60) + '\n');
}

function createTestState(): TestState {
  return {
    slackFetchCallArgs: null,
    aiCallCount: 0,
    capturedOutput: '',
    artifactWritePath: null,
    artifactWriteContent: null,
  };
}

async function runTestWithMocks(state: TestState, command: IssueGenerateCommand): Promise<void> {
  const originals = setupMocks(state);
  try {
    await command.run([SLACK_PERMALINK], {} as any);
  } catch {
    // Ignore
  } finally {
    restoreMocks(originals);
  }
}

async function main(): Promise<void> {
  console.log('\n🧪 Manual Test: issue:generate with Slack thread permalink\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const state = createTestState();
  const command = app.get(IssueGenerateCommand);

  await runTestWithMocks(state, command);

  runVerifications(state);
  printResults();

  await app.close();
  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
