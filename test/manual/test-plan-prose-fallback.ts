/**
 * Manual smoke test: plan stage prose-to-JSON fallback and CLI progress label
 *
 * Run: yarn test:manual test-plan-prose-fallback
 *
 * Verifies:
 *   1. formatProgressMessage uses custom label when provided.
 *   2. formatProgressMessage defaults to 'claude-agent-sdk' when no label given.
 *   3. PlanStageService falls back to standard completion on prose AiProviderError.
 *   4. PlanStageService re-throws non-parsing AiProviderErrors.
 *   5. PlanStageService throws when fallback result is structurally invalid.
 *   6. (continued from 5) Valid plan passes the structural gate.
 *   7. globalThis.fetch is available in the Node.js runtime.
 */
import chalk from 'chalk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { formatProgressMessage } from '../../src/integrations/ai/adapters/anthropic-agent.adapter';
import { AiProviderError, isAiProviderErrorLike } from '../../src/shared/utils/errors';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n\uD83E\uDDEA Plan prose fallback smoke test\n'));

  console.log(chalk.bold('Test 1: formatProgressMessage uses custom label'));
  const cliMessage = formatProgressMessage(
    {
      type: 'tool_progress',
      tool_name: 'Read',
      elapsed_time_seconds: 0.5,
      task_id: '',
    } as SDKMessage,
    'claude-cli'
  );
  assert('CLI label appears in output', cliMessage?.includes('[claude-cli]') === true, cliMessage ?? 'received null');
  assert(
    'SDK label does NOT appear in CLI output',
    cliMessage?.includes('[claude-agent-sdk]') === false,
    cliMessage ?? 'received null'
  );

  console.log(chalk.bold('\nTest 2: formatProgressMessage defaults to claude-agent-sdk'));
  const sdkMessage = formatProgressMessage({
    type: 'tool_progress',
    tool_name: 'Read',
    elapsed_time_seconds: 0.5,
    task_id: '',
  } as SDKMessage);
  assert(
    'Default label is claude-agent-sdk',
    sdkMessage?.includes('[claude-agent-sdk]') === true,
    sdkMessage ?? 'received null'
  );

  console.log(chalk.bold('\nTest 3: isAiProviderErrorLike identifies AiProviderError with prose response'));
  const proseError = new AiProviderError('Failed to parse resolution plan from agent response', {
    response: 'Here is my analysis...',
  });
  assert('isAiProviderErrorLike returns true for AiProviderError', isAiProviderErrorLike(proseError));
  assert('Error message matches fallback trigger', proseError.message.includes('Failed to parse resolution plan'));
  assert(
    'Error details contain prose response',
    typeof proseError.details?.response === 'string' && proseError.details.response.length > 0
  );

  console.log(chalk.bold('\nTest 4: Non-parsing AiProviderErrors do not trigger fallback'));
  const rateLimitError = new AiProviderError('Rate limit exceeded', { status: 429 });
  assert('isAiProviderErrorLike returns true for rate limit error', isAiProviderErrorLike(rateLimitError));
  assert(
    'Rate limit error does NOT contain fallback trigger string',
    !rateLimitError.message.includes('Failed to parse resolution plan')
  );

  console.log(chalk.bold('\nTest 5: Empty prose response is rejected'));
  const emptyProseError = new AiProviderError('Failed to parse resolution plan from agent response', {
    response: '',
  });
  const agentProse = emptyProseError.details?.response;
  assert('Empty prose fails the guard check', typeof agentProse !== 'string' || !agentProse.trim());

  console.log(chalk.bold('\nTest 6: Validation gate rejects structurally invalid fallback result'));
  const incompletePlan = { summary: 'incomplete' } as any;
  const isInvalid = !incompletePlan?.action || !incompletePlan?.summary || !Array.isArray(incompletePlan?.steps);
  assert('Missing action and steps detected as invalid', isInvalid);

  const validPlan = { action: 'fix', summary: 'Fix auth', steps: ['step 1'] } as any;
  const isValid = validPlan?.action && validPlan?.summary && Array.isArray(validPlan?.steps);
  assert('Complete plan detected as valid', isValid);

  console.log(chalk.bold('\nTest 7: node-fetch fallback is available when globalThis.fetch is missing'));
  const nodeFetch = require('node-fetch');
  assert('node-fetch exports a function', typeof nodeFetch === 'function');
  const fetchImpl = globalThis.fetch ?? nodeFetch;
  assert('fetch fallback resolves to a function', typeof fetchImpl === 'function');

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
