/**
 * Manual Test: Session persisted to disk immediately after creation
 *
 * Run: nr test:manual session-early-persist.smoke.ts
 *
 * Verifies:
 *   1. SessionService.save() writes a file for a new session with empty stages
 *   2. SessionService.load() can read back the saved empty-stages session
 *   3. SessionService.findByTicketKey() discovers the saved session
 *   4. The saved file contains all required fields and stages is an empty object
 *   5. A subsequent recordStageStart does not corrupt the initial save
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { SessionService } from '../../src/shared/session/session.service';
import type { SessionState } from '../../src/shared/types/session.types';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const REQUIRED_SESSION_FIELDS = [
  'sessionId', 'ticketKey', 'toStage', 'action', 'sourceType',
  'customPlanRef', 'createdAt', 'updatedAt', 'completedAt', 'stages',
];

const now = (): string => new Date().toISOString();

function buildSessionDates() {
  return { createdAt: now(), updatedAt: now() };
}

function buildNewSessionState(sessionId: string, ticketKey: string): SessionState {
  return {
    sessionId,
    ticketKey,
    toStage: 'commit' as const,
    action: null,
    sourceType: 'ticket' as const,
    customPlanRef: null,
    sourceBranch: null,
    ...buildSessionDates(),
    completedAt: null,
    stages: {},
  };
}

async function createAndSaveSession(
  sessionService: SessionService,
  ticketKey: string,
  sessionId: string
): Promise<SessionState> {
  const sessionState = buildNewSessionState(sessionId, ticketKey);
  await sessionService.save(sessionState);
  return sessionState;
}

function checkFileCreated(expectedFileName: string, expectedFilePath: string): boolean {
  console.log('Test 1: save() writes file for empty-stages session');
  const fileExists = fs.existsSync(expectedFilePath);
  if (fileExists) {
    pass(`Session file created at: ${expectedFileName}`);
  } else {
    fail('Session file not created on disk');
  }
  return fileExists;
}

function verifyLoadedSession(
  loaded: SessionState | null,
  sessionId: string,
  ticketKey: string
): void {
  if (!loaded) {
    fail('Session could not be loaded back');
    return;
  }
  pass('Session loaded successfully');
  assert.strictEqual(loaded.sessionId, sessionId);
  pass('Session ID matches');
  assert.strictEqual(loaded.ticketKey, ticketKey);
  pass('Ticket key matches');
}

function verifyLoadedSessionStages(loaded: SessionState): void {
  assert.deepStrictEqual(loaded.stages, {});
  pass('Stages is empty object');
  assert.strictEqual(loaded.completedAt, null);
  pass('completedAt is null');
}

async function checkLoad(
  sessionService: SessionService,
  sessionId: string,
  ticketKey: string
): Promise<void> {
  console.log('\nTest 2: load() reads back the empty-stages session');
  const loaded = await sessionService.load(sessionId);
  verifyLoadedSession(loaded, sessionId, ticketKey);
  if (loaded) {
    verifyLoadedSessionStages(loaded);
  }
}

async function checkFindByTicketKey(
  sessionService: SessionService,
  ticketKey: string,
  sessionId: string
): Promise<void> {
  console.log('\nTest 3: findByTicketKey() discovers the empty-stages session');
  const found = await sessionService.findByTicketKey(ticketKey);
  if (found && found.sessionId === sessionId) {
    pass('findByTicketKey returns the saved session');
  } else {
    fail('findByTicketKey did not find the saved session');
  }
}

function checkRequiredFields(raw: SessionState): void {
  for (const field of REQUIRED_SESSION_FIELDS) {
    if (field in raw) {
      pass(`Field "${field}" present`);
    } else {
      fail(`Field "${field}" missing from saved file`);
    }
  }
  if (typeof raw.stages === 'object' && Object.keys(raw.stages as object).length === 0) {
    pass('stages is empty object in raw file');
  } else {
    fail('stages is not an empty object in raw file');
  }
}

function checkRawContent(expectedFilePath: string, fileExists: boolean): void {
  console.log('\nTest 4: Raw file content has all required fields');
  if (!fileExists) {
    fail('Cannot verify raw content — file does not exist');
    return;
  }
  const raw = JSON.parse(fs.readFileSync(expectedFilePath, 'utf-8'));
  checkRequiredFields(raw);
}

function verifyReloadedSession(
  reloaded: SessionState | null,
  sessionId: string,
  ticketKey: string
): void {
  if (!reloaded) {
    fail('Session could not be loaded after recordStageStart');
    return;
  }
  assert.strictEqual(reloaded.sessionId, sessionId);
  pass('Session ID preserved after recordStageStart');
  assert.strictEqual(reloaded.ticketKey, ticketKey);
  pass('Ticket key preserved');
}

function verifyPlanStageRecorded(reloaded: SessionState): void {
  assert.ok(reloaded.stages?.['plan'], 'Plan stage recorded');
  pass('Plan stage recorded after initial empty save');
  assert.strictEqual(
    reloaded.stages?.['plan']?.config?.provider,
    'anthropic'
  );
  pass('Plan stage config correct');
}

async function recordPlanStage(
  sessionService: SessionService,
  sessionState: SessionState
): Promise<void> {
  await sessionService.recordStageStart(
    sessionState,
    'plan',
    { provider: 'anthropic', backend: 'agent' },
    'claude-sonnet-4-20250514'
  );
}

async function loadAndVerifyAfterRecord(
  sessionService: SessionService,
  sessionId: string,
  ticketKey: string,
): Promise<void> {
  const reloaded = await sessionService.load(sessionId);
  verifyReloadedSession(reloaded, sessionId, ticketKey);
  if (reloaded) {
    verifyPlanStageRecorded(reloaded);
  }
}

async function recordAndVerifyPlanStage(
  sessionService: SessionService,
  sessionState: SessionState,
  sessionId: string,
  ticketKey: string
): Promise<void> {
  await recordPlanStage(sessionService, sessionState);
  await loadAndVerifyAfterRecord(sessionService, sessionId, ticketKey);
}

async function checkRecordStageStart(
  sessionService: SessionService,
  sessionState: Awaited<ReturnType<typeof createAndSaveSession>>,
  sessionId: string,
  ticketKey: string
): Promise<void> {
  console.log('\nTest 5: recordStageStart after initial save does not corrupt');
  await recordAndVerifyPlanStage(sessionService, sessionState, sessionId, ticketKey);
}

async function checkCleanup(
  sessionService: SessionService,
  sessionId: string,
  expectedFilePath: string
): Promise<void> {
  await sessionService.deleteBySessionId(sessionId);
  const fileStillExists = fs.existsSync(expectedFilePath);
  if (fileStillExists) {
    fail('Cleanup: session file still exists');
  } else {
    pass('Cleanup: session file deleted');
  }
}

async function setupAndRun(
  sessionService: SessionService,
  sessionState: SessionState,
  sessionId: string,
  ticketKey: string,
  expectedFilePath: string
): Promise<void> {
  const fileExists = checkFileCreated(`${ticketKey}-${sessionId}.json`, expectedFilePath);
  await checkLoad(sessionService, sessionId, ticketKey);
  await checkFindByTicketKey(sessionService, ticketKey, sessionId);
  checkRawContent(expectedFilePath, fileExists);
  await checkRecordStageStart(sessionService, sessionState, sessionId, ticketKey);
  await checkCleanup(sessionService, sessionId, expectedFilePath);
}

async function initializeApp(
  sessionService: any
): Promise<{ ticketKey: string; sessionId: string; sessionState: SessionState; expectedFilePath: string }> {
  const sessionDir = sessionService.getSessionDir();
  const ticketKey = `SMOKE-${Date.now()}`;
  const sessionId = crypto.randomUUID();
  const sessionState = await createAndSaveSession(sessionService, ticketKey, sessionId);
  const expectedFilePath = path.join(sessionDir, `${ticketKey}-${sessionId}.json`);
  return { ticketKey, sessionId, sessionState, expectedFilePath };
}

function logTestHeader(): void {
  console.log('\n=== Test: Session persisted to disk immediately after creation ===\n');
}

async function main(): Promise<void> {
  logTestHeader();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const sessionService = app.get(SessionService);
  const { ticketKey, sessionId, sessionState, expectedFilePath } = await initializeApp(sessionService);
  await setupAndRun(sessionService, sessionState, sessionId, ticketKey, expectedFilePath);
  await app.close();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
