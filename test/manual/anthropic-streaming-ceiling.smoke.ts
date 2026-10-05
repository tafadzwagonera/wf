/**
 * Manual smoke test: AnthropicAdapter uses streaming when max_tokens exceeds 21333
 *
 * Run: nr test:manual anthropic-streaming-ceiling.smoke.ts
 *
 * Scenarios:
 *   1. maxTokens: 128000 (above ceiling) → request body has stream: true
 *   2. maxTokens: 21333 (at ceiling)     → request body does NOT have stream: true
 *   3. maxTokens: 21334 (just above)     → request body has stream: true
 *   4. All three paths return a usable AIResponse with non-empty content
 *
 * Wire up: local HTTP server on 127.0.0.1 with a random port. ANTHROPIC_BASE_URL
 * and ANTHROPIC_API_KEY are set before the NestJS context is created so the
 * Anthropic client picks them up. The server responds with SSE when stream: true
 * is present in the request body, or with a plain JSON message otherwise.
 * Teardown: server closed, env vars restored, temp config dir removed.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AnthropicAdapter } from '../../src/integrations/ai/adapters/anthropic.adapter';
import { initializeWfConfig } from '../../src/config/wf-config-loader';
import type { AIResponse } from '../../src/shared/types/ai.types';
import { createReporter } from './support/reporter';

type CapturedRequest = {
  pathname: string;
  body: Record<string, unknown>;
};

const { counts, pass, fail } = createReporter();

// The Anthropic SSE format requires "event: <type>\ndata: <json>\n\n" for each event.
// The SDK's fromSSEResponse checks sse.event against named event types.
const sseLines = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-opus-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"smoke test response"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
];

const SSE_BODY = sseLines.join('\n');

const NON_STREAMING_BODY = JSON.stringify({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'smoke test response' }],
  model: 'claude-opus-5',
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

async function parseRequestBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const bodyText = Buffer.concat(chunks).toString('utf-8') || '{}';
  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sendRequestError(res: http.ServerResponse, error: unknown): void {
  if (!res.headersSent) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}

const sendStreamingResponse = (res: http.ServerResponse): void => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(SSE_BODY);
  res.end();
};

const sendNonStreamingResponse = (res: http.ServerResponse): void => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(NON_STREAMING_BODY);
};

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  capturedRequests: CapturedRequest[],
): Promise<void> {
  const body = await parseRequestBody(req);
  capturedRequests.push({ pathname: req.url ?? '', body });
  if (body.stream === true) {
    sendStreamingResponse(res);
  } else {
    sendNonStreamingResponse(res);
  }
}

async function startServer(): Promise<{ server: http.Server; baseUrl: string; capturedRequests: CapturedRequest[] }> {
  const capturedRequests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, capturedRequests).catch(error => sendRequestError(res, error));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to bind local capture server');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, capturedRequests };
}

type TestCase = {
  label: string;
  maxTokens: number;
  expectStreaming: boolean;
};

const testCases: TestCase[] = [
  { label: 'maxTokens = 128000 (above ceiling → streaming)', maxTokens: 128000, expectStreaming: true },
  { label: 'maxTokens = 21333 (at ceiling → non-streaming)', maxTokens: 21333, expectStreaming: false },
  { label: 'maxTokens = 21334 (just above ceiling → streaming)', maxTokens: 21334, expectStreaming: true },
];

function buildErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as unknown as Record<string, unknown>;
  const details = JSON.stringify(e['details'] ?? e['cause'] ?? 'none');
  const stack = err.stack?.split('\n').slice(1, 4).join(' | ') ?? '';
  return `${err.name}: ${err.message}\n    details: ${details}\n    stack: ${stack}`;
}

async function executeAdapter(adapter: AnthropicAdapter, tc: TestCase): Promise<AIResponse | null> {
  try {
    return await adapter.execute({
      prompt: 'Hello',
      systemPrompt: 'You are a test assistant.',
      maxTokens: tc.maxTokens,
    });
  } catch (err) {
    fail('execute() threw unexpectedly', buildErrorDetail(err));
    return null;
  }
}

const buildStreamCheckMessage = (
  expectStreaming: boolean,
  isError: boolean,
): string => {
  if (isError) {
    return expectStreaming
      ? 'Expected stream: true in request body'
      : 'Expected no stream: true in request body';
  }
  return expectStreaming
    ? 'Request body has stream: true'
    : 'Request body does NOT have stream: true (non-streaming path)';
};

const checkStreamFlag = (
  expectStreaming: boolean,
  actualStream: boolean,
  body: Record<string, unknown>,
): boolean => {
  if (expectStreaming === actualStream) {
    pass(buildStreamCheckMessage(expectStreaming, false));
    return true;
  }
  fail(buildStreamCheckMessage(expectStreaming, true), JSON.stringify(body));
  return false;
};

function assertStreaming(captured: CapturedRequest, tc: TestCase): boolean {
  return checkStreamFlag(tc.expectStreaming, captured.body.stream === true, captured.body);
}

function assertContent(result: AIResponse): boolean {
  if (result.content && result.content.length > 0) {
    pass(`execute() returned non-empty content: "${result.content.slice(0, 40)}"`);
    return true;
  }
  fail('execute() returned empty or missing content', JSON.stringify(result));
  return false;
}

async function runCase(adapter: AnthropicAdapter, capturedRequests: CapturedRequest[], tc: TestCase): Promise<boolean> {
  console.log(chalk.bold(`\nCase: ${tc.label}`));
  capturedRequests.length = 0;
  const result = await executeAdapter(adapter, tc);
  if (result === null) return false;
  const captured = capturedRequests[0];
  if (!captured) {
    fail('No HTTP request was captured by the local server');
    return false;
  }
  const streamOk = assertStreaming(captured, tc);
  const contentOk = assertContent(result);
  return streamOk && contentOk;
}

function formatFatalError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return `${err.name}: ${err.message}\n${err.stack ?? ''}`;
}

function restoreEnvVar(key: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}

function setupTempRepo(repoDir: string, configPath: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    [
      'module.exports = {',
      '  ai: [',
      "    { provider: 'anthropic', model: 'claude-opus-5', default: true, apiKey: 'test-key' },",
      '  ],',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function runTests(adapter: AnthropicAdapter, capturedRequests: CapturedRequest[]): Promise<number> {
  let exitCode = 0;
  for (const tc of testCases) {
    const passed = await runCase(adapter, capturedRequests, tc);
    if (!passed) exitCode = 1;
  }
  console.log('');
  if (exitCode === 0) {
    console.log(chalk.bold.green('All cases passed.'));
  } else {
    console.log(chalk.bold.red('One or more cases failed.'));
  }
  return exitCode;
}

function teardownSmoke(originalCwd: string, server: http.Server, tempRoot: string, exitCode: number): void {
  process.chdir(originalCwd);
  server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  process.exit(exitCode);
}

type EnvSnapshot = { origBaseUrl: string | undefined; origApiKey: string | undefined };

async function setupEnvAndConfig(repoDir: string, baseUrl: string): Promise<EnvSnapshot> {
  process.chdir(repoDir);
  await initializeWfConfig(repoDir);
  const origBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const origApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  return { origBaseUrl, origApiKey };
}

async function runWithApp(repoDir: string, baseUrl: string, capturedRequests: CapturedRequest[]): Promise<number> {
  const { origBaseUrl, origApiKey } = await setupEnvAndConfig(repoDir, baseUrl);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    return await runTests(app.get(AnthropicAdapter), capturedRequests);
  } finally {
    await app.close();
    restoreEnvVar('ANTHROPIC_BASE_URL', origBaseUrl);
    restoreEnvVar('ANTHROPIC_API_KEY', origApiKey);
  }
}

type TestEnvironment = { server: http.Server; baseUrl: string; capturedRequests: CapturedRequest[]; repoDir: string };

async function createTestEnvironment(tempRoot: string): Promise<TestEnvironment> {
  const repoDir = path.join(tempRoot, 'repo');
  const configPath = path.join(repoDir, 'wf.config.js');
  const { server, baseUrl, capturedRequests } = await startServer();
  setupTempRepo(repoDir, configPath);
  return { server, baseUrl, capturedRequests, repoDir };
}

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-anthropic-streaming-'));
  const { server, baseUrl, capturedRequests, repoDir } = await createTestEnvironment(tempRoot);
  const originalCwd = process.cwd();
  let exitCode = 0;
  try {
    exitCode = await runWithApp(repoDir, baseUrl, capturedRequests);
  } catch (err) {
    console.error(chalk.red('Fatal error:'), formatFatalError(err));
    exitCode = 1;
  } finally {
    teardownSmoke(originalCwd, server, tempRoot, exitCode);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
