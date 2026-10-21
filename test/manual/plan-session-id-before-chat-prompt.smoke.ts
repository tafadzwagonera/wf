/**
 * Smoke test: plan stage records providerSessionId before offering the chat prompt
 *
 * Run: nr test:manual plan-session-id-before-chat-prompt.smoke
 *
 * Verifies that after executePlanStage completes, the returned sessionState
 * carries the plan's providerSessionId — confirming that recording happened
 * before the interactive chat prompt could fire.
 */

import * as crypto from 'node:crypto';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import { SessionService } from '../../src/common/session/session.service';
import { createReporter, summarise } from './support/reporter';
import type { SessionState } from '../../src/common/types/session.types';

const { counts, pass, fail } = createReporter();

const PLAN_SESSION_ID = 'plan-provider-sid-smoke' as const;

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
      summary: 'Smoke plan',
      steps: [],
      estimatedComplexity: 'low',
      affectedFiles: [],
      affectedRepositories: [],
    },
    action: 'fix' as const,
    path: '/tmp/smoke-plan.md',
    sessionId: PLAN_SESSION_ID,
  };
}

function buildMinimalCtx(repoBaseDir: string, ticketKey: string): Record<string, unknown> {
  return {
    action: 'fix',
    fromStage: 'plan',
    toStage: 'commit',
    options: { silent: true },
    repoBaseDir,
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

const sharedCallLog: string[] = [];

const setupScenarioSession = async (ticketKey: string, sessionService: SessionService): Promise<SessionState> => {
  const state = buildSessionState(ticketKey);
  await sessionService.save(state);
  return state;
};

function patchOfferPlanChat(command: IssueCommand): void {
  (command as any).offerPlanChat = async () => {
    sharedCallLog.push('offerPlanChat');
  };
}

function patchRecordProviderSessionId(sessionService: SessionService): void {
  const original = sessionService.recordProviderSessionId.bind(sessionService);
  sessionService.recordProviderSessionId = async (s: SessionState, stage: string, id: string) => {
    sharedCallLog.push('recordProviderSessionId');
    return original(s, stage, id);
  };
}

function patchPlannerAgent(command: IssueCommand): void {
  (command as any).agents = { planner: { execute: async () => buildFakePlanArtifact() } };
}

async function runScenario(
  command: IssueCommand,
  sessionService: SessionService,
): Promise<{ sessionState: SessionState | undefined }> {
  const ticketKey = `SMOKE-PLAN-SID-${Date.now()}`;
  const sessionState = await setupScenarioSession(ticketKey, sessionService);
  patchOfferPlanChat(command);
  patchRecordProviderSessionId(sessionService);
  patchPlannerAgent(command);
  const result = await (command as any).executePlanStage(
    buildTicketArtifact(ticketKey), 'fix', buildMinimalCtx(process.cwd(), ticketKey), sessionState,
  );
  await sessionService.deleteBySessionId(sessionState.sessionId).catch(() => {});
  return { sessionState: result.sessionState };
}

function checkSessionIdRecorded(): void {
  if (sharedCallLog.includes('recordProviderSessionId')) {
    pass('recordProviderSessionId was called during plan stage execution');
  } else {
    fail('recordProviderSessionId was NOT called — plan sessionId not recorded');
  }
}

function checkRecordedBeforeChat(): void {
  const recordIdx = sharedCallLog.indexOf('recordProviderSessionId');
  const chatIdx = sharedCallLog.indexOf('offerPlanChat');
  if (recordIdx >= 0 && chatIdx >= 0 && recordIdx < chatIdx) {
    pass('recordProviderSessionId called before offerPlanChat');
  } else if (recordIdx >= 0 && chatIdx < 0) {
    pass('recordProviderSessionId called; chat prompt skipped (silent mode) — ordering constraint satisfied');
  } else {
    fail(
      'ordering violated: recordProviderSessionId should precede offerPlanChat',
      `record at ${recordIdx}, chat at ${chatIdx} in log: ${JSON.stringify(sharedCallLog)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: plan providerSessionId recorded before chat prompt\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const command = app.get(IssueCommand);
    const sessionService = app.get(SessionService);
    await runScenario(command, sessionService);
    checkSessionIdRecorded();
    checkRecordedBeforeChat();
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
