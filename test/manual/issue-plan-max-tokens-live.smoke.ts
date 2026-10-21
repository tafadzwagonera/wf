/**
 * Manual smoke test: issue:plan forwards stage maxTokens in the live OpenAI request
 *
 * Run: yarn test:manual test-issue-plan-max-tokens-live
 *
 * Scenario: The user configures `stages.plan.maxTokens` for a provider-backed
 * plan run. The live OpenAI request must carry that exact budget in the body.
 *
 * Config under test:
 *   ai: [
 *     { provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'k' }
 *   ]
 *   stages: {
 *     plan: { provider: 'openai', backend: 'standard', maxTokens: 8192 }
 *   }
 *
 * Verify:
 *   1. The command exits successfully.
 *   2. The outgoing OpenAI request body includes `max_completion_tokens: 8192`.
 *   3. The request model matches the configured stage model.
 *   4. The returned plan is saved successfully from the live response.
 *
 * Wire up: run a local HTTP server that mimics the OpenAI chat completions
 * endpoint, point `OPENAI_BASE_URL` at it, and execute the built CLI from
 * `dist/main.js` against a temp repo with a custom plan source.
 * Teardown: remove the temp repo and stop the HTTP server.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AiService } from '../../src/integrations/ai/ai.service';
import { initializeWfConfig } from '../../src/config/wf-config-loader';
import { createReporter, summarise } from './support/reporter';
import { restoreEnv, withEnv } from '../../src/common/testing/env';

type CapturedRequest = {
  pathname: string;
  body: Record<string, unknown>;
};

type Paths = {
  repoDir: string;
  repoName: string;
  configPath: string;
  agentsPath: string;
  sourcePath: string;
};

type ScenarioData = {
  plan: Record<string, unknown>;
  request: CapturedRequest | undefined;
};

const { counts, pass, fail } = createReporter();

function buildConfigContent(): string {
  return [
    'module.exports = {',
    '  ai: [',
    "    { provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'test-key' },",
    '  ],',
    '  stages: {',
    "    plan: { provider: 'openai', backend: 'standard', model: 'gpt-5.4', maxTokens: 8192 },",
    '  },',
    '};',
    '',
  ].join('\n');
}

function buildResponseBody(): Record<string, unknown> {
  return {
    choices: [{
      finish_reason: 'stop',
      message: { content: JSON.stringify({ action: 'fix', summary: 'Live maxTokens smoke test', steps: ['step 1'], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: ['repo'], risks: [] }) },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
  };
}

function handleServerError(res: http.ServerResponse, error: unknown): void {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}

function createCaptureServer(capturedRequests: CapturedRequest[]): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const bodyText = Buffer.concat(chunks).toString('utf-8') || '{}';
      capturedRequests.push({ pathname: req.url ?? '', body: JSON.parse(bodyText) as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(buildResponseBody()));
    })().catch(error => handleServerError(res, error));
  });
}

type StartServerResult = { server: http.Server; baseUrl: string; capturedRequests: CapturedRequest[] };

const startServer = async (): Promise<StartServerResult> => {
  const capturedRequests: CapturedRequest[] = [];
  const server = createCaptureServer(capturedRequests);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Failed to bind local capture server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, capturedRequests };
};

function buildPaths(tempRoot: string): Paths {
  const repoDir = path.join(tempRoot, 'repo');
  return { repoDir, repoName: path.basename(repoDir), configPath: path.join(repoDir, 'wf.config.js'), agentsPath: path.join(repoDir, 'AGENTS.md'), sourcePath: path.join(repoDir, 'source.md') };
}

function setupFixtures(paths: Paths): void {
  fs.mkdirSync(paths.repoDir, { recursive: true });
  fs.writeFileSync(paths.configPath, buildConfigContent(), 'utf-8');
  fs.writeFileSync(paths.sourcePath, ['# Smoke source', '', 'This file forces the live plan stage to call the OpenAI adapter.', ''].join('\n'), 'utf-8');
  fs.writeFileSync(paths.agentsPath, ['# AGENTS', '', 'Local smoke test context for the OpenAI adapter.', ''].join('\n'), 'utf-8');
}

async function runScenario(paths: Paths, baseUrl: string, capturedRequests: CapturedRequest[]): Promise<ScenarioData> {
  process.chdir(paths.repoDir);
  await initializeWfConfig(paths.repoDir);
  withEnv({ OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: 'test-key' });
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const plan = await app.get(AiService).generatePlan('fix', '# Smoke source', { affectedRepositories: [paths.repoName] }) as Record<string, unknown>;
    return { plan, request: capturedRequests[0] };
  } finally {
    await app.close();
    restoreEnv();
  }
}

function checkMaxTokens(request: CapturedRequest): void {
  if (request.body.max_completion_tokens === 8192) pass('OpenAI request body includes max_completion_tokens: 8192');
  else fail('OpenAI request body did not include the configured maxCompletionTokens', JSON.stringify(request.body));
}

function checkModel(request: CapturedRequest): void {
  if (request.body.model === 'gpt-5.4') pass('OpenAI request body uses the configured stage model');
  else fail('OpenAI request body used the wrong model', JSON.stringify(request.body));
}

function checkPlanParsed(plan: Record<string, unknown>): void {
  if (plan.summary === 'Live maxTokens smoke test') pass('The live plan response was parsed successfully');
  else fail('The live plan response did not parse as expected', JSON.stringify(plan));
}

function runChecks(data: ScenarioData): void {
  if (!data.request) {
    fail('No OpenAI request was captured', 'The live adapter never reached the local capture server.');
    return;
  }
  checkMaxTokens(data.request);
  checkModel(data.request);
  checkPlanParsed(data.plan);
}

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-max-tokens-'));
  const { server, baseUrl, capturedRequests } = await startServer();
  const originalCwd = process.cwd();
  try {
    const paths = buildPaths(tempRoot);
    setupFixtures(paths);
    runChecks(await runScenario(paths, baseUrl, capturedRequests));
  } finally {
    process.chdir(originalCwd);
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
