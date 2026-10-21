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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommand } from '../../src/commands/issue.command';
import { SessionService } from '../../src/common/session/session.service';
import { createReporter, summarise } from './support/reporter';
import type { SessionState } from '../../src/common/types/session.types';

const { counts, pass, fail } = createReporter();

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-smoke-impl-sid-'));
const PRIMARY_REPO = path.join(smokeRoot, 'primary');
const SECONDARY_REPO = path.join(smokeRoot, 'secondary');
fs.mkdirSync(PRIMARY_REPO);
fs.mkdirSync(SECONDARY_REPO);
const primarySessionId = `primary-sess-${crypto.randomUUID().slice(0, 8)}`;
const secondarySessionId = `secondary-sess-${crypto.randomUUID().slice(0, 8)}`;
const MODEL_USED = 'claude-sonnet-4-6' as const;

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

const setupSession = async (ticketKey: string, sessionService: SessionService): Promise<SessionState> => {
  const state = buildSessionState(ticketKey);
  await sessionService.save(state);
  return sessionService.recordStageStart(
    state, 'implement', { provider: 'anthropic', backend: 'agent' }, MODEL_USED,
  );
};

const patchRecordProviderSessionId = (sessionService: SessionService, recordCalls: RecordCall[]): void => {
  const original = sessionService.recordProviderSessionId.bind(sessionService);
  sessionService.recordProviderSessionId = async (s: SessionState, stage: string, id: string) => {
    recordCalls.push({ stage, sessionId: id });
    return original(s, stage, id);
  };
};

const patchExecuteRepoImplementation = (command: IssueCommand): void => {
  let callIndex = 0;
  (command as any).executeRepoImplementation = async () => {
    const sessionId = callIndex === 0 ? primarySessionId : secondarySessionId;
    callIndex++;
    return {
      implementerResult: {
        type: 'implementation', hasChanges: true, branchName: null,
        sessionId, verificationOutcomes: [],
      },
      earlyReturn: false,
    };
  };
};

const buildSmokeArtifacts = (ticketKey: string) => ({
  ticketArtifact: { ticketKey, content: `# ${ticketKey}`, path: '/tmp/smoke-ticket.md' },
  planArtifact: {
    action: 'fix', path: '/tmp/smoke-plan.json', fromCache: false,
    plan: { action: 'fix', summary: 'Smoke', steps: [], estimatedComplexity: 'low', affectedFiles: [], affectedRepositories: [] },
  },
});

const teardownScenario = async (
  sessionId: string, sessionService: SessionService,
): Promise<SessionState | undefined> => {
  const state = await sessionService.load(sessionId) ?? undefined;
  await sessionService.deleteBySessionId(sessionId).catch(() => {});
  return state;
};

async function runScenario(
  command: IssueCommand,
  sessionService: SessionService,
): Promise<{ recordCalls: RecordCall[]; finalState: SessionState | undefined }> {
  const ticketKey = `SMOKE-IMPL-SID-${Date.now()}`;
  const sessionState = await setupSession(ticketKey, sessionService);
  const recordCalls: RecordCall[] = [];
  patchRecordProviderSessionId(sessionService, recordCalls);
  patchExecuteRepoImplementation(command);
  const { ticketArtifact, planArtifact } = buildSmokeArtifacts(ticketKey);
  await (command as any).runImplementLoop(
    ticketArtifact, planArtifact, [PRIMARY_REPO, SECONDARY_REPO], { silent: true }, {}, PRIMARY_REPO, sessionState,
  );
  return { recordCalls, finalState: await teardownScenario(sessionState.sessionId, sessionService) };
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
  if (call?.stage === 'implement' && call?.sessionId === primarySessionId) {
    pass(`recordProviderSessionId called with primary session ID '${primarySessionId}'`);
  } else {
    fail('wrong stage or sessionId in recordProviderSessionId call', JSON.stringify(call));
  }
}

function checkFinalSessionState(finalState: SessionState | undefined): void {
  const implementStage = finalState?.stages?.['implement'];
  if (implementStage?.providerSessionId === primarySessionId) {
    pass(`session file contains primary session ID '${primarySessionId}' after runImplementLoop`);
  } else {
    fail('session file missing or incorrect providerSessionId', JSON.stringify(implementStage));
  }
}

const checkAll = (recordCalls: RecordCall[], finalState: SessionState | undefined): void => {
  checkSingleWrite(recordCalls);
  checkPrimarySessionId(recordCalls);
  checkFinalSessionState(finalState);
};

const removeSmokeRoot = (): void => fs.rmSync(smokeRoot, { recursive: true, force: true });

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nSmoke test: implement stage records primary session ID exactly once\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const command = app.get(IssueCommand);
    const sessionService = app.get(SessionService);
    const { recordCalls, finalState } = await runScenario(command, sessionService);
    checkAll(recordCalls, finalState);
  } finally {
    await app.close();
    removeSmokeRoot();
  }
  summarise(counts);
}

main().catch(err => {
  console.error(chalk.red(`\nFAILED: ${err.message}\n`));
  process.exit(1);
});
