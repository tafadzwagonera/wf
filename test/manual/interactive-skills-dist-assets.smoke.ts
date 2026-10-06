/**
 * Manual smoke test: the built package ships every taxonomy skill's SKILL.md under dist/skills/content/
 *
 * Run: nr test:manual interactive-skills-dist-assets.smoke
 *
 * Verifies:
 *   1. `yarn build` exits 0
 *   2. dist/skills/content/<id>/SKILL.md exists and is non-empty for every taxonomy id
 *   3. Each dist SKILL.md is byte-identical to its src counterpart
 *   4. No dist content directory is missing from the taxonomy
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { skillTaxonomy } from '../../src/skills/skill-taxonomy';
import { createReporter, summarise } from './support/reporter';
import { contentDir, repoRoot } from './support/skills-sync-harness';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const distContentDir = path.join(repoRoot, 'dist', 'skills', 'content');

const checkBuild = (): void => {
  console.log(chalk.bold('Test 1: yarn build'));
  const build = spawnSync('yarn', ['build'], { cwd: repoRoot, encoding: 'utf8' });
  assert('yarn build exits 0', build.status === 0, build.stderr);
};

const checkAssets = (): void => {
  console.log(chalk.bold('\nTest 2: dist assets match src'));
  for (const id of Object.keys(skillTaxonomy)) {
    const distFile = path.join(distContentDir, id, 'SKILL.md');
    const srcFile = path.join(contentDir, id, 'SKILL.md');
    const distContent = fs.existsSync(distFile) ? fs.readFileSync(distFile) : undefined;
    assert(`${id} exists and is non-empty`, distContent !== undefined && distContent.length > 0);
    assert(`${id} identical to src`, distContent !== undefined && distContent.equals(fs.readFileSync(srcFile)));
  }
};

const checkNoOrphans = (): void => {
  console.log(chalk.bold('\nTest 3: no orphan dist dirs'));
  const orphans = fs.readdirSync(distContentDir).filter(id => skillTaxonomy[id] === undefined);
  assert('every dist content dir is in the taxonomy', orphans.length === 0, orphans.join(', '));
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  Interactive skills dist assets smoke test\n'));
  checkBuild();
  checkAssets();
  checkNoOrphans();
  summarise(counts);
};

main();
