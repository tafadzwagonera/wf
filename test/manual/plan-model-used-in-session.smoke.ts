/**
 * Smoke test: plan stage records modelUsed in session after plan generation
 *
 * Run: nr test:manual plan-model-used-in-session.smoke
 *
 * Verifies that when a plan artifact carries a modelUsed field, executePlanStage
 * calls sessionService.recordStageModels with that model so the session file
 * reflects which model actually ran the plan stage.
 */

import * as crypto from 'node:crypto';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import { SessionService } from '../../src/shared/session/session.service';
import { createReporter, summarise } from './support/reporter';
import type { SessionState } from '../../src/shared/types/session.types';

const { counts, pass, fail } = createReporter();

const PLAN_MODEL_USED = 'claude-opus-5-smoke' as const;

function buildSessionState(ticketKey: string): SessionState {
  return {
    sessionId: crypto.randomUUID(),
    ticketKey,
    toStage: 'commit' as const,
    action: null,
    sourceType: 'ticket' as const,
    customPlanRef: null,
    sourceBranch: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    stages: {},
  };
}

function buildFakePlanArtifact() {
  return {
    plan: {
      action: 'fix',
      summary: 'Smoke plan with model',
      steps: [],
      estimatedComplexity: 'low',
      affectedFiles: [],
      affectedRepositories: [],
    },
    action: 'fix' as const,
    path: '/tmp/smoke-plan-model.md',
    sessionId: 'plan-sid-for-model-test',
    modelUsed: PLAN_MODEL_USED,
  };
}

function buildMinimalCtx(ticketKey: string): Record<string, unknown> {
  return {
    action: 'fix',
    fromStage: 'plan',
    toStage: 'commit',
    options: { silent: true },
    repoBaseDir: process.cwd(),
    repos: [],
    skipExisting: false,
    stagesToRun: ['plan'],
    ticketKey,
    trackerDir: '/tmp',
    trackerName: 'jira',
  };
}

function buildTicketArtifact(ticketKey: string) {
  return { ticketKey, content: `# ${ticketKey}`, path: '/tmp/smoke-ticket.md' };
}

type RecordModelsCall = { stage: string; models: string[] };

async function runScenario(
  command: IssueCommand,
  sessionService: SessionService,
): Promise<RecordModelsCall[]> {
  const ticketKey = `SMOKE-PLAN-MODEL-${Date.now()}`;
  const sessionState = buildSessionState(ticketKey);
  await sessionService.save(sessionState);

  const capturedCalls: RecordModelsCall[] = [];
  const originalRecord = sessionService.recordStageModels.bind(sessionService);
  sessionService.recordStageModels = async (s: SessionState, stage: string, models: string[]) => {
    capturedCalls.push({ stage, models });
    return originalRecord(s, stage, models);
  };

  (command as any).agents = {
    planner: { execute: async () => buildFakePlanArtifact() },
  };
  (command as any).offerPlanChat = async () => {};

  const ctx = buildMinimalCtx(ticketKey);
  await (command as any).executePlanStage(
    buildTicketArtifact(ticketKey),
    'fix',
    ctx,
    sessionState,
  );

  await sessionService.deleteBySessionId(sessionState.sessionId).catch(() => {});
  return capturedCalls;
}

function checkRecordStageModelsCalled(calls: RecordModelsCall[]): void {
  if (calls.length > 0) {
    pass('recordStageModels was called during plan stage execution');
  } else {
    fail('recordStageModels was NOT called — modelUsed not recorded in session');
  }
}

function checkPlanModelRecorded(calls: RecordModelsCall[]): void {
  const planCall = calls.find(c => c.stage === 'plan');
  if (planCall?.models.includes(PLAN_MODEL_USED)) {
    pass(`plan stage records modelUsed '${PLAN_MODEL_USED}' via recordStageModels`);
  } else {
    fail(`plan stage should record modelUsed '${PLAN_MODEL_USED}'`, JSON.stringify(calls));
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: plan modelUsed recorded in session\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const command = app.get(IssueCommand);
    const sessionService = app.get(SessionService);
    const calls = await runScenario(command, sessionService);
    checkRecordStageModelsCalled(calls);
    checkPlanModelRecorded(calls);
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
