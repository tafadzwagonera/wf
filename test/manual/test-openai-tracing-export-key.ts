// test/manual/test-openai-tracing-export-key.ts
//
// Smoke test for the OpenAI tracing exporter key fix:
//   1. setTracingExportApiKey is exported from @openai/agents
//   2. Calling it with a string does not throw
//   3. The stage-agent.service and openai-agent.adapter source files
//      contain the setTracingExportApiKey call before OpenAIProvider instantiation
//
// Run: nr test:manual -- test-openai-tracing-export-key

import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean, detail?: string) => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`));
    failed++;
  }
};

// ---------------------------------------------------------------------------
// 1. Verify setTracingExportApiKey is exported and callable
// ---------------------------------------------------------------------------
console.log(chalk.cyan('\n  setTracingExportApiKey export'));

let setTracingExportApiKey: unknown;
try {
  const agents = require('@openai/agents');
  setTracingExportApiKey = agents.setTracingExportApiKey;
  assert(
    'setTracingExportApiKey is exported from @openai/agents',
    typeof setTracingExportApiKey === 'function',
  );
} catch (e) {
  assert(
    'setTracingExportApiKey is exported from @openai/agents',
    false,
    `import failed: ${e}`,
  );
}

if (typeof setTracingExportApiKey === 'function') {
  try {
    (setTracingExportApiKey as (key: string) => void)('sk-test-dummy-key');
    assert('calling setTracingExportApiKey with a string does not throw', true);
  } catch (e) {
    assert(
      'calling setTracingExportApiKey with a string does not throw',
      false,
      String(e),
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Verify source files contain the call before OpenAIProvider instantiation
// ---------------------------------------------------------------------------
console.log(chalk.cyan('\n  Source file integration'));

const srcRoot = path.resolve(__dirname, '../../src');

const stageAgentSrc = fs.readFileSync(
  path.join(srcRoot, 'integrations/ai/stage-agent.service.ts'),
  'utf-8',
);

const adapterSrc = fs.readFileSync(
  path.join(srcRoot, 'integrations/ai/adapters/openai-agent.adapter.ts'),
  'utf-8',
);

// Check import presence
assert(
  'stage-agent.service.ts imports setTracingExportApiKey',
  stageAgentSrc.includes('setTracingExportApiKey'),
);

assert(
  'openai-agent.adapter.ts imports setTracingExportApiKey',
  adapterSrc.includes('setTracingExportApiKey'),
);

// Check that setTracingExportApiKey(apiKey) appears before new OpenAIProvider
// in each file by verifying order of first occurrence
const verifyCallOrder = (source: string, fileName: string) => {
  const callIdx = source.indexOf('setTracingExportApiKey(apiKey)');
  const providerIdx = source.indexOf('new OpenAIProvider(');
  assert(
    `${fileName}: setTracingExportApiKey(apiKey) appears before new OpenAIProvider`,
    callIdx !== -1 && providerIdx !== -1 && callIdx < providerIdx,
    callIdx === -1
      ? 'setTracingExportApiKey(apiKey) not found'
      : `call at ${callIdx}, provider at ${providerIdx}`,
  );
};

verifyCallOrder(stageAgentSrc, 'stage-agent.service.ts');
verifyCallOrder(adapterSrc, 'openai-agent.adapter.ts');

// Check stage-agent has TWO calls (runOpenAiStagePrompt + openAiChatTurn)
const stageAgentCallCount = (
  stageAgentSrc.match(/setTracingExportApiKey\(apiKey\)/g) || []
).length;
assert(
  'stage-agent.service.ts has exactly 2 setTracingExportApiKey calls',
  stageAgentCallCount === 2,
  `found ${stageAgentCallCount}`,
);

// Check adapter has ONE call
const adapterCallCount = (
  adapterSrc.match(/setTracingExportApiKey\(apiKey\)/g) || []
).length;
assert(
  'openai-agent.adapter.ts has exactly 1 setTracingExportApiKey call',
  adapterCallCount === 1,
  `found ${adapterCallCount}`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(
  `\n  ${chalk.bold('Results:')} ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)}\n`,
);

process.exit(failed > 0 ? 1 : 0);
