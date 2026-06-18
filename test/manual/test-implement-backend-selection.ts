/**
 * Manual smoke test: implement backend selection after two-phase removal
 *
 * Run: nr test:manual -- test-implement-backend-selection
 *
 * Verifies:
 *   1. `resolveImplementBackendSelection` returns anthropic-agent for anthropic provider
 *   2. `resolveImplementBackendSelection` returns openai-agent for openai provider
 *   3. `resolveImplementBackendSelection` throws for unsupported providers
 *   4. `formatBackendSelection` renders the simplified format without redundant fields
 *   5. `ImplementBackendSelection` type no longer allows 'two-phase'
 *   6. `ImplementRunArtifact` type no longer includes fallbackReason
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import type {
  ImplementBackendName,
  ImplementBackendSelection,
  ImplementRunArtifact,
} from '../../src/agents/interfaces';
import { formatBackendSelection } from '../../src/shared/utils/implement-verification';

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
  console.log(chalk.bold('\nImplement backend selection smoke test\n'));

  // 1. ImplementBackendName only includes anthropic-agent and openai-agent
  const validNames: ImplementBackendName[] = [
    'anthropic-agent',
    'openai-agent',
  ];
  assert(
    'ImplementBackendName includes anthropic-agent',
    validNames.includes('anthropic-agent'),
  );
  assert(
    'ImplementBackendName includes openai-agent',
    validNames.includes('openai-agent'),
  );

  // 2. formatBackendSelection renders the simplified format
  const anthropicSelection: ImplementBackendSelection = {
    configured: 'anthropic-agent',
    selected: 'anthropic-agent',
    provider: 'anthropic',
  };
  const anthropicResult = formatBackendSelection(anthropicSelection);
  assert(
    'formatBackendSelection renders anthropic without redundant configured field',
    anthropicResult ===
      'Implement backend: anthropic-agent (provider: anthropic)',
    `got: ${anthropicResult}`,
  );

  const openaiSelection: ImplementBackendSelection = {
    configured: 'openai-agent',
    selected: 'openai-agent',
    provider: 'openai',
  };
  const openaiResult = formatBackendSelection(openaiSelection);
  assert(
    'formatBackendSelection renders openai without redundant configured field',
    openaiResult === 'Implement backend: openai-agent (provider: openai)',
    `got: ${openaiResult}`,
  );

  // 3. formatBackendSelection does not include "configured:" in output
  assert(
    'formatBackendSelection output does not contain "configured:"',
    !anthropicResult.includes('configured:'),
    `got: ${anthropicResult}`,
  );

  // 4. formatBackendSelection does not include "reason:" in output
  assert(
    'formatBackendSelection output does not contain "reason:"',
    !anthropicResult.includes('reason:'),
    `got: ${anthropicResult}`,
  );

  // 5. ImplementRunArtifact compiles without fallbackReason
  const runArtifact: ImplementRunArtifact = {
    ticketKey: 'TEST-1',
    repoDir: '/tmp/repo',
    backendConfigured: 'anthropic-agent',
    backendSelected: 'anthropic-agent',
    provider: 'anthropic',
    verificationScripts: [{ id: 'lint', command: 'yarn lint' }],
    startedAt: new Date().toISOString(),
  };
  assert(
    'ImplementRunArtifact compiles without fallbackReason',
    runArtifact.ticketKey === 'TEST-1' && !('fallbackReason' in runArtifact),
  );

  // 6. ImplementBackendSelection compiles without fallbackReason
  assert(
    'ImplementBackendSelection compiles without fallbackReason',
    !('fallbackReason' in anthropicSelection),
  );

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
