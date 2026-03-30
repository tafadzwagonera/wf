import * as os from 'os';
import * as path from 'path';

/**
 * Resolve the wf home directory used for logs, state, and artifacts.
 *
 * @returns Absolute path to the wf home directory
 */
export const getWfHomeDir = (): string => path.join(os.homedir(), '.wf');

/**
 * Resolve the default state directory under the wf home directory.
 *
 * @returns Absolute path to the wf state directory
 */
export const getWfStateDir = (): string => path.join(getWfHomeDir(), 'state');

/**
 * Resolve the default log directory under the wf home directory.
 *
 * @returns Absolute path to the wf log directory
 */
export const getWfLogDir = (): string => path.join(getWfHomeDir(), 'logs');

/**
 * Normalize a configured wf-relative path into the wf home directory.
 *
 * Relative inputs like `.wf/logs` or `logs` resolve under `~/.wf/`.
 * Absolute inputs are returned unchanged.
 *
 * @param configuredPath - Path from configuration or environment
 * @param defaultLeaf - Default leaf directory under `~/.wf/`
 * @returns Absolute path for the wf directory
 */
export const resolveWfPath = (
  configuredPath: string | undefined,
  defaultLeaf: string,
): string => {
  if (!configuredPath) {
    return path.join(getWfHomeDir(), defaultLeaf);
  }

  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  const normalizedPath = configuredPath.replace(/^\.wf[\\/]/, '');
  return path.join(getWfHomeDir(), normalizedPath || defaultLeaf);
};
