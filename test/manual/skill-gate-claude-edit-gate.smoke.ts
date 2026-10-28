/**
 * Manual smoke test: skill-gate.sh gates Claude Code code edits behind the coding-style and
 * test-driven-development skills, scoped per session, bypassed for headless wf runs
 *
 * Run: nr test:manual skill-gate-claude-edit-gate.smoke
 *
 * Verifies:
 *   1. check denies a .ts edit (and a notebook edit) when no skill markers exist for the session
 *   2. check ignores non-code files and /private/tmp paths
 *   3. check exits silently under WF_MANAGED_SESSION=1 even with no markers
 *   4. marking coding-style alone still denies; marking test-driven-development too unlocks
 *   5. both markers land under $HOME/.claude/skill-gate-markers
 *   6. a different session_id in the same HOME is still denied
 *   7. marking an unrelated skill creates no marker
 */
import * as path from 'node:path';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';
import { createFakeHome, listEntries, removeFakeHome } from './support/skills-sync-harness';
import { editCheckInput, isSilentPass, notebookCheckInput, runGate, skillMarkInput } from './support/skill-gate-harness';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const sessionId = 'smoke-session-a';

const isDeny = (stdout: string): boolean => {
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    return parsed.hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
};

const checkDeniesWithoutMarkers = (gateEnv: NodeJS.ProcessEnv): void => {
  console.log(chalk.bold('Test 1: unmarked session is denied'));
  const edit = runGate('check', { input: editCheckInput(sessionId, '/x/src/a.ts'), env: gateEnv });
  assert('.ts edit is denied', isDeny(edit.stdout), edit.stdout + edit.stderr);
  assert('deny exits 0 so Claude Code reads the decision', edit.status === 0);
  const notebook = runGate('check', { input: notebookCheckInput(sessionId, '/x/n.py'), env: gateEnv });
  assert('notebook edit is denied', isDeny(notebook.stdout), notebook.stdout + notebook.stderr);
};

const checkExemptPaths = (gateEnv: NodeJS.ProcessEnv): void => {
  console.log(chalk.bold('\nTest 2: exempt paths pass through'));
  const markdown = runGate('check', { input: editCheckInput(sessionId, '/x/README.md'), env: gateEnv });
  assert('.md edit passes silently', isSilentPass(markdown), markdown.stdout + markdown.stderr);
  const temp = runGate('check', { input: editCheckInput(sessionId, '/private/tmp/scratch/a.ts'), env: gateEnv });
  assert('/private/tmp .ts edit passes silently', isSilentPass(temp), temp.stdout + temp.stderr);
};

const checkHeadlessBypass = (gateEnv: NodeJS.ProcessEnv): void => {
  console.log(chalk.bold('\nTest 3: headless bypass'));
  const managedEnv = { ...gateEnv, WF_MANAGED_SESSION: '1' };
  const result = runGate('check', { input: editCheckInput(sessionId, '/x/src/a.ts'), env: managedEnv });
  assert('WF_MANAGED_SESSION=1 passes silently', isSilentPass(result), result.stdout + result.stderr);
};

const checkMarkingUnlocks = (gateEnv: NodeJS.ProcessEnv, markerDir: string): void => {
  console.log(chalk.bold('\nTest 4: marking both skills unlocks the session'));
  runGate('mark', { input: skillMarkInput(sessionId, 'coding-style'), env: gateEnv });
  const partial = runGate('check', { input: editCheckInput(sessionId, '/x/src/a.ts'), env: gateEnv });
  assert('coding-style alone still denies', isDeny(partial.stdout), partial.stdout + partial.stderr);
  runGate('mark', { input: skillMarkInput(sessionId, 'test-driven-development'), env: gateEnv });
  const unlocked = runGate('check', { input: editCheckInput(sessionId, '/x/src/a.ts'), env: gateEnv });
  assert('both skills marked passes silently', isSilentPass(unlocked), unlocked.stdout + unlocked.stderr);
  assert('two markers exist in skill-gate-markers', listEntries(markerDir).length === 2, listEntries(markerDir).join(', '));
};

const checkSessionScoping = (gateEnv: NodeJS.ProcessEnv): void => {
  console.log(chalk.bold('\nTest 5: markers are session-scoped'));
  const other = runGate('check', { input: editCheckInput('smoke-session-b', '/x/src/a.ts'), env: gateEnv });
  assert('different session_id is still denied', isDeny(other.stdout), other.stdout + other.stderr);
};

const checkUnrelatedSkillIgnored = (gateEnv: NodeJS.ProcessEnv, markerDir: string): void => {
  console.log(chalk.bold('\nTest 6: unrelated skills leave no marker'));
  runGate('mark', { input: skillMarkInput(sessionId, 'lint'), env: gateEnv });
  assert('marker count unchanged after marking lint', listEntries(markerDir).length === 2, listEntries(markerDir).join(', '));
};

const runChecks = (home: string): void => {
  const gateEnv = { HOME: home };
  const markerDir = path.join(home, '.claude', 'skill-gate-markers');
  checkDeniesWithoutMarkers(gateEnv);
  checkExemptPaths(gateEnv);
  checkHeadlessBypass(gateEnv);
  checkMarkingUnlocks(gateEnv, markerDir);
  checkSessionScoping(gateEnv);
  checkUnrelatedSkillIgnored(gateEnv, markerDir);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  skill-gate Claude Code edit gate smoke test\n'));
  const home = createFakeHome();
  try {
    runChecks(home);
  } finally {
    removeFakeHome(home);
  }
  summarise(counts);
};

main();
