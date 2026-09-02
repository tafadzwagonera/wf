/**
 * Manual Test Script for conversation artefact path fix
 *
 * Run: WF_TEST_TICKET=WBP-3045 nr test:manual -- test-conversation-artefact-path
 *
 * Prerequisites:
 *   WF_TEST_TICKET — the ticket key for a prior chat-mode run (e.g. WBP-3045).
 *   Skip with a clear message if absent.
 *
 * What it checks:
 *   1. ~/.wf/<app>/jira/<key>-conversation.json EXISTS   (correct location)
 *   2. <cwd>/jira/<key>-conversation.json does NOT exist (wrong location, Bug 1)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

async function main(): Promise<void> {
  console.log('🧪 Testing conversation artefact path\n');

  const ticketKey = process.env.WF_TEST_TICKET;
  if (!ticketKey) {
    console.log(
      '⚠ WF_TEST_TICKET is not set — skipping test.\n'
      + '  Set it to a ticket key for which you have already run:\n'
      + '    wf issue <ticket> --from fetch -a fix --chat-mode\n'
    );
    process.exit(0);
  }

  // Derive the app name from cwd (mirrors resolveArtifactDir / getConversationFilePath logic)
  const appName = path.basename(path.resolve(process.cwd()));
  const expectedPath = path.join(os.homedir(), '.wf', appName, 'jira', `${ticketKey}-conversation.json`);
  const wrongPath = path.join(process.cwd(), 'jira', `${ticketKey}-conversation.json`);

  const { counts, pass, fail } = createReporter();

  console.log(`  Ticket:        ${ticketKey}`);
  console.log(`  Expected path: ${expectedPath}`);
  console.log(`  Wrong path:    ${wrongPath}\n`);

  // Test 1: Artefact exists at expected location
  if (fs.existsSync(expectedPath)) {
    pass(`Artefact found at correct location: ${expectedPath}`);
  } else {
    fail(
      `Artefact NOT found at expected location: ${expectedPath}\n`
      + '  Run wf issue with --chat-mode first, or check that Bug 1 fix was applied.'
    );
  }

  // Test 2: Artefact does NOT exist at wrong location
  if (fs.existsSync(wrongPath)) {
    fail(
      `Artefact found at WRONG location: ${wrongPath}\n`
      + '  Bug 1 regression — conversation is still being saved to <cwd>/jira/.'
    );
  } else {
    pass(`Artefact correctly absent from wrong location: ${wrongPath}`);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) {
    console.log('✓ All tests passed!');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
