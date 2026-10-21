/**
 * Manual smoke test: `sync:skills` refuses to overwrite a real directory and fails before creating any link
 *
 * Run: nr test:manual interactive-skills-sync-real-dir-guard.smoke
 *
 * Verifies:
 *   1. Exit code is 1
 *   2. stderr names the path and says it is not a symlink, with a remediation hint
 *   3. The real directory and its SKILL.md are left intact
 *   4. No symlink was created for any other skill (preflight runs before linking)
 *   5. No summary line is printed
 *   6. After removing the real directory, a re-run exits 0 and links every taxonomy link
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { skillTaxonomy } from '../../src/skills/skill-taxonomy';
import { createReporter, summarise } from './support/reporter';
import {
  createFakeHome,
  ensureSkillsDir,
  isSymlink,
  listEntries,
  removeFakeHome,
  runSkillsSync,
} from './support/skills-sync-harness';

const linkCount = Object.values(skillTaxonomy).reduce((total, audience) => total + audience.interactive.length, 0);

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const checkRealDirectoryBlocksSync = (home: string, legacyDir: string): void => {
  const claudeSkills = path.dirname(legacyDir);
  const codexSkills = path.join(home, '.codex', 'skills');
  console.log(chalk.bold('Test 1: real directory blocks the sync'));
  const blocked = runSkillsSync(home);
  assert('exits 1', blocked.status === 1, `status ${blocked.status}`);
  assert('stderr names the path', blocked.stderr.includes(legacyDir), blocked.stderr);
  assert('stderr says not a symlink', blocked.stderr.includes('not a symlink'));
  assert('stderr includes remediation hint', blocked.stderr.includes('remove it manually and re-run'));
  assert('legacy SKILL.md intact', fs.readFileSync(path.join(legacyDir, 'SKILL.md'), 'utf8') === 'legacy copy');
  assert('lint not linked in claude', isSymlink(path.join(claudeSkills, 'lint')) === false);
  assert('commit not linked in codex', isSymlink(path.join(codexSkills, 'commit')) === false);
  assert('codex skills dir still empty', listEntries(codexSkills).length === 0);
  assert('no summary line printed', blocked.stdout.includes('relinked') === false, blocked.stdout);
};

const checkRemediationWorks = (home: string, legacyDir: string): void => {
  console.log(chalk.bold('\nTest 2: remediation works'));
  fs.rmSync(legacyDir, { recursive: true, force: true });
  const recovered = runSkillsSync(home);
  assert('re-run exits 0', recovered.status === 0, recovered.stderr);
  assert(`re-run links all ${linkCount}`, recovered.stdout.includes(`linked ${linkCount}, relinked 0, ok 0`), recovered.stdout);
};

const seedLegacyCommitDir = (home: string): string => {
  ensureSkillsDir(home, 'codex');
  const legacyDir = path.join(ensureSkillsDir(home, 'claude'), 'commit');
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir, 'SKILL.md'), 'legacy copy');
  return legacyDir;
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  Interactive skills sync real-dir guard smoke test\n'));
  const home = createFakeHome();
  try {
    const legacyDir = seedLegacyCommitDir(home);
    checkRealDirectoryBlocksSync(home, legacyDir);
    checkRemediationWorks(home, legacyDir);
  } finally {
    removeFakeHome(home);
  }
  summarise(counts);
};

main();
