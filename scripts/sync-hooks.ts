#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertLinkable, syncLink } from '../src/skills/skill-link';

const repoRoot = path.resolve(__dirname, '..');
const hooksDir = path.join(repoRoot, 'src', 'hooks');
const codexSource = path.join(hooksDir, 'codex-hooks.json');
const codexDestination = path.join(os.homedir(), '.codex', 'hooks.json');
const claudeFragmentPath = path.join(hooksDir, 'claude-hooks.json');
const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

const assertDestinationParentExists = (destination: string): void => {
  const parent = path.dirname(destination);
  if (fs.existsSync(parent)) return;
  throw new Error(`${parent} does not exist. The CLI owning it does not appear to be initialized on this machine.`);
};

const mergeClaudeHooks = (): 'merged' | 'ok' => {
  const fragment = readJson(claudeFragmentPath);
  if (!fragment.hooks) throw new Error(`${claudeFragmentPath} has no "hooks" key.`);
  const current = fs.readFileSync(claudeSettingsPath, 'utf8');
  const desired = `${JSON.stringify({ ...readJson(claudeSettingsPath), hooks: fragment.hooks }, null, 2)}\n`;
  if (current === desired) return 'ok';
  fs.writeFileSync(claudeSettingsPath, desired);
  return 'merged';
};

const main = async (): Promise<void> => {
  readJson(codexSource);
  assertDestinationParentExists(codexDestination);
  assertDestinationParentExists(claudeSettingsPath);
  await assertLinkable({ source: codexSource, destination: codexDestination });
  const codexStatus = await syncLink({ source: codexSource, destination: codexDestination });
  console.log(`${codexStatus} codex/hooks.json`);
  console.log(`${mergeClaudeHooks()} claude/settings.json#hooks`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
