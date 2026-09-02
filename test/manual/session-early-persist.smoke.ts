/**
 * Manual Test: Session persisted to disk immediately after creation
 *
 * Run: nr test:manual -- test-session-early-persist
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
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  console.log('\n=== Test: Session persisted to disk immediately after creation ===\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const sessionService = app.get(SessionService);
  const sessionDir = sessionService.getSessionDir();

  const ticketKey = `SMOKE-${Date.now()}`;
  const sessionId = crypto.randomUUID();

  const sessionState = {
    sessionId,
    ticketKey,
    toStage: 'commit',
    action: null,
    sourceType: 'ticket' as const,
    customPlanRef: null,
    sourceBranch: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    stages: {},
  };

  console.log('Test 1: save() writes file for empty-stages session');

  await sessionService.save(sessionState);

  const expectedFileName = `${ticketKey}-${sessionId}.json`;
  const expectedFilePath = path.join(sessionDir, expectedFileName);
  const fileExists = fs.existsSync(expectedFilePath);

  if (fileExists) {
    pass(`Session file created at: ${expectedFileName}`);
  } else {
    fail('Session file not created on disk');
  }

  console.log('\nTest 2: load() reads back the empty-stages session');

  const loaded = await sessionService.load(sessionId);

  if (loaded) {
    pass('Session loaded successfully');
    assert.strictEqual(loaded.sessionId, sessionId);
    pass('Session ID matches');
    assert.strictEqual(loaded.ticketKey, ticketKey);
    pass('Ticket key matches');
    assert.deepStrictEqual(loaded.stages, {});
    pass('Stages is empty object');
    assert.strictEqual(loaded.completedAt, null);
    pass('completedAt is null');
  } else {
    fail('Session could not be loaded back');
  }

  console.log('\nTest 3: findByTicketKey() discovers the empty-stages session');

  const found = await sessionService.findByTicketKey(ticketKey);

  if (found && found.sessionId === sessionId) {
    pass('findByTicketKey returns the saved session');
  } else {
    fail('findByTicketKey did not find the saved session');
  }

  console.log('\nTest 4: Raw file content has all required fields');

  if (fileExists) {
    const raw = JSON.parse(fs.readFileSync(expectedFilePath, 'utf-8'));
    const requiredFields = [
      'sessionId',
      'ticketKey',
      'toStage',
      'action',
      'sourceType',
      'customPlanRef',
      'createdAt',
      'updatedAt',
      'completedAt',
      'stages',
    ];

    for (const field of requiredFields) {
      if (field in raw) {
        pass(`Field "${field}" present`);
      } else {
        fail(`Field "${field}" missing from saved file`);
      }
    }

    if (typeof raw.stages === 'object' && Object.keys(raw.stages).length === 0) {
      pass('stages is empty object in raw file');
    } else {
      fail('stages is not an empty object in raw file');
    }
  } else {
    fail('Cannot verify raw content — file does not exist');
  }

  console.log('\nTest 5: recordStageStart after initial save does not corrupt');

  const updatedState = await sessionService.recordStageStart(
    sessionState,
    'plan',
    { provider: 'anthropic', backend: 'agent' },
    'claude-sonnet-4-20250514'
  );

  const reloaded = await sessionService.load(sessionId);

  if (reloaded) {
    assert.strictEqual(reloaded.sessionId, sessionId);
    pass('Session ID preserved after recordStageStart');
    assert.strictEqual(reloaded.ticketKey, ticketKey);
    pass('Ticket key preserved');
    assert.ok(reloaded.stages['plan'], 'Plan stage recorded');
    pass('Plan stage recorded after initial empty save');
    assert.strictEqual(reloaded.stages['plan']?.config?.provider, 'anthropic');
    pass('Plan stage config correct');
  } else {
    fail('Session could not be loaded after recordStageStart');
  }

  await sessionService.deleteBySessionId(sessionId);
  const cleanedUp = !fs.existsSync(expectedFilePath);

  if (cleanedUp) {
    pass('Cleanup: session file deleted');
  } else {
    fail('Cleanup: session file still exists');
  }

  await app.close();

  console.log(`\n${counts.passed} passed, ${counts.failed} failed\n`);
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
