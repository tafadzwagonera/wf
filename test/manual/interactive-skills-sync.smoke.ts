/**
 * Manual smoke test: `skills:sync` links every taxonomy-declared interactive skill into per-CLI skills dirs,
 * idempotently, without touching foreign entries
 *
 * Run: nr test:manual interactive-skills-sync.smoke
 *
 * Verifies:
 *   1. package.json skills:sync script matches the command this test spawns
 *   2. First run exits 0 and reports every taxonomy link as linked (`relinked 0, ok 0`)
 *   3. Every interactive taxonomy entry is a symlink resolving to src/skills/content/<id>
 *   4. Skills are not linked into CLIs absent from their taxonomy audience
 *   5. Foreign entries (.system, user-added skills) are untouched
 *   6. Second run reports every link as ok (`linked 0, relinked 0`)
 *   7. A stale symlink is repointed and reported as relinked
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { skillTaxonomy } from '../../src/skills/skill-taxonomy';
import { createReporter, summarise } from './support/reporter';
import {
  contentDir,
  createFakeHome,
  ensureSkillsDir,
  isAbsent,
  isSymlink,
  removeFakeHome,
  repoRoot,
  runSkillsSync,
} from './support/skills-sync-harness';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const expectedScriptCommand = 'ts-node -r tsconfig-paths/register scripts/sync-interactive-skills.ts';

const interactiveLinks = Object.entries(skillTaxonomy).flatMap(([id, audience]) =>
  audience.interactive.map(cli => ({ id, cli })));
const excludedLinks = Object.entries(skillTaxonomy).flatMap(([id, audience]) =>
  (['claude', 'codex'] as const).filter(cli => !audience.interactive.includes(cli)).map(cli => ({ id, cli })));
const linkCount = interactiveLinks.length;

const checkScriptDefinition = (): void => {
  console.log(chalk.bold('Test 1: package.json script'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert('skills:sync script matches spawned command', packageJson.scripts['skills:sync'] === expectedScriptCommand);
};

const checkFirstRun = (home: string): void => {
  console.log(chalk.bold('\nTest 2: first run links everything'));
  const result = runSkillsSync(home);
  assert('exits 0', result.status === 0, result.stderr);
  assert(`summary reports ${linkCount} linked`, result.stdout.includes(`linked ${linkCount}, relinked 0, ok 0`), result.stdout);
  assert('logs linked claude/commit', result.stdout.includes('linked claude/commit'));
  assert('logs linked codex/plan', result.stdout.includes('linked codex/plan'));

  for (const { id, cli } of interactiveLinks) {
    const destination = path.join(home, `.${cli}`, 'skills', id);
    const target = isSymlink(destination) ? fs.readlinkSync(destination) : undefined;
    assert(`${cli}/${id} resolves to repo content`, target === path.join(contentDir, id), `got ${target}`);
  }

  const commitThroughLink = fs.readFileSync(path.join(home, '.claude', 'skills', 'commit', 'SKILL.md'), 'utf8');
  assert('SKILL.md readable through link', commitThroughLink.startsWith('---') && commitThroughLink.includes('name: commit'));
};

const checkAudienceBoundaries = (home: string): void => {
  console.log(chalk.bold('\nTest 3: audience boundaries'));
  for (const { id, cli } of excludedLinks) {
    assert(`${id} absent from ${cli}`, isAbsent(path.join(home, `.${cli}`, 'skills', id)));
  }
};

const checkForeignEntriesUntouched = (home: string): void => {
  console.log(chalk.bold('\nTest 4: foreign entries untouched'));
  const marker = path.join(home, '.codex', 'skills', '.system', 'marker.txt');
  const ownSkill = path.join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md');
  assert('.system marker intact', fs.readFileSync(marker, 'utf8') === 'system');
  assert('user-added skill intact', fs.readFileSync(ownSkill, 'utf8') === 'mine');
};

const checkIdempotentSecondRun = (home: string): void => {
  console.log(chalk.bold('\nTest 5: idempotent second run'));
  const second = runSkillsSync(home);
  assert('second run exits 0', second.status === 0, second.stderr);
  assert(`second run reports ${linkCount} ok`, second.stdout.includes(`linked 0, relinked 0, ok ${linkCount}`), second.stdout);
};

const checkStaleSymlinkRelinked = (home: string): void => {
  console.log(chalk.bold('\nTest 6: stale symlink is relinked'));
  const lintLink = path.join(home, '.claude', 'skills', 'lint');
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-skills-other-'));
  fs.unlinkSync(lintLink);
  fs.symlinkSync(otherDir, lintLink, 'dir');
  const third = runSkillsSync(home);
  assert('third run exits 0', third.status === 0, third.stderr);
  assert('logs relinked claude/lint', third.stdout.includes('relinked claude/lint'));
  assert('summary reports 1 relinked', third.stdout.includes(`linked 0, relinked 1, ok ${linkCount - 1}`), third.stdout);
  assert('lint link repointed to repo content', fs.readlinkSync(lintLink) === path.join(contentDir, 'lint'));
  fs.rmSync(otherDir, { recursive: true, force: true });
};

const checkRepeatRuns = (home: string): void => {
  checkIdempotentSecondRun(home);
  checkStaleSymlinkRelinked(home);
};

const seedForeignEntries = (home: string): void => {
  ensureSkillsDir(home, 'claude');
  ensureSkillsDir(home, 'codex');
  fs.mkdirSync(path.join(home, '.codex', 'skills', '.system'));
  fs.writeFileSync(path.join(home, '.codex', 'skills', '.system', 'marker.txt'), 'system');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'my-own-skill'));
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md'), 'mine');
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  Interactive skills sync smoke test\n'));
  const home = createFakeHome();
  try {
    seedForeignEntries(home);
    checkScriptDefinition();
    checkFirstRun(home);
    checkAudienceBoundaries(home);
    checkForeignEntriesUntouched(home);
    checkRepeatRuns(home);
  } finally {
    removeFakeHome(home);
  }
  summarise(counts);
};

main();
