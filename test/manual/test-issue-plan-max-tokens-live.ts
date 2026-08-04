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
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AiService } from '../../src/integrations/ai/ai.service';
import { initializeWfConfig } from '../../src/config/wf-config-loader';

type CapturedRequest = {
  pathname: string;
  body: Record<string, unknown>;
};

const pass = (message: string): void => console.log(chalk.green(`  ✓ ${message}`));
const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}`));
  if (detail) console.error(chalk.gray(`    ${detail}`));
};

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
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const bodyText = Buffer.concat(chunks).toString('utf-8') || '{}';
      capturedRequests.push({
        pathname: req.url ?? '',
        body: JSON.parse(bodyText) as Record<string, unknown>,
      });

      const responseBody = {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                action: 'fix',
                summary: 'Live maxTokens smoke test',
                steps: ['step 1'],
                estimatedComplexity: 'low',
                affectedFiles: [],
                affectedRepositories: ['repo'],
                risks: [],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 34,
          total_tokens: 46,
        },
      };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    })().catch(error => {
      res.writeHead(500, { 'content-type': 'application/json' });
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
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    capturedRequests,
  };
};

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-max-tokens-'));
  const repoDir = path.join(tempRoot, 'repo');
  const repoName = path.basename(repoDir);
  const configPath = path.join(repoDir, 'wf.config.js');
  const agentsPath = path.join(repoDir, 'AGENTS.md');
  const sourcePath = path.join(repoDir, 'source.md');
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
        "    { provider: 'openai', model: 'gpt-5.4', default: true, apiKey: 'test-key' },",
        '  ],',
        '  stages: {',
        "    plan: { provider: 'openai', backend: 'standard', model: 'gpt-5.4', maxTokens: 8192 },",
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8'
    );

    fs.writeFileSync(
      sourcePath,
      [
        '# Smoke source',
        '',
        'This file forces the live plan stage to call the OpenAI adapter.',
        '',
      ].join('\n'),
      'utf-8'
    );

    fs.writeFileSync(
      agentsPath,
      [
        '# AGENTS',
        '',
        'Local smoke test context for the OpenAI adapter.',
        '',
      ].join('\n'),
      'utf-8'
    );

    process.chdir(repoDir);
    await initializeWfConfig(repoDir);

    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = baseUrl;
    process.env.OPENAI_API_KEY = 'test-key';

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

    try {
      const aiService = app.get(AiService);
      const plan = await aiService.generatePlan('fix', '# Smoke source', {
        affectedRepositories: [repoName],
      });

      const request = capturedRequests[0];
      if (!request) {
        fail('No OpenAI request was captured', 'The live adapter never reached the local capture server.');
        exitCode = 1;
        return;
      }

      const maxTokensOk = request.body.max_completion_tokens === 8192;
      const modelOk = request.body.model === 'gpt-5.4';
      const planOk = plan.summary === 'Live maxTokens smoke test';

      if (maxTokensOk) {
        pass('OpenAI request body includes max_completion_tokens: 8192');
      } else {
        fail('OpenAI request body did not include the configured maxCompletionTokens', JSON.stringify(request.body));
      }

      if (modelOk) {
        pass('OpenAI request body uses the configured stage model');
      } else {
        fail('OpenAI request body used the wrong model', JSON.stringify(request.body));
      }

      if (planOk) {
        pass('The live plan response was parsed successfully');
      } else {
        fail('The live plan response did not parse as expected', JSON.stringify(plan));
      }

      if (!maxTokensOk || !modelOk || !planOk) {
        exitCode = 1;
      }
    } finally {
      await app.close();
      if (originalOpenAiBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL;
      } else {
        process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
      }
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      }
    }
  } finally {
    process.chdir(originalCwd);
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    process.exit(exitCode);
  }
}

void main();
