/**
 * Manual Test: issue:create with priority fallback
 *
 * Run: nr test:manual -- test-issue-create
 *
 * Verifies that issue:create can create a Jira ticket even when the project
 * rejects the mapped priority value. If priority is rejected (HTTP 400), the
 * service retries without the priority field and logs a warning.
 */

import { execSync } from 'child_process';

async function testIssueCreate() {
  console.log('\n🧪 Manual Test: issue:create priority fallback\n');

  const result = execSync(
    'yarn start issue:create ~/.wf/wf/jira/GENERATED-2026-03-30-927636c4.md --ticket-project WBP',
    { encoding: 'utf8', stdio: 'pipe', cwd: process.cwd() },
  );
  console.log(result);
}

testIssueCreate().catch((err) => {
  console.error(err.stdout || err.message);
  process.exit(1);
});
