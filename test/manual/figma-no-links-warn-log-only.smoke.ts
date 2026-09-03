/**
 * Manual smoke test: appendToLogFile writes a WARN entry to the on-disk log file
 *
 * Confirms that calling appendToLogFile with level WARN actually lands a line in
 * the day's agent log on disk — verifying the live file-write side effect that
 * unit tests mock away.
 *
 * Run: nr test:manual -- figma-no-links-warn-log-only.smoke
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { appendToLogFile } from '../../src/shared/logger/log-file-writer';
import { getWfLogDir } from '../../src/shared/utils/wf-paths';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

function todaysLogPath(): string {
  return path.join(getWfLogDir(), `agent-${new Date().toISOString().slice(0, 10)}.log`);
}

async function main(): Promise<void> {
  console.log('Manual smoke: appendToLogFile writes WARN entry to on-disk log\n');

  const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-figma-warn-'));
  const origWfHome = process.env.WF_HOME;
  process.env.WF_HOME = wfHome;

  try {
    console.log(chalk.bold.cyan('\nTest 1: appendToLogFile writes the WARN entry to the log file'));

    const logPath = todaysLogPath();
    const sizeBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

    appendToLogFile(
      'WARN',
      'No Figma frame links found in ticket — figma-implement/figma-design-check will be skipped.',
      'figma-stage',
    );

    const written = fs.readFileSync(logPath, 'utf-8').slice(sizeBefore);
    if (/\[WARN\] \[figma-stage\] No Figma frame links found/.test(written)) {
      pass('Log file contains WARN [figma-stage] No Figma frame links found');
    } else {
      fail('Expected WARN entry not found in log file', written.slice(0, 300));
    }
  } finally {
    process.env.WF_HOME = origWfHome ?? undefined;
    fs.rmSync(wfHome, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: appendToLogFile writes WARN to disk');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
