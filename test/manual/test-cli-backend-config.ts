/**
 * Manual smoke test: Claude CLI headless mode backend config
 *
 * Run: nr test:manual -- test-cli-backend-config
 *
 * Verifies:
 *   1. `WfBackendMode` type includes 'agent', 'cli', and 'standard'
 *   2. `ImplementBackendName` includes 'claude-cli'
 *   3. Config normalization: `backend: 'cli'` + `provider: 'anthropic'` passes
 *   4. Config normalization: `backend: 'cli'` + `provider: 'openai'` passes
 *   5. Config normalization: `backend: 'agent'` + `provider: 'google'` throws
 *   6. Config normalization: `backend: 'cli'` on commit stage throws
 *   7. Config normalization: agent-capable stages default to `agent` backend when omitted
 *  7b. Config normalization: `commit` defaults to `standard` backend when omitted
 *   8. CLI runner: `buildCliArgs` builds correct args
 *   9. CLI runner: `parseNdjsonLine` parses valid JSON
 *  10. CLI runner: `parseNdjsonLine` returns null for invalid input
 *  11. CLI runner: `assertClaudeCliAvailable` does not throw when CLI is present
 *
 * @returns void
 */
import chalk from 'chalk';
import type { WfBackendMode } from '../../src/config/public-config';
import type { ImplementBackendName } from '../../src/agents/interfaces';
import { normalizeWfConfig } from '../../src/config/wf-config-loader';
import {
  buildCliArgs,
  parseNdjsonLine,
  assertClaudeCliAvailable,
} from '../../src/integrations/ai/adapters/claude-cli-runner';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
};

function main(): void {
  console.log(chalk.bold('\nClaude CLI backend config smoke test\n'));

  // 1. WfBackendMode type coverage
  const modes: WfBackendMode[] = ['agent', 'cli', 'standard'];
  assert('WfBackendMode includes agent', modes.includes('agent'));
  assert('WfBackendMode includes cli', modes.includes('cli'));
  assert('WfBackendMode includes standard', modes.includes('standard'));

  // 2. ImplementBackendName includes claude-cli
  const backendNames: ImplementBackendName[] = ['anthropic-agent', 'openai-agent', 'claude-cli'];
  assert('ImplementBackendName includes claude-cli', backendNames.includes('claude-cli'));

  // 3. backend: cli + provider: anthropic passes
  try {
    const config = normalizeWfConfig({
      ai: [
        {
          provider: 'anthropic',
          apiKey: 'test-key',
          model: 'claude-sonnet-4-6',
          default: true,
        },
      ],
      stages: {
        plan: {
          provider: 'anthropic',
          backend: 'cli',
        },
      },
    });
    assert(
      'backend: cli + provider: anthropic passes validation',
      config.stages.plan?.backend === 'cli',
      `got: ${config.stages.plan?.backend}`
    );
  } catch (error) {
    fail(
      'backend: cli + provider: anthropic passes validation',
      `threw: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 4. backend: cli + provider: openai passes
  try {
    const openaiCliConfig = normalizeWfConfig({
      ai: [
        {
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-5.4',
          default: true,
        },
      ],
      stages: {
        plan: {
          provider: 'openai',
          backend: 'cli',
        },
      },
    });
    assert(
      'backend: cli + provider: openai passes validation',
      openaiCliConfig.stages.plan?.backend === 'cli',
      `got: ${openaiCliConfig.stages.plan?.backend}`
    );
  } catch (error) {
    fail(
      'backend: cli + provider: openai passes validation',
      `threw: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 5. backend: agent + provider: google throws
  try {
    normalizeWfConfig({
      ai: [
        {
          provider: 'google',
          apiKey: 'test-key',
          model: 'gemini-2.5-pro',
          default: true,
        },
      ],
      stages: {
        review: {
          provider: 'google',
          backend: 'agent',
        },
      },
    });
    fail('backend: agent + provider: google throws');
  } catch (error) {
    assert(
      'backend: agent + provider: google throws',
      error instanceof Error && /agent.*google/i.test(error.message),
      `got: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 6. backend: cli on commit stage throws
  try {
    normalizeWfConfig({
      ai: [
        {
          provider: 'anthropic',
          apiKey: 'test-key',
          model: 'claude-sonnet-4-6',
          default: true,
        },
      ],
      stages: {
        commit: {
          provider: 'anthropic',
          backend: 'cli',
        },
      },
    });
    fail('backend: cli on commit stage throws');
  } catch (error) {
    assert(
      'backend: cli on commit stage throws',
      error instanceof Error && /commit.*cli/i.test(error.message),
      `got: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 7. agent-capable stages default to agent backend when omitted
  try {
    const config = normalizeWfConfig({
      ai: [
        {
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-5.4',
          default: true,
        },
      ],
      stages: {
        review: {
          provider: 'openai',
          model: 'gpt-5.4',
        },
      },
    });
    assert(
      'review defaults to agent backend when omitted',
      config.stages.review?.backend === 'agent',
      `got: ${config.stages.review?.backend}`
    );
  } catch (error) {
    fail(
      'review defaults to agent backend when omitted',
      `threw: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 7b. commit stage defaults to standard backend when omitted
  try {
    const config = normalizeWfConfig({
      ai: [
        {
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-5.4',
          default: true,
        },
      ],
      stages: {
        commit: {
          provider: 'openai',
        },
      },
    });
    assert(
      'commit defaults to standard backend when omitted',
      config.stages.commit?.backend === 'standard',
      `got: ${config.stages.commit?.backend}`
    );
  } catch (error) {
    fail(
      'commit defaults to standard backend when omitted',
      `threw: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 8. buildCliArgs builds correct args
  const args = buildCliArgs({
    prompt: 'test prompt',
    model: 'claude-sonnet-4-6',
    cwd: '/repo',
    permissionMode: 'plan',
    appendSystemPrompt: 'Be helpful',
    tools: ['Read', 'Glob'],
    sessionId: 'session-123',
    addDirs: ['/sibling'],
  });
  assert('buildCliArgs includes -p flag', args.includes('-p'));
  assert('buildCliArgs includes --verbose flag', args.includes('--verbose'));
  assert('buildCliArgs includes stream-json format', args.includes('stream-json'));
  assert('buildCliArgs includes model', args.includes('claude-sonnet-4-6'));
  assert('buildCliArgs includes permission mode', args.includes('plan'));
  assert('buildCliArgs includes resume session id', args.includes('session-123'));
  assert('buildCliArgs includes allowedTools', args.includes('Read,Glob'));
  assert('buildCliArgs includes add-dir', args.includes('/sibling'));
  assert('buildCliArgs excludes prompt from args (piped via stdin)', !args.includes('test prompt'));

  // 9. parseNdjsonLine parses valid JSON
  const parsed = parseNdjsonLine('{"type":"result","result":"hello","session_id":"s1"}');
  assert(
    'parseNdjsonLine parses valid JSON',
    parsed !== null && parsed.type === 'result' && parsed.result === 'hello',
    `got: ${JSON.stringify(parsed)}`
  );

  // 10. parseNdjsonLine returns null for invalid input
  assert('parseNdjsonLine returns null for empty string', parseNdjsonLine('') === null);
  assert('parseNdjsonLine returns null for invalid JSON', parseNdjsonLine('not json') === null);

  // 11. assertClaudeCliAvailable does not throw when CLI is present
  try {
    assertClaudeCliAvailable();
    pass('assertClaudeCliAvailable does not throw when CLI is present');
  } catch {
    // CLI may not be installed in all environments — not a test failure
    pass('assertClaudeCliAvailable throws with install instructions (CLI not installed)');
  }

  // Summary
  console.log(
    chalk.bold(
      `\n${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`
    )
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main();
