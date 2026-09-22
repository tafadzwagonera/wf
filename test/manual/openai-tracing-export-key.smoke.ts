// test/manual/test-openai-tracing-export-key.ts
//
// Smoke test for the OpenAI tracing exporter key fix:
//   1. setTracingExportApiKey is exported from @openai/agents
//   2. Calling it with a string does not throw
//   3. The stage-agent.service and openai-agent.adapter source files
//      contain the setTracingExportApiKey call before OpenAIProvider instantiation
//
// Run: nr test:manual openai-tracing-export-key.smoke.ts

import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const srcRoot = path.resolve(__dirname, '../../src');
const stageAgentSrc = fs.readFileSync(path.join(srcRoot, 'integrations/ai/stage-agent.service.ts'), 'utf-8');
const adapterSrc = fs.readFileSync(path.join(srcRoot, 'integrations/ai/adapters/openai-agent.adapter.ts'), 'utf-8');

function checkExportedFunction(): unknown {
  try {
    const agents = require('@openai/agents');
    const fn = agents.setTracingExportApiKey;
    if (typeof fn === 'function') pass('setTracingExportApiKey is exported from @openai/agents');
    else fail('setTracingExportApiKey is exported from @openai/agents');
    return fn;
  } catch (e) {
    fail('setTracingExportApiKey is exported from @openai/agents', `import failed: ${e}`);
    return undefined;
  }
}

function checkCallableWithString(fn: unknown): void {
  if (typeof fn !== 'function') return;
  try {
    (fn as (key: string) => void)('sk-test-dummy-key');
    pass('calling setTracingExportApiKey with a string does not throw');
  } catch (e) {
    fail('calling setTracingExportApiKey with a string does not throw', String(e));
  }
}

function checkSourceFileImports(): void {
  if (stageAgentSrc.includes('setTracingExportApiKey')) pass('stage-agent.service.ts imports setTracingExportApiKey');
  else fail('stage-agent.service.ts imports setTracingExportApiKey');
  if (adapterSrc.includes('setTracingExportApiKey')) pass('openai-agent.adapter.ts imports setTracingExportApiKey');
  else fail('openai-agent.adapter.ts imports setTracingExportApiKey');
}

function checkCallOrder(source: string, fileName: string): void {
  const callIdx = source.indexOf('setTracingExportApiKey(apiKey)');
  const providerIdx = source.indexOf('new OpenAIProvider(');
  const label = `${fileName}: setTracingExportApiKey(apiKey) appears before new OpenAIProvider`;
  if (callIdx !== -1 && providerIdx !== -1 && callIdx < providerIdx) pass(label);
  else fail(label, callIdx === -1 ? 'setTracingExportApiKey(apiKey) not found' : `call at ${callIdx}, provider at ${providerIdx}`);
}

function checkCallCounts(): void {
  const stageAgentCallCount = (stageAgentSrc.match(/setTracingExportApiKey\(apiKey\)/g) || []).length;
  const adapterCallCount = (adapterSrc.match(/setTracingExportApiKey\(apiKey\)/g) || []).length;
  if (stageAgentCallCount === 2) pass('stage-agent.service.ts has exactly 2 setTracingExportApiKey calls');
  else fail('stage-agent.service.ts has exactly 2 setTracingExportApiKey calls', `found ${stageAgentCallCount}`);
  if (adapterCallCount === 1) pass('openai-agent.adapter.ts has exactly 1 setTracingExportApiKey call');
  else fail('openai-agent.adapter.ts has exactly 1 setTracingExportApiKey call', `found ${adapterCallCount}`);
}

function main(): void {
  console.log(chalk.cyan('\n  setTracingExportApiKey export'));
  const fn = checkExportedFunction();
  checkCallableWithString(fn);
  console.log(chalk.cyan('\n  Source file integration'));
  checkSourceFileImports();
  checkCallOrder(stageAgentSrc, 'stage-agent.service.ts');
  checkCallOrder(adapterSrc, 'openai-agent.adapter.ts');
  checkCallCounts();
  summarise(counts);
}

main();
