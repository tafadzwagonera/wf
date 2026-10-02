/**
 * Smoke test: recordProviderSessionId called exactly once in a multi-repo implement run
 *
 * Run: nr test:manual implement-primary-session-id-single-write.smoke
 *
 * Verifies:
 *   1. With two repos, recordProviderSessionId is called exactly once
 *   2. It is called with the primary repo's session ID, not the secondary's
 *   3. The session file reflects the primary session ID after runImplementLoop completes
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

const PRIMARY_REPO = '/tmp/wf-smoke-primary';
const SECONDARY_REPO = '/tmp/wf-smoke-secondary';
const PRIMARY_SESSION_ID = `primary-sess-${crypto.randomUUID().slice(0, 8)}`;
const SECONDARY_SESSION_ID = `secondary-sess-${crypto.randomUUID().slice(0, 8)}`;
const MODEL_USED = 'claude-sonnet-4-6';

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

type RecordCall = { stage: string; sessionId: string };

async function runScenario(
  command: IssueCommand,
  sessionService: SessionService,
): Promise<{ recordCalls: RecordCall[]; finalState: SessionState | undefined }> {
  const ticketKey = `SMOKE-IMPL-SID-${Date.now()}`;
  let sessionState = buildSessionState(ticketKey);
  await sessionService.save(sessionState);

  sessionState = await sessionService.recordStageStart(
    sessionState, 'implement', { provider: 'anthropic', backend: 'agent' }, MODEL_USED,
  );

  const recordCalls: RecordCall[] = [];
  const originalRecord = sessionService.recordProviderSessionId.bind(sessionService);
  sessionService.recordProviderSessionId = async (s: SessionState, stage: string, id: string) => {
    recordCalls.push({ stage, sessionId: id });
    return originalRecord(s, stage, id);
  };

  let executeCallIndex = 0;
  (command as any).executeRepoImplementation = async () => {
    const sessionId = executeCallIndex === 0 ? PRIMARY_SESSION_ID : SECONDARY_SESSION_ID;
    executeCallIndex++;
    return {
      implementerResult: {
        type: 'implementation', hasChanges: true, branchName: null,
        sessionId, verificationOutcomes: [],
      },
      earlyReturn: false,
    };
  };

  const ticketArtifact = { ticketKey, content: `# ${ticketKey}`, path: '/tmp/smoke-ticket.md' };
  const planArtifact = {
    action: 'fix', path: '/tmp/smoke-plan.json', fromCache: false,
    plan: { action: 'fix', summary: 'Smoke', steps: [], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] },
  };

  await (command as any).runImplementLoop(
    ticketArtifact, planArtifact,
    [PRIMARY_REPO, SECONDARY_REPO], { silent: true }, {}, PRIMARY_REPO, sessionState,
  );

  const finalState = await sessionService.load(sessionState.sessionId) ?? undefined;
  await sessionService.deleteBySessionId(sessionState.sessionId).catch(() => {});
  return { recordCalls, finalState };
}

function checkSingleWrite(recordCalls: RecordCall[]): void {
  if (recordCalls.length === 1) {
    pass('recordProviderSessionId called exactly once across two repos');
  } else {
    fail(`expected 1 call, got ${recordCalls.length}`, JSON.stringify(recordCalls));
  }
}

function checkPrimarySessionId(recordCalls: RecordCall[]): void {
  const call = recordCalls[0];
  if (call?.stage === 'implement' && call?.sessionId === PRIMARY_SESSION_ID) {
    pass(`recordProviderSessionId called with primary session ID '${PRIMARY_SESSION_ID}'`);
  } else {
    fail('wrong stage or sessionId in recordProviderSessionId call', JSON.stringify(call));
  }
}

function checkFinalSessionState(finalState: SessionState | undefined): void {
  const implementStage = finalState?.stages?.['implement'];
  if (implementStage?.providerSessionId === PRIMARY_SESSION_ID) {
    pass(`session file contains primary session ID '${PRIMARY_SESSION_ID}' after runImplementLoop`);
  } else {
    fail('session file missing or incorrect providerSessionId', JSON.stringify(implementStage));
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: implement stage records primary session ID exactly once\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const command = app.get(IssueCommand);
    const sessionService = app.get(SessionService);
    const { recordCalls, finalState } = await runScenario(command, sessionService);
    checkSingleWrite(recordCalls);
    checkPrimarySessionId(recordCalls);
    checkFinalSessionState(finalState);
  } finally {
    await app.close();
  }
  summarise(counts);
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
