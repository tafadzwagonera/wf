import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { repoRoot } from './skills-sync-harness';

export interface GateRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export const gateScriptPath = path.join(repoRoot, 'src', 'hooks', 'skill-gate.sh');

export const runGate = (
  subcommand: string,
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): GateRunResult => {
  const result = spawnSync(gateScriptPath, [subcommand], {
    cwd: repoRoot,
    input: options.input ?? '',
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

export const editCheckInput = (sessionId: string, filePath: string): string =>
  JSON.stringify({ session_id: sessionId, cwd: '/x', tool_input: { file_path: filePath } });

export const notebookCheckInput = (sessionId: string, notebookPath: string): string =>
  JSON.stringify({ session_id: sessionId, cwd: '/x', tool_input: { notebook_path: notebookPath } });

export const skillMarkInput = (sessionId: string, skill: string): string =>
  JSON.stringify({ session_id: sessionId, cwd: '/x', tool_input: { skill } });

export const stopInput = (transcriptPath?: string): string =>
  JSON.stringify(transcriptPath ? { cwd: '/x', transcript_path: transcriptPath } : { cwd: '/x' });

export const isSilentPass = (result: GateRunResult): boolean => result.status === 0 && result.stdout.trim() === '';
