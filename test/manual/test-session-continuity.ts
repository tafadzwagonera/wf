#!/usr/bin/env ts-node

/**
 * Manual test: Session ID Continuity Across Workflow Stages
 *
 * Prerequisites:
 *   1. Run `wf issue:plan <ticket> -a fix` → note the session ID from output
 *   2. Run `wf issue:implement <ticket> --session-id <id>` → verify session updated
 *   3. Run `wf issue:review <ticket> --session-id <id>` → verify all 3 stages recorded
 *
 * This script verifies the session state file after the above steps.
 *
 * Usage: nr test:manual -- test-session-continuity [session-id]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import assert from 'node:assert';

const SESSION_DIR = path.join(os.homedir(), '.wf', 'state', 'sessions');

const sessionId = process.argv[2];

if (!sessionId) {
  console.log('Usage: nr test:manual -- test-session-continuity <session-id>');
  console.log('\nRun wf issue:plan first to get a session ID, then pass it here.');
  process.exit(1);
}

console.log(`\nVerifying session: ${sessionId}`);
console.log(`Session dir: ${SESSION_DIR}\n`);

// 1. Verify session dir exists
assert.ok(fs.existsSync(SESSION_DIR), `Session directory does not exist: ${SESSION_DIR}`);
console.log('✓ Session directory exists');

// 2. Find session file
const files = fs.readdirSync(SESSION_DIR);
const sessionFile = files.find(f => f.includes(sessionId) && f.endsWith('.json') && !f.endsWith('.items.json'));
assert.ok(sessionFile, `No session file found for ID: ${sessionId}`);
console.log(`✓ Session file found: ${sessionFile}`);

// 3. Parse session state
const sessionPath = path.join(SESSION_DIR, sessionFile);
const raw: Record<string, any> = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
console.log(`✓ Session file is valid JSON`);

// 4. Verify required fields
assert.ok(raw.sessionId, 'Missing sessionId');
assert.ok(raw.ticketKey, 'Missing ticketKey');
assert.ok(raw.createdAt, 'Missing createdAt');
assert.ok(raw.updatedAt, 'Missing updatedAt');
assert.ok(raw.stages && typeof raw.stages === 'object', 'Missing stages object');
console.log(`✓ Required fields present (ticketKey: ${raw.ticketKey})`);

// 5. Check stage records
const stageNames = Object.keys(raw.stages);
console.log(`✓ Stages recorded: ${stageNames.join(', ') || '(none)'}`);

for (const [stageName, record] of Object.entries(raw.stages as Record<string, any>)) {
  console.log(`\n  Stage: ${stageName}`);
  assert.ok(record.config, `  Missing config for ${stageName}`);
  assert.ok(record.config.provider, `  Missing provider for ${stageName}`);
  assert.ok(record.config.backend, `  Missing backend for ${stageName}`);
  console.log(`    Provider: ${record.config.provider}/${record.config.backend}`);
  console.log(`    Model: ${record.model}`);
  console.log(`    Provider Session ID: ${record.providerSessionId ?? '(null)'}`);
  console.log(`    Started: ${record.startedAt}`);
  console.log(`    Completed: ${record.completedAt ?? '(in progress)'}`);
  if (record.summary) {
    console.log(`    Summary: ${record.summary.slice(0, 100)}...`);
  }
}

// 6. Check for items file (OpenAI sessions)
const itemsFile = files.find(f => f.includes(sessionId) && f.endsWith('.items.json'));
if (itemsFile) {
  const itemsPath = path.join(SESSION_DIR, itemsFile);
  const items = JSON.parse(fs.readFileSync(itemsPath, 'utf-8'));
  console.log(`\n✓ Items file found: ${itemsFile} (${items.length} items)`);
}

console.log('\n✅ Session continuity verification complete\n');
