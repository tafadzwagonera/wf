/**
 * Manual Test: issue:plan on the Claude CLI backend narrates tool activity
 *
 * Run: nr test:manual issue-plan-claude-tool-activity-narration.smoke
 *
 * Verifies:
 *   1. issue:plan exits 0 when the Claude CLI stream carries tool_use/tool_result blocks
 *   2. stdout shows `[claude-cli] Running: Bash(...)` and `Running: Read(...)` lines
 *   3. stdout shows `[claude-cli] Tool completed` and `Tool failed: <text>` lines
 *   4. a successful result's text is not echoed (file contents stay out of the console)
 *   5. empty-input tools do not produce `Running: WebFetch(...)` lines
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  cleanupPlanHarness, runPlanCli, setupPlanHarness, type PlanRunResult,
} from './support/plan-cli-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const validPlan = {
  action: 'fix', summary: 'Tool activity plan', steps: ['Step 1'],
  estimatedComplexity: 'low', affectedRepositories: ['repo'],
};

const FAKE_CLAUDE_WITH_TOOL_STREAM = `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  console.log('2.1.219 (Claude Code)');
  process.exit(0);
}
const plan = ${JSON.stringify(validPlan)};
const emit = message => console.log(JSON.stringify({ session_id: 'sess-1', ...message }));
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  emit({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Inspecting the repo' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls src' } },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'src/a.ts' } },
    { type: 'tool_use', id: 't3', name: 'WebFetch', input: {} },
  ] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET-FILE-CONTENTS' }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'no such file' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(plan), num_turns: 1 });
});
`;

const check = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

const runScenario = (): { result: PlanRunResult; cleanup: () => void } => {
  const harness = setupPlanHarness('wf-claude-tool-activity-', validPlan);
  fs.writeFileSync(path.join(harness.binDir, 'claude'), FAKE_CLAUDE_WITH_TOOL_STREAM, { mode: 0o755 });
  const result = runPlanCli(harness, ['--action', 'fix', '--custom-plan', path.join(harness.repoDir, 'source.md')]);
  return { result, cleanup: () => cleanupPlanHarness(harness) };
};

const runChecks = ({ exitCode, output }: PlanRunResult): void => {
  const tail = output.slice(-500);
  check(exitCode === 0, 'issue:plan exits 0', tail);
  check(output.includes('[claude-cli] Running: Bash(ls src)'), 'shows Running: Bash(ls src)', tail);
  check(output.includes('[claude-cli] Running: Read(src/a.ts)'), 'shows Running: Read(src/a.ts)', tail);
  check(output.includes('[claude-cli] Tool completed'), 'shows Tool completed', tail);
  check(output.includes('[claude-cli] Tool failed: no such file'), 'shows Tool failed: no such file', tail);
  check(!output.includes('SECRET-FILE-CONTENTS'), 'successful result text is not echoed');
  check(!output.includes('Running: WebFetch'), 'empty-input tool is not narrated');
};

const main = async (): Promise<void> => {
  console.log('\n issue:plan Claude CLI tool activity narration\n');
  const { result, cleanup } = runScenario();
  try {
    runChecks(result);
  } finally {
    cleanup();
  }
  summarise(counts);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
