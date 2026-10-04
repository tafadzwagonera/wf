/**
 * Smoke test: review stage records providerSessionId before presenting the review
 *
 * Run: nr test:manual review-session-id-before-present.smoke
 *
 * Verifies that recordAndPresentReviewArtifact calls sessionService.recordProviderSessionId
 * before calling persistAndPresentReview, so the session file is up-to-date even if
 * the display step throws.
 */

import * as crypto from 'node:crypto';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import { SessionService } from '../../src/shared/session/session.service';
import { createReporter, summarise } from './support/reporter';
import type { SessionState } from '../../src/shared/types/session.types';
import type { ReviewArtifact } from '../../src/agents/interfaces';

const { counts, pass, fail } = createReporter();

const REVIEW_SESSION_ID = 'review-provider-sid-smoke' as const;

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

function buildReviewArtifact(): ReviewArtifact {
  return {
    review: {
      summary: 'Smoke review',
      issues: [],
      suggestions: [],
      approved: true,
    },
    path: '/tmp/smoke-review.md',
    approved: true,
    sessionId: REVIEW_SESSION_ID,
    modelUsed: 'claude-sonnet-5-smoke',
  };
}

function buildReviewContext(ticketKey: string): Record<string, unknown> {
  return {
    ticketArtifact: { ticketKey, content: `# ${ticketKey}`, path: '/tmp/smoke-ticket.md' },
    planArtifact: undefined,
    options: { silent: true },
    sessionContext: {},
    isMultiRepo: false,
    repos: [],
    ticketKey,
    primaryRepo: undefined,
  };
}

type CallEntry = { name: string; stage?: string; id?: string };

const setupScenarioSession = async (ticketKey: string, sessionService: SessionService): Promise<SessionState> => {
  const state = buildSessionState(ticketKey);
  await sessionService.save(state);
  return state;
};

const patchRecordProviderSessionId = (sessionService: SessionService, callLog: CallEntry[]): void => {
  const original = sessionService.recordProviderSessionId.bind(sessionService);
  sessionService.recordProviderSessionId = async (s: SessionState, stage: string, id: string) => {
    callLog.push({ name: 'recordProviderSessionId', stage, id });
    return original(s, stage, id);
  };
};

const patchReviewCommand = (command: IssueCommand, callLog: CallEntry[]): void => {
  (command as any).persistAndPresentReview = async () => {
    callLog.push({ name: 'persistAndPresentReview' });
  };
  (command as any).agents = { reviewer: { persistArtifact: async () => {} } };
};

async function runScenario(
  command: IssueCommand,
  sessionService: SessionService,
): Promise<CallEntry[]> {
  const ticketKey = `SMOKE-REVIEW-SID-${Date.now()}`;
  const sessionState = await setupScenarioSession(ticketKey, sessionService);
  const callLog: CallEntry[] = [];
  patchRecordProviderSessionId(sessionService, callLog);
  patchReviewCommand(command, callLog);
  await (command as any).recordAndPresentReviewArtifact(
    buildReviewArtifact(), buildReviewContext(ticketKey), sessionState,
  );
  await sessionService.deleteBySessionId(sessionState.sessionId).catch(() => {});
  return callLog;
}

function checkRecordCalled(callLog: CallEntry[]): void {
  const recorded = callLog.find(e => e.name === 'recordProviderSessionId');
  if (recorded?.stage === 'review' && recorded?.id === REVIEW_SESSION_ID) {
    pass(`recordProviderSessionId called with stage='review' and sessionId='${REVIEW_SESSION_ID}'`);
  } else {
    fail('recordProviderSessionId not called with expected review sessionId', JSON.stringify(callLog));
  }
}

function checkOrderBeforePresent(callLog: CallEntry[]): void {
  const recordIdx = callLog.findIndex(e => e.name === 'recordProviderSessionId');
  const presentIdx = callLog.findIndex(e => e.name === 'persistAndPresentReview');
  if (recordIdx >= 0 && presentIdx >= 0 && recordIdx < presentIdx) {
    pass('recordProviderSessionId called before persistAndPresentReview');
  } else if (recordIdx >= 0 && presentIdx < 0) {
    fail('persistAndPresentReview was not reached — check mock wiring', JSON.stringify(callLog));
  } else {
    fail(
      'ordering violated: recording should precede presentation',
      `record at index ${recordIdx}, present at index ${presentIdx}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: review providerSessionId recorded before review presentation\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const command = app.get(IssueCommand);
    const sessionService = app.get(SessionService);
    const callLog = await runScenario(command, sessionService);
    checkRecordCalled(callLog);
    checkOrderBeforePresent(callLog);
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
