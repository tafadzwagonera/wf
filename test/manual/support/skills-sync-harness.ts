import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SyncRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export const repoRoot = path.resolve(__dirname, '..', '..', '..');
export const contentDir = path.join(repoRoot, 'src', 'skills', 'content');

export const createFakeHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wf-skills-sync-'));

export const removeFakeHome = (home: string): void => fs.rmSync(home, { recursive: true, force: true });

export const ensureSkillsDir = (home: string, cli: 'claude' | 'codex'): string => {
  const dir = path.join(home, `.${cli}`, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export const runSkillsSync = (home: string): SyncRunResult => {
  const result = spawnSync(
    path.join(repoRoot, 'node_modules', '.bin', 'ts-node'),
    ['-r', 'tsconfig-paths/register', 'scripts/sync-interactive-skills.ts'],
    { cwd: repoRoot, env: { ...process.env, HOME: home }, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

export const isSymlink = (target: string): boolean => {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
};

export const isAbsent = (target: string): boolean => fs.existsSync(target) === false;

export const listEntries = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
