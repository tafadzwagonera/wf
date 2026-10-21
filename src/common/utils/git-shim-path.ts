import * as fs from 'fs';
import * as path from 'path';

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

export const resolveGitShimDir = (): string =>
  path.resolve(__dirname, '..', '..', 'bootstrap', 'git-shim');

export const buildGitShimEnvOverrides = (baseEnv: NodeJS.ProcessEnv): Record<string, string> => {
  if (process.platform === 'win32') return {};
  const shimDir = resolveGitShimDir();
  const shimFile = path.join(shimDir, 'git');
  try {
    fs.accessSync(shimFile, fs.constants.X_OK);
  } catch {
    return {};
  }
  const realGit = resolveRealGitPath(baseEnv.PATH, shimDir);
  return {
    PATH: prependToPath(shimDir, baseEnv.PATH),
    ...(realGit && { WF_REAL_GIT: realGit }),
  };
};
