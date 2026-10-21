/**
 * Manual smoke test: `sync:skills` fails with an install hint when a CLI's skills dir is absent
 * and never creates home config dirs
 *
 * Run: nr test:manual interactive-skills-sync-missing-cli-dir.smoke
 *
 * Verifies:
 *   1. Exit code is 1
 *   2. stderr names the missing ~/.codex/skills path and the install hint
 *   3. ~/.codex was not created
 *   4. ~/.claude/skills is still empty (nothing linked before the failure)
 *   5. stdout has no per-skill status lines
 */
import * as path from 'node:path';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';
import {
  createFakeHome,
  ensureSkillsDir,
  isAbsent,
  listEntries,
  removeFakeHome,
  runSkillsSync,
} from './support/skills-sync-harness';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const checkFailureWithoutSideEffects = (home: string): void => {
  const claudeSkills = ensureSkillsDir(home, 'claude');
  const result = runSkillsSync(home);

  assert('exits 1', result.status === 1, `status ${result.status}`);
  assert('stderr names missing codex skills dir', result.stderr.includes(`${path.join(home, '.codex', 'skills')} does not exist`), result.stderr);
  assert('stderr includes install hint', result.stderr.includes('codex does not appear to be installed or initialized'));
  assert('~/.codex not created', isAbsent(path.join(home, '.codex')));
  assert('~/.claude/skills still empty', listEntries(claudeSkills).length === 0);
  assert('no per-skill status lines', /^(?:linked|relinked|ok) /m.test(result.stdout) === false, result.stdout);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  Interactive skills sync missing CLI dir smoke test\n'));
  const home = createFakeHome();
  try {
    checkFailureWithoutSideEffects(home);
  } finally {
    removeFakeHome(home);
  }
  summarise(counts);
};

main();
