/**
 * Manual smoke test: verificationPassOffset accumulates across executeBackendAdapter calls
 *
 * Verifies:
 *   1. First backend call in a run receives verificationPassOffset === 0
 *   2. Second backend call receives the offset accumulated from the first call's
 *      verificationPassCount (i.e., offset === 2 when first call returned count 2)
 *   3. A subsequent execute() resets the offset so the next backend call gets 0
 *
 * Run: nr test:manual verification-pass-offset-accumulates.smoke
 */

import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { AnthropicAgentAdapter } from '../../src/integrations/ai/adapters/anthropic-agent.adapter';
import { createReporter, summarise } from './support/reporter';
import type { PlanArtifact, TicketArtifact, ImplementerBackend } from '../../src/agents/interfaces';

const { counts, pass, fail } = createReporter();

const STUB_PASS_COUNT = 2;

const ticket: TicketArtifact = {
  ticketKey: 'SMOKE-OFFSET-1',
  content: '# SMOKE-OFFSET-1\n',
  path: '/tmp/smoke-offset-ticket.md',
};

function buildPlan(): PlanArtifact {
  return {
    action: 'fix',
    path: '/tmp/smoke-offset-plan.json',
    plan: {
      action: 'fix',
      summary: 'Smoke offset',
      steps: ['step 1'],
      estimatedComplexity: 'low',
      affectedFiles: [],
      affectedRepositories: ['repo'],
      risks: [],
    },
  };
}

const options = { trackerName: 'jira' as const, repoDir: '/tmp', silent: true, suppressHeader: true };
const resolved = { repoName: 'repo', repoDir: '/tmp', repoFiles: [], contextFiles: [] };

function stubHelpers(agent: ImplementerAgent): void {
  (agent as any).buildVerificationScripts = () => [];
  (agent as any).alignTrackedFiles = async () => ({ trackedFilePaths: [], repoFiles: [] });
  (agent as any).buildConventionsSection = () => '';
  (agent as any).resolveImplementBackendSelection = () => ({
    selected: 'agent', configured: 'agent', provider: 'anthropic',
  });
  (agent as any).writeRunArtifact = () => {};
  (agent as any).resolveSkillParams = async () => ({});
  (agent as any).stageAgentService = { logResolvedStageTarget: () => {} };
}

function patchBackend(): { capturedOffsets: number[]; restore: () => void } {
  const capturedOffsets: number[] = [];
  const original = AnthropicAgentAdapter.prototype.generateAndVerify;
  AnthropicAgentAdapter.prototype.generateAndVerify = async function (params) {
    capturedOffsets.push((params as Parameters<ImplementerBackend['generateAndVerify']>[0]).verificationPassOffset ?? 0);
    return { sessionId: undefined, verificationOutcomes: [], verificationPassCount: STUB_PASS_COUNT };
  };
  return {
    capturedOffsets,
    restore: () => { AnthropicAgentAdapter.prototype.generateAndVerify = original; },
  };
}

async function callBackendAdapter(agent: ImplementerAgent): Promise<void> {
  await (agent as any).executeBackendAdapter(ticket, buildPlan(), options, resolved);
}

function resetCounters(agent: ImplementerAgent): void {
  (agent as any).resetRunCounters();
}

async function checkAccumulation(agent: ImplementerAgent, capturedOffsets: number[]): Promise<void> {
  resetCounters(agent);
  await callBackendAdapter(agent);
  await callBackendAdapter(agent);
  if (capturedOffsets[0] === 0) {
    pass('first backend call receives verificationPassOffset 0');
  } else {
    fail('expected first call offset to be 0', `got ${capturedOffsets[0]}`);
  }
  if (capturedOffsets[1] === STUB_PASS_COUNT) {
    pass(`second backend call receives accumulated offset ${STUB_PASS_COUNT}`);
  } else {
    fail(`expected second call offset to be ${STUB_PASS_COUNT}`, `got ${capturedOffsets[1]}`);
  }
}

async function checkReset(agent: ImplementerAgent, capturedOffsets: number[]): Promise<void> {
  capturedOffsets.length = 0;
  resetCounters(agent);
  await callBackendAdapter(agent);
  if (capturedOffsets[0] === 0) {
    pass('after reset, first backend call again receives offset 0');
  } else {
    fail('expected offset to reset to 0', `got ${capturedOffsets[0]}`);
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: verificationPassOffset accumulates across backend calls\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const { capturedOffsets, restore } = patchBackend();
  try {
    const agent = app.get(ImplementerAgent);
    stubHelpers(agent);
    await checkAccumulation(agent, capturedOffsets);
    await checkReset(agent, capturedOffsets);
  } finally {
    restore();
    await app.close();
  }
  summarise(counts);
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
