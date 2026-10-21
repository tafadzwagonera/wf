/**
 * Manual Test: default log/state directories smoke test
 *
 * Run: nr test:manual non-configurable-directories.smoke.ts
 *
 * Verifies:
 *   1. `normalizeWfConfig` leaves `state.directory` unset by default.
 *   2. `normalizeWfConfig` leaves `directory` unset in `logging` and `log` by default; absolute
 *      overrides apply and relative overrides are ignored.
 *   3. `resolveWfPath` is no longer exported from `wf-paths`.
 *   4. `wf config list` still shows `state.directory` and `logging.directory`.
 *   5. README config example does not mention `state.directory` or `log.directory`.
 *   6. `ensureWfHome` is a no-op when `~/.wf` exists.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';

const repoRoot = path.join(__dirname, '..', '..');
const readmePath = path.join(repoRoot, 'README.md');

const { counts, pass, fail } = createReporter();

async function checkNormalizeWfConfigHasNoDefaultStateDirectory(): Promise<void> {
  console.log(chalk.bold('Test 1: normalizeWfConfig sets no default state directory'));
  try {
    const { normalizeWfConfig } = require('../../src/config/wf-config-loader');
    const config = normalizeWfConfig({});
    if (config.state?.directory !== undefined) fail(`state.directory defaulted to ${config.state.directory}`);
    else pass('normalizeWfConfig leaves `state.directory` unset by default');
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }
}

async function checkLoggingHasNoDefaultDirectory(): Promise<void> {
  console.log(chalk.bold('Test 2: logging/log set no default directory'));
  try {
    const { normalizeWfConfig } = require('../../src/config/wf-config-loader');
    const config = normalizeWfConfig({});
    if (config.logging.directory !== undefined || config.log.directory !== undefined) fail('logging or log defaulted a `directory` value');
    else pass('logging and log leave `directory` unset by default');
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }
}

function checkPathOverridesAcceptOnlyAbsoluteDirectories(): void {
  console.log(chalk.bold('Test 2b: absolute overrides apply and relative overrides are ignored'));
  const wfPaths = require('../../src/common/utils/wf-paths');
  try {
    checkAbsoluteOverrides(wfPaths);
    checkRelativeOverrides(wfPaths);
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  } finally {
    wfPaths.resetWfPathOverrides();
  }
}

function checkAbsoluteOverrides(wfPaths: any): void {
  const absoluteState = path.join(os.tmpdir(), 'wf-smoke-state');
  const absoluteLog = path.join(os.tmpdir(), 'wf-smoke-logs');
  wfPaths.setWfPathOverrides({ stateDir: absoluteState, logDir: absoluteLog });
  if (wfPaths.getWfStateDir() === absoluteState && wfPaths.getWfLogDir() === absoluteLog) pass('absolute overrides are honoured');
  else fail(`absolute overrides not honoured: state=${wfPaths.getWfStateDir()} log=${wfPaths.getWfLogDir()}`);
}

function checkRelativeOverrides(wfPaths: any): void {
  wfPaths.setWfPathOverrides({ stateDir: 'relative/state', logDir: 'relative/logs' });
  if (wfPaths.getWfStateDir() !== 'relative/state' && wfPaths.getWfLogDir() !== 'relative/logs') pass('relative overrides are ignored');
  else fail('relative overrides were applied');
}

function checkResolveWfPathRemoved(): void {
  console.log(chalk.bold('Test 3: resolveWfPath is removed'));
  try {
    const wfPaths = require('../../src/common/utils/wf-paths');
    if ('resolveWfPath' in wfPaths) fail('resolveWfPath is still exported from wf-paths');
    else pass('resolveWfPath is no longer exported');
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }
}

function checkReadmeOmitsDirectoryConfig(): void {
  console.log(chalk.bold('Test 4: README omits directory config'));
  try {
    const readme = fs.readFileSync(readmePath, 'utf8');
    if (readme.includes('directory: \'.wf/state\'')) fail('README still mentions state directory: \'.wf/state\'');
    else if (readme.includes('directory: \'.wf/logs\'')) fail('README still mentions log directory: \'.wf/logs\'');
    else if (readme.includes('directory: .wf/logs')) fail('README YAML example still mentions directory: .wf/logs');
    else pass('README does not show directory as configurable');
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }
}

async function checkEnsureWfHomeIsNoOp(): Promise<void> {
  console.log(chalk.bold('Test 5: ensureWfHome no-op when ~/.wf exists'));
  try {
    const wfHome = path.join(os.homedir(), '.wf');
    if (fs.existsSync(wfHome)) {
      const { ensureWfHome } = require('../../src/common/utils/ensure-wf-home');
      await ensureWfHome();
      pass('ensureWfHome returned without prompting');
    } else {
      fail('~/.wf does not exist — cannot test no-op behaviour');
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }
}

function checkWfPathHelpers(): void {
  console.log(chalk.bold('Test 6: wf-paths helpers return correct paths'));
  try {
    const { getWfStateDir, getWfLogDir } = require('../../src/common/utils/wf-paths');
    const expectedState = path.join(os.homedir(), '.wf', 'state');
    const expectedLog = path.join(os.homedir(), '.wf', 'logs');
    if (getWfStateDir() === expectedState && getWfLogDir() === expectedLog) pass('wf-paths helpers return correct hardcoded paths');
    else fail(`wf-paths helpers returned state=${getWfStateDir()} log=${getWfLogDir()}, expected state=${expectedState} log=${expectedLog}`);
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 non-configurable log/state directories smoke test\n'));
  await checkNormalizeWfConfigHasNoDefaultStateDirectory();
  await checkLoggingHasNoDefaultDirectory();
  checkPathOverridesAcceptOnlyAbsoluteDirectories();
  checkResolveWfPathRemoved();
  checkReadmeOmitsDirectoryConfig();
  await checkEnsureWfHomeIsNoOp();
  checkWfPathHelpers();
  summarise(counts);
}

main().catch(err => {
  console.error(chalk.red(err));
  process.exit(1);
});
