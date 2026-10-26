/**
 * Manual smoke test: sync:hooks deploys the skill-gate wiring into the config surfaces the CLIs
 * actually read — ~/.claude/settings.json and ~/.codex/hooks.json
 *
 * Run: nr test:manual skill-gate-hook-registration.smoke
 *
 * Verifies:
 *   1. package.json sync:hooks script matches the command this test spawns
 *   2. the sync exits 0 against a seeded fake HOME
 *   3. settings.json gains a PreToolUse entry for Edit|Write|MultiEdit|NotebookEdit running skill-gate.sh check
 *   4. settings.json gains a PostToolUse entry for Skill running skill-gate.sh mark
 *   5. pre-existing non-hooks settings keys survive the merge
 *   6. .codex/hooks.json is a symlink to src/hooks/codex-hooks.json
 *   7. the Codex Stop chain runs skill-gate check-stop after the plan gate and before quality checks
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';
import { createFakeHome, isSymlink, removeFakeHome, repoRoot } from './support/skills-sync-harness';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const expectedScriptCommand = 'ts-node -r tsconfig-paths/register scripts/sync-hooks.ts';

interface HookCommand {
  command: string;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

interface HooksConfig {
  PreToolUse?: HookEntry[];
  PostToolUse?: HookEntry[];
  Stop?: HookEntry[];
}

const seedFakeHome = (home: string): void => {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2));
};

const runHooksSync = (home: string): { status: number | null; stderr: string } => {
  const result = spawnSync(
    path.join(repoRoot, 'node_modules', '.bin', 'ts-node'),
    ['-r', 'tsconfig-paths/register', 'scripts/sync-hooks.ts'],
    { cwd: repoRoot, env: { ...process.env, HOME: home }, encoding: 'utf8' },
  );
  return { status: result.status, stderr: result.stderr ?? '' };
};

const findEntryCommand = (entries: HookEntry[] | undefined, matcher: string): string | undefined =>
  entries?.find(entry => entry.matcher === matcher)?.hooks[0]?.command;

const checkScriptDefinition = (): void => {
  console.log(chalk.bold('Test 1: package.json script'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert('sync:hooks script matches spawned command', packageJson.scripts['sync:hooks'] === expectedScriptCommand);
};

const checkClaudeSettings = (home: string): void => {
  console.log(chalk.bold('\nTest 3: Claude Code settings wiring'));
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { model?: string; hooks?: HooksConfig };
  const checkCommand = findEntryCommand(settings.hooks?.PreToolUse, 'Edit|Write|MultiEdit|NotebookEdit');
  assert('PreToolUse edit matcher runs skill-gate check', checkCommand?.endsWith('skill-gate.sh check') === true, checkCommand);
  const markCommand = findEntryCommand(settings.hooks?.PostToolUse, 'Skill');
  assert('PostToolUse Skill matcher runs skill-gate mark', markCommand?.endsWith('skill-gate.sh mark') === true, markCommand);
  assert('pre-existing model setting survives merge', settings.model === 'opus', JSON.stringify(settings));
};

const checkCodexSymlink = (hooksPath: string): void => {
  console.log(chalk.bold('\nTest 4: Codex hooks wiring'));
  assert('hooks.json is a symlink', isSymlink(hooksPath));
  assert(
    'symlink resolves to repo codex-hooks.json',
    fs.readlinkSync(hooksPath) === path.join(repoRoot, 'src', 'hooks', 'codex-hooks.json'),
    fs.readlinkSync(hooksPath),
  );
};

const checkCodexStopChain = (hooksPath: string): void => {
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as { hooks: HooksConfig };
  const stopCommands = (hooks.hooks.Stop?.[0]?.hooks ?? []).map(hook => hook.command);
  const planIndex = stopCommands.findIndex(command => command.includes('plan-review-gate.sh check-stop'));
  const gateIndex = stopCommands.findIndex(command => command.includes('skill-gate.sh check-stop'));
  const qualityIndex = stopCommands.findIndex(command => command.includes('quality-checks.sh'));
  assert('Stop chain contains skill-gate check-stop', gateIndex !== -1, stopCommands.join(' | '));
  assert('skill-gate runs after the plan gate', planIndex !== -1 && gateIndex > planIndex, stopCommands.join(' | '));
  assert('skill-gate runs before quality checks', qualityIndex !== -1 && gateIndex < qualityIndex, stopCommands.join(' | '));
};

const runChecks = (home: string): void => {
  seedFakeHome(home);
  checkScriptDefinition();
  console.log(chalk.bold('\nTest 2: sync run'));
  const result = runHooksSync(home);
  assert('sync:hooks exits 0', result.status === 0, result.stderr);
  checkClaudeSettings(home);
  const hooksPath = path.join(home, '.codex', 'hooks.json');
  checkCodexSymlink(hooksPath);
  checkCodexStopChain(hooksPath);
};

const main = (): void => {
  console.log(chalk.bold.cyan('\n  skill-gate hook registration smoke test\n'));
  const home = createFakeHome();
  try {
    runChecks(home);
  } finally {
    removeFakeHome(home);
  }
  summarise(counts);
};

main();
