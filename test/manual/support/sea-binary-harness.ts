import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const projectRoot = path.resolve(__dirname, '../../..');
export const seaBinaryPath = path.join(projectRoot, 'dist-bundle', 'wf');
export const cleanPath = '/usr/bin:/bin';

export type SeaRunResult = { exitCode: number | null; output: string };

export const assertSeaBinaryBuilt = (): void => {
  if (fs.existsSync(seaBinaryPath)) return;
  console.error(`SEA binary not found at ${seaBinaryPath}. Run \`yarn build:sea\` first.`);
  process.exit(1);
};

export const assertNodeAbsentFromCleanPath = (): void => {
  const found = cleanPath.split(':').filter(dir => fs.existsSync(path.join(dir, 'node')));
  if (found.length === 0) return;
  console.error(`Environment not clean: node exists in ${found.join(', ')}; the test would not prove node-free operation.`);
  process.exit(1);
};

export const createTempDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const runSeaBinary = (
  binaryPath: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): SeaRunResult => {
  const result = spawnSync(binaryPath, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 10,
    timeout: options.timeoutMs ?? 60_000,
  });
  return { exitCode: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
};

export const removeDir = (dir: string): void => {
  fs.rmSync(dir, { recursive: true, force: true });
};

export const recordingFakeClaudeSource = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.219 (Claude Code)"; exit 0; fi
printf '%s\\n' "$@" > "$SEA_RECORD_DIR/argv-$$.txt"
printf '%s\\n' "$PATH" > "$SEA_RECORD_DIR/path-$$.txt"
cat > /dev/null
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1","num_turns":1}'
`;

export const installRecordingFakeClaude = (binDir: string): void => {
  fs.writeFileSync(path.join(binDir, 'claude'), recordingFakeClaudeSource, { mode: 0o755 });
};

export const readRecordings = (recordDir: string, prefix: 'argv' | 'path'): string[] =>
  fs.readdirSync(recordDir)
    .filter(name => name.startsWith(`${prefix}-`))
    .map(name => fs.readFileSync(path.join(recordDir, name), 'utf-8'));
