/**
 * Manual smoke test: AnthropicAdapter uses streaming when max_tokens exceeds 21333
 *
 * Run: nr test:manual -- test-anthropic-streaming-ceiling
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
import type { AIResponse } from '../../src/integrations/ai/ai.service';
import { createReporter } from './support/reporter';

type CapturedRequest = {
  pathname: string;
  body: Record<string, unknown>;
};

const { counts, pass, fail } = createReporter();

// The Anthropic SSE format requires "event: <type>\ndata: <json>\n\n" for each event.
// The SDK's fromSSEResponse checks sse.event against named event types.
const SSE_LINES = [
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

const SSE_BODY = SSE_LINES.join('\n');

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

const startServer = async (): Promise<{
  server: http.Server;
  baseUrl: string;
  capturedRequests: CapturedRequest[];
}> => {
  const capturedRequests: CapturedRequest[] = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }

      const bodyText = Buffer.concat(chunks).toString('utf-8') || '{}';
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        body = {};
      }

      capturedRequests.push({ pathname: req.url ?? '', body });

      if (body.stream === true) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(SSE_BODY);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(NON_STREAMING_BODY);
      }
    })().catch(error => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to bind local capture server');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    capturedRequests,
  };
};

type TestCase = {
  label: string;
  maxTokens: number;
  expectStreaming: boolean;
};

const TEST_CASES: TestCase[] = [
  { label: 'maxTokens = 128000 (above ceiling → streaming)', maxTokens: 128000, expectStreaming: true },
  { label: 'maxTokens = 21333 (at ceiling → non-streaming)', maxTokens: 21333, expectStreaming: false },
  { label: 'maxTokens = 21334 (just above ceiling → streaming)', maxTokens: 21334, expectStreaming: true },
];

async function runCase(
  adapter: AnthropicAdapter,
  capturedRequests: CapturedRequest[],
  tc: TestCase
): Promise<boolean> {
  console.log(chalk.bold(`\nCase: ${tc.label}`));
  capturedRequests.length = 0;

  let result: AIResponse;
  try {
    result = await adapter.execute({
      prompt: 'Hello',
      systemPrompt: 'You are a test assistant.',
      maxTokens: tc.maxTokens,
    });
  } catch (err) {
    const e = err as unknown as Record<string, unknown>;
    const detail = err instanceof Error
      ? `${err.name}: ${err.message}\n    details: ${JSON.stringify(e['details'] ?? e['cause'] ?? 'none')}\n    stack: ${err.stack?.split('\n').slice(1, 4).join(' | ') ?? ''}`
      : String(err);
    fail('execute() threw unexpectedly', detail);
    return false;
  }

  let ok = true;
  const captured = capturedRequests[0];

  if (!captured) {
    fail('No HTTP request was captured by the local server');
    return false;
  }

  // Streaming assertion
  if (tc.expectStreaming) {
    if (captured.body.stream === true) {
      pass('Request body has stream: true');
    } else {
      fail('Expected stream: true in request body', JSON.stringify(captured.body));
      ok = false;
    }
  } else {
    if (captured.body.stream !== true) {
      pass('Request body does NOT have stream: true (non-streaming path)');
    } else {
      fail('Expected no stream: true in request body', JSON.stringify(captured.body));
      ok = false;
    }
  }

  // Content assertion
  if (result.content && result.content.length > 0) {
    pass(`execute() returned non-empty content: "${result.content.slice(0, 40)}"`);
  } else {
    fail('execute() returned empty or missing content', JSON.stringify(result));
    ok = false;
  }

  return ok;
}

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-anthropic-streaming-'));
  const repoDir = path.join(tempRoot, 'repo');
  const configPath = path.join(repoDir, 'wf.config.js');
  const { server, baseUrl, capturedRequests } = await startServer();
  const originalCwd = process.cwd();
  let exitCode = 0;

  try {
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
      'utf-8'
    );

    process.chdir(repoDir);
    await initializeWfConfig(repoDir);

    const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

    try {
      const adapter = app.get(AnthropicAdapter);

      for (const tc of TEST_CASES) {
        const passed = await runCase(adapter, capturedRequests, tc);
        if (!passed) exitCode = 1;
      }

      console.log('');
      if (exitCode === 0) {
        console.log(chalk.bold.green('All cases passed.'));
      } else {
        console.log(chalk.bold.red('One or more cases failed.'));
      }
    } finally {
      await app.close();
      if (originalAnthropicBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
      }
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
      }
    }
  } catch (err) {
    console.error(chalk.red('Fatal error:'), err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err));
    exitCode = 1;
  } finally {
    process.chdir(originalCwd);
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    process.exit(exitCode);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
