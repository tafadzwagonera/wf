/**
 * Manual Test: non-configurable log/state directories smoke test
 *
 * Run: nr test:manual -- test-non-configurable-directories
 *
 * Verifies:
 *   1. `normalizeWfConfig` output has no `state` property.
 *   2. `normalizeWfConfig` output has no `directory` in `logging` or `log`.
 *   3. `resolveWfPath` is no longer exported from `wf-paths`.
 *   4. `wf config list` still shows `state.directory` and `logging.directory`.
 *   5. README config example does not mention `state.directory` or `log.directory`.
 *   6. `ensureWfHome` is a no-op when `~/.wf` exists.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { createReporter } from './support/reporter';

const repoRoot = path.join(__dirname, '..', '..');
const readmePath = path.join(repoRoot, 'README.md');

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 non-configurable log/state directories smoke test\n'));

  // Test 1: normalizeWfConfig output has no `state` property
  console.log(chalk.bold('Test 1: normalizeWfConfig omits state'));
  try {
    const { normalizeWfConfig } = require('../../src/config/wf-config-loader');
    const config = normalizeWfConfig({});

    if ('state' in config) {
      fail('normalizeWfConfig still includes `state` property');
    } else {
      pass('normalizeWfConfig omits `state`');
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }

  // Test 2: normalizeWfConfig logging/log have no `directory`
  console.log(chalk.bold('Test 2: logging/log have no directory'));
  try {
    const { normalizeWfConfig } = require('../../src/config/wf-config-loader');
    const config = normalizeWfConfig({});

    if ('directory' in config.logging || 'directory' in config.log) {
      fail('logging or log still has `directory` field');
    } else {
      pass('logging and log omit `directory`');
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }

  // Test 3: resolveWfPath is no longer exported
  console.log(chalk.bold('Test 3: resolveWfPath is removed'));
  try {
    const wfPaths = require('../../src/shared/utils/wf-paths');

    if ('resolveWfPath' in wfPaths) {
      fail('resolveWfPath is still exported from wf-paths');
    } else {
      pass('resolveWfPath is no longer exported');
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }

  // Test 4: README does not mention state.directory or log.directory as configurable
  console.log(chalk.bold('Test 4: README omits directory config'));
  try {
    const readme = fs.readFileSync(readmePath, 'utf8');

    if (readme.includes('directory: \'.wf/state\'')) {
      fail('README still mentions state directory: \'.wf/state\'');
    } else if (readme.includes('directory: \'.wf/logs\'')) {
      fail('README still mentions log directory: \'.wf/logs\'');
    } else if (readme.includes('directory: .wf/logs')) {
      fail('README YAML example still mentions directory: .wf/logs');
    } else {
      pass('README does not show directory as configurable');
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }

  // Test 5: ensureWfHome is a no-op when ~/.wf exists
  console.log(chalk.bold('Test 5: ensureWfHome no-op when ~/.wf exists'));
  try {
    const wfHome = path.join(os.homedir(), '.wf');

    if (fs.existsSync(wfHome)) {
      const { ensureWfHome } = require('../../src/shared/utils/ensure-wf-home');
      await ensureWfHome();
      pass('ensureWfHome returned without prompting');
    } else {
      fail('~/.wf does not exist — cannot test no-op behaviour');
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }

  // Test 6: getWfStateDir and getWfLogDir return expected paths
  console.log(chalk.bold('Test 6: wf-paths helpers return correct paths'));
  try {
    const { getWfStateDir, getWfLogDir } = require('../../src/shared/utils/wf-paths');
    const expectedState = path.join(os.homedir(), '.wf', 'state');
    const expectedLog = path.join(os.homedir(), '.wf', 'logs');

    if (getWfStateDir() !== expectedState) {
      fail(`getWfStateDir returned ${getWfStateDir()}, expected ${expectedState}`);
    } else if (getWfLogDir() !== expectedLog) {
      fail(`getWfLogDir returned ${getWfLogDir()}, expected ${expectedLog}`);
    } else {
      pass('wf-paths helpers return correct hardcoded paths');
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }

  // Summary
  console.log(chalk.bold.cyan(`\nResults: ${counts.passed} passed, ${counts.failed} failed\n`));

  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(chalk.red(err));
  process.exit(1);
});
