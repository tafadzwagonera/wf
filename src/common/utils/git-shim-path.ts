import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendToLogFile } from '../logger/log-file-writer';
import { extractRuntimeAsset, isSeaRuntime } from './runtime-assets';

export const prependToPath = (dir: string, currentPath: string | undefined, delimiter = path.delimiter): string => {
  if (!currentPath) return dir;
  if (currentPath.split(delimiter)[0] === dir) return currentPath;
  return `${dir}${delimiter}${currentPath}`;
};

const canExecute = (filePath: string): boolean => {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolveRealGitPath = (envPath: string | undefined, shimDir: string): string | undefined => {
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (!dir || dir === shimDir) continue;
    const candidate = path.join(dir, 'git');
    if (canExecute(candidate)) return candidate;
  }
  return undefined;
};

const extractGitShimDir = (): string => {
  const shimFile = extractRuntimeAsset({
    assetKey: 'bootstrap/git-shim/git',
    destPath: path.join(os.homedir(), '.wf', 'bin', 'git-shim', 'git'),
    mode: 0o755,
  });
  return path.dirname(shimFile);
};

export const resolveGitShimDir = (): string =>
  isSeaRuntime() ? extractGitShimDir() : path.resolve(__dirname, '..', '..', 'bootstrap', 'git-shim');

const tryResolveGitShimDir = (): string | undefined => {
  try {
    return resolveGitShimDir();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendToLogFile('WARN', `Git shim unavailable, continuing without it: ${reason}`, 'git-shim');
    return undefined;
  }
};

const isShimExecutable = (shimDir: string): boolean => canExecute(path.join(shimDir, 'git'));

export const buildGitShimEnvOverrides = (baseEnv: NodeJS.ProcessEnv): Record<string, string> => {
  if (process.platform === 'win32') return {};
  const shimDir = tryResolveGitShimDir();
  if (!shimDir || !isShimExecutable(shimDir)) return {};
  const realGit = resolveRealGitPath(baseEnv.PATH, shimDir);
  return {
    PATH: prependToPath(shimDir, baseEnv.PATH),
    ...(realGit && { WF_REAL_GIT: realGit }),
  };
};
