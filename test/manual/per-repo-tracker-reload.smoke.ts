/**
 * Manual smoke test: per-repo config reload updates tracker and nested config per repo
 *
 * Run: nr test:manual -- per-repo-tracker-reload
 *
 * Scenario: In a multi-repo wf run each repo may carry its own `wf.config.js`.
 * `initializeWfConfig` must reload and merge the config in-place so that
 * `getLoadedWfConfig().tracker` and `IssueTrackerService.getAdapter()` (no explicit
 * trackerName) both reflect the current repo — not the first repo — on each iteration.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { initializeWfConfig, getLoadedWfConfig } from '../../src/config/wf-config-loader';
import { IssueTrackerService } from '../../src/integrations/issue-trackers/issue-tracker.service';
import type { IssueTrackerAdapter } from '../../src/integrations/issue-trackers/issue-tracker-adapter.interface';
import type { ConfigService } from '@nestjs/config';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const buildAdapter = (name: string): IssueTrackerAdapter =>
  ({ getTrackerName: () => name } as unknown as IssueTrackerAdapter);

const stubConfigService = (): ConfigService =>
  ({ get: () => undefined } as unknown as ConfigService);

const mkProjectRoot = (tracker: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-smoke-'));
  fs.writeFileSync(
    path.join(dir, 'wf.config.js'),
    `module.exports = { tracker: '${tracker}' };`,
  );
  return dir;
};

async function main(): Promise<void> {
  console.log(chalk.bold('\nPer-repo tracker reload smoke test\n'));

  const cwdA = mkProjectRoot('jira');
  const cwdB = mkProjectRoot('github');

  try {
    const refA = await initializeWfConfig(cwdA);

    assert(
      'getLoadedWfConfig().tracker is jira after initializeWfConfig(cwdA)',
      getLoadedWfConfig().tracker === 'jira',
      `got: ${getLoadedWfConfig().tracker}`,
    );

    const refB = await initializeWfConfig(cwdB);

    assert(
      'getLoadedWfConfig().tracker is github after initializeWfConfig(cwdB)',
      getLoadedWfConfig().tracker === 'github',
      `got: ${getLoadedWfConfig().tracker}`,
    );

    assert(
      'second initializeWfConfig returns the same object reference (in-place mutation)',
      refB === refA,
      'references differ — a new object was allocated instead of mutating in-place',
    );

    const service = new IssueTrackerService(stubConfigService());
    const jiraAdapter = buildAdapter('jira');
    const githubAdapter = buildAdapter('github');
    service.registerAdapter(jiraAdapter);
    service.registerAdapter(githubAdapter);

    await initializeWfConfig(cwdA);
    assert(
      'IssueTrackerService.getAdapter() returns jira adapter after reload to cwdA',
      service.getAdapter() === jiraAdapter,
    );

    await initializeWfConfig(cwdB);
    assert(
      'IssueTrackerService.getAdapter() returns github adapter after reload to cwdB',
      service.getAdapter() === githubAdapter,
    );
  } finally {
    fs.rmSync(cwdA, { recursive: true, force: true });
    fs.rmSync(cwdB, { recursive: true, force: true });
  }

  const total = counts.passed + counts.failed;
  console.log(
    chalk.bold(
      `\n${total} assertions: ${chalk.green(`${counts.passed} passed`)}`
      + (counts.failed > 0 ? `, ${chalk.red(`${counts.failed} failed`)}` : ''),
    ),
  );
  if (counts.failed > 0) process.exit(1);
}

main();
