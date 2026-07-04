/**
 * Manual smoke test: CLI review resume epilogue behavior
 *
 * Run: nr test:manual -- test-review-cli-resume-epilogue
 *
 * Verifies:
 *   1. Codex CLI review sends a second epilogue turn on the same session ID.
 *   2. Codex CLI epilogue uses the bounded timeout.
 *   3. Claude Code CLI review sends a second epilogue turn on the same session ID.
 *   4. Claude Code CLI epilogue reuses the same review CLI envelope as the main turn.
 *   5. Claude Code CLI epilogue uses the bounded timeout.
 */

import chalk from 'chalk';
import type { ConfigService } from '@nestjs/config';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';
import * as claudeCliRunner from '../../src/integrations/ai/adapters/claude-cli-runner';
import * as codexCliRunner from '../../src/integrations/ai/adapters/codex-cli-runner';

type ClaudeBuildParams = {
  prompt: string;
  appendSystemPrompt?: string;
  model: string;
  sessionId?: string;
  cwd: string;
  tools?: string[];
  permissionMode?: 'plan' | 'acceptEdits';
  jsonSchema?: string;
};

type CodexBuildParams = {
  prompt: string;
  model: string;
  sessionId?: string;
  cwd: string;
};

const validReviewJson = JSON.stringify({
  summary: 'Looks good overall',
  issues: [],
  suggestions: ['Add unit tests'],
  approved: true,
});

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    -> ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }

  fail(message, detail);
};

const createClaudeCliReviewConfigService = (): ConfigService =>
  ({
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'stages.review.backend': 'cli',
        'stages.review.provider': 'anthropic',
        'stages.review.model': 'claude-sonnet-4-5-20250514',
        'ai.provider': 'anthropic',
        'ai.model': 'claude-sonnet-4-5-20250514',
      };

      return key in values ? values[key] : defaultValue;
    },
  }) as unknown as ConfigService;

const createCodexReviewConfigService = (): ConfigService =>
  ({
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'stages.review.backend': 'cli',
        'stages.review.provider': 'openai',
        'stages.review.model': 'gpt-5.4-mini',
        'ai.provider': 'openai',
        'ai.model': 'gpt-5.4-mini',
      };

      return key in values ? values[key] : defaultValue;
    },
  }) as unknown as ConfigService;

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 CLI review resume epilogue smoke test\n'));

  const originalClaudeAssert = claudeCliRunner.assertClaudeCliAvailable;
  const originalClaudeBuild = claudeCliRunner.buildCliArgs;
  const originalClaudeSpawn = claudeCliRunner.spawnCli;
  const originalCodexAssert = codexCliRunner.assertCodexCliAvailable;
  const originalCodexBuild = codexCliRunner.buildCodexCliArgs;
  const originalCodexSpawn = codexCliRunner.spawnCodex;
  const originalLog = console.log;

  try {
    const claudeBuildCalls: ClaudeBuildParams[] = [];
    const claudeSpawnCalls: Array<{ prompt?: string; timeoutMs?: number }> = [];
    const codexBuildCalls: CodexBuildParams[] = [];
    const codexSpawnCalls: Array<{ prompt?: string; timeoutMs?: number }> = [];

    (claudeCliRunner as Record<string, unknown>).assertClaudeCliAvailable = () => undefined;
    (codexCliRunner as Record<string, unknown>).assertCodexCliAvailable = () => undefined;

    (claudeCliRunner as Record<string, unknown>).buildCliArgs = (params: ClaudeBuildParams) => {
      claudeBuildCalls.push(params);
      return ['claude'];
    };
    (codexCliRunner as Record<string, unknown>).buildCodexCliArgs = (params: CodexBuildParams) => {
      codexBuildCalls.push(params);
      return ['codex'];
    };

    (claudeCliRunner as Record<string, unknown>).spawnCli = async function* (
      _args: string[],
      _cwd: string,
      prompt?: string,
      _env?: Record<string, string>,
      timeoutMs?: number
    ) {
      claudeSpawnCalls.push({ prompt, timeoutMs });
      if (claudeSpawnCalls.length === 1) {
        yield {
          type: 'result',
          subtype: 'success',
          result: validReviewJson,
          session_id: 'claude-review-session-42',
        };
        return;
      }

      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Approved with one follow-up suggestion.' }],
        },
      };
    };

    (codexCliRunner as Record<string, unknown>).spawnCodex = async function* (
      _args: string[],
      _cwd: string,
      prompt?: string,
      _env?: Record<string, string>,
      timeoutMs?: number
    ) {
      codexSpawnCalls.push({ prompt, timeoutMs });
      if (codexSpawnCalls.length === 1) {
        yield { type: 'thread.started', thread_id: 'review-session-42' };
        yield {
          type: 'item.completed',
          item: { type: 'agent_message', text: validReviewJson },
        };
        return;
      }

      yield {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Approved. No major issues found.' },
      };
    };

    console.log = () => undefined;

    const claudeService = new StageAgentService(createClaudeCliReviewConfigService());
    const codexService = new StageAgentService(createCodexReviewConfigService());
    const priorStageSummary = 'Prior summary';
    const repoDir = '/tmp/repo';

    const claudeResult = await claudeService.reviewCode('diff --git a/a b/a', [], repoDir, priorStageSummary);
    const codexResult = await codexService.reviewCode('diff --git a/a b/a', [], repoDir, priorStageSummary);

    assert(
      'Claude review returns the provider session ID',
      claudeResult.sessionId === 'claude-review-session-42',
      `got: ${claudeResult.sessionId}`
    );
    assert(
      'Codex review returns the provider session ID',
      codexResult.sessionId === 'review-session-42',
      `got: ${codexResult.sessionId}`
    );

    const claudeReviewCall = claudeBuildCalls[0];
    const claudeEpilogueCall = claudeBuildCalls[1];

    assert(
      'Claude review path built two CLI calls',
      claudeBuildCalls.length === 2,
      `calls: ${claudeBuildCalls.length}`
    );
    assert(
      'Claude epilogue reuses the review system prompt envelope',
      claudeEpilogueCall?.appendSystemPrompt === claudeReviewCall?.appendSystemPrompt,
      `review: ${claudeReviewCall?.appendSystemPrompt}\nepilogue: ${claudeEpilogueCall?.appendSystemPrompt}`
    );
    assert(
      'Claude epilogue reuses the review tool allowlist',
      JSON.stringify(claudeEpilogueCall?.tools) === JSON.stringify(claudeReviewCall?.tools),
      `review: ${JSON.stringify(claudeReviewCall?.tools)} epilogue: ${JSON.stringify(claudeEpilogueCall?.tools)}`
    );
    assert(
      'Claude epilogue reuses review permission mode',
      claudeEpilogueCall?.permissionMode === 'plan',
      `got: ${claudeEpilogueCall?.permissionMode}`
    );
    assert(
      'Claude epilogue targets the resumed provider session',
      claudeEpilogueCall?.sessionId === 'claude-review-session-42',
      `got: ${claudeEpilogueCall?.sessionId}`
    );
    assert(
      'Claude epilogue uses the bounded timeout',
      claudeSpawnCalls[1]?.timeoutMs === 5000,
      `got: ${claudeSpawnCalls[1]?.timeoutMs}`
    );

    const codexEpilogueCall = codexBuildCalls[1];
    assert('Codex review path built two CLI calls', codexBuildCalls.length === 2, `calls: ${codexBuildCalls.length}`);
    assert(
      'Codex epilogue targets the resumed provider session',
      codexEpilogueCall?.sessionId === 'review-session-42',
      `got: ${codexEpilogueCall?.sessionId}`
    );
    assert(
      'Codex epilogue uses the bounded timeout',
      codexSpawnCalls[1]?.timeoutMs === 5000,
      `got: ${codexSpawnCalls[1]?.timeoutMs}`
    );
  } finally {
    console.log = originalLog;
    (claudeCliRunner as Record<string, unknown>).assertClaudeCliAvailable = originalClaudeAssert;
    (claudeCliRunner as Record<string, unknown>).buildCliArgs = originalClaudeBuild;
    (claudeCliRunner as Record<string, unknown>).spawnCli = originalClaudeSpawn;
    (codexCliRunner as Record<string, unknown>).assertCodexCliAvailable = originalCodexAssert;
    (codexCliRunner as Record<string, unknown>).buildCodexCliArgs = originalCodexBuild;
    (codexCliRunner as Record<string, unknown>).spawnCodex = originalCodexSpawn;
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
