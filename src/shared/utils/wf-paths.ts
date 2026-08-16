import * as os from 'node:os';
import * as path from 'node:path';

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
 * Resolve the session directory under the wf state directory.
 *
 * @returns Absolute path to the wf session directory
 */
export const getWfSessionDir = (): string => path.join(getWfStateDir(), 'sessions');
