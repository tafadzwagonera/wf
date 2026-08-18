import * as os from 'node:os';
import * as path from 'node:path';

const WF_HOME_ENV = 'WF_HOME';

interface WfPathOverrides {
  logDir?: string;
  stateDir?: string;
}

let overrides: WfPathOverrides = {};

/**
 * Point log and state at configured directories.
 *
 * Called once during config initialisation so the `log.directory` and `state.directory`
 * config fields take effect — they were accepted by the schema but never consumed, so
 * setting them silently did nothing.
 *
 * Relative paths are ignored rather than resolved, because these directories are read from
 * long-lived processes whose cwd moves between repositories.
 *
 * @param next - Configured directories; entries that are absent or relative are ignored
 */
export const setWfPathOverrides = (next: WfPathOverrides): void => {
  overrides = {
    logDir: next.logDir && path.isAbsolute(next.logDir) ? next.logDir : undefined,
    stateDir: next.stateDir && path.isAbsolute(next.stateDir) ? next.stateDir : undefined,
  };
};

/** Clears configured overrides, restoring env-var and default resolution. */
export const resetWfPathOverrides = (): void => {
  overrides = {};
};

/**
 * Resolve the wf home directory used for logs, state, and artifacts.
 *
 * `WF_HOME` relocates the whole tree. The test suite relies on this to keep specs from
 * appending to the real `~/.wf/logs`, which they previously polluted with fixture output.
 *
 * @returns Absolute path to the wf home directory
 */
export const getWfHomeDir = (): string => {
  const fromEnv = process.env[WF_HOME_ENV];
  return fromEnv && path.isAbsolute(fromEnv) ? fromEnv : path.join(os.homedir(), '.wf');
};

/**
 * Resolve the state directory, preferring a configured override.
 *
 * @returns Absolute path to the wf state directory
 */
export const getWfStateDir = (): string => overrides.stateDir ?? path.join(getWfHomeDir(), 'state');

/**
 * Resolve the log directory, preferring a configured override.
 *
 * @returns Absolute path to the wf log directory
 */
export const getWfLogDir = (): string => overrides.logDir ?? path.join(getWfHomeDir(), 'logs');

/**
 * Resolve the session directory under the wf state directory.
 *
 * @returns Absolute path to the wf session directory
 */
export const getWfSessionDir = (): string => path.join(getWfStateDir(), 'sessions');
