/**
 * Manual smoke test: standalone issue:commit resolves scope summary from an
 * on-disk review artifact through the real command pipeline
 *
 * Run: nr test:manual -- test-issue-commit-standalone-review-scope-live
 *
 * Spins up the real NestJS app context and drives IssueCommitCommand's real
 * `.run()` against a real git repo with a staged change and a real review
 * artifact on disk. Only the outbound AI call (CommitStageService.
 * generateCommitMessage) is stubbed, so the resolution path — trackerName
 * lookup, resolveArtifactDir, readReviewArtifactSummary, the printed note —
 * is exercised through real DI-wired collaborators, not by calling
 * resolveCommitScopeSummary directly.
 *
 * Verifies:
 *   1. With a real review artifact on disk, the command prints the
 *      "prior review/plan" note and threads the exact review summary into
 *      the commit message generator
 *   2. A real git commit is created reflecting the (stubbed) generated message
 *   3. With the review artifact removed, a second real run neither prints the
 *      note nor passes any scope summary
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCommitCommand } from '../../src/commands/issue-commit.command';
import { CommitStageService } from '../../src/workflows/stages/commit-stage.service';
import { resolveReviewArtifactPath } from '../../src/shared/utils/resolve-review-summary';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();
const assert = (label: string, condition: boolean, detail?: string): void =>
  condition ? pass(label) : fail(label, detail);

const stageChange = (repoDir: string, contents: string): void => {
  const run = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: repoDir, stdio: 'pipe' });
  };
  fs.writeFileSync(path.join(repoDir, 'a.ts'), contents);
  run('add .');
};

async function main(): Promise<void> {
  console.log('\nManual smoke test: standalone issue:commit resolves scope summary from a real review artifact\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const commitCmd = app.get(IssueCommitCommand);
  const commitStageService = app.get(CommitStageService);

  const originalGenerate = commitStageService.generateCommitMessage.bind(commitStageService);
  let capturedOptions: Parameters<typeof commitStageService.generateCommitMessage>[0] | undefined;
  let callCount = 0;
  commitStageService.generateCommitMessage = async options => {
    capturedOptions = options;
    callCount++;
    return `canned commit message #${callCount}`;
  };

  const tmpWfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-standalone-review-home-'));
  const originalWfHome = process.env.WF_HOME;
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-standalone-review-repo-'));

  try {
    process.env.WF_HOME = tmpWfHome;

    const git = (cmd: string): void => {
      execSync(`git ${cmd}`, { cwd: tmpRepo, stdio: 'pipe' });
    };
    git('init');
    git('config user.email "test@example.com"');
    git('config user.name "Test User"');
    fs.writeFileSync(path.join(tmpRepo, 'a.ts'), 'export const a = 1;\n');
    git('add .');
    git('commit -m init');

    const ticketKey = 'WBP-9002';
    const trackerName = 'jira';
    const reviewPath = resolveReviewArtifactPath(tmpRepo, trackerName, ticketKey);
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    fs.writeFileSync(
      reviewPath,
      `# Code Review: ${ticketKey}\n\n## Summary\nLIVE REVIEW SCOPE SUMMARY\n\n## Issues\n- none\n`
    );

    stageChange(tmpRepo, 'export const a = 2;\n');

    let consoleOutput = '';
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput += args.join(' ') + '\n';
    };
    try {
      await commitCmd.run([], { ticketKey, repos: [tmpRepo], tracker: trackerName });
    } finally {
      console.log = originalLog;
    }

    assert('run 1: prints the prior review/plan note', consoleOutput.includes('Using scope summary from prior review/plan'), consoleOutput);
    assert(
      'run 1: commit message generator received the exact review summary',
      capturedOptions?.scopeSummary === 'LIVE REVIEW SCOPE SUMMARY',
      `got: ${JSON.stringify(capturedOptions)}`
    );

    const gitLog1 = execSync('git log -1 --format=%B', { cwd: tmpRepo, encoding: 'utf-8' });
    assert('run 1: a real git commit was created', gitLog1.includes('canned commit message #1'), gitLog1);

    fs.rmSync(reviewPath);
    stageChange(tmpRepo, 'export const a = 3;\n');

    consoleOutput = '';
    console.log = (...args: unknown[]) => {
      consoleOutput += args.join(' ') + '\n';
    };
    try {
      await commitCmd.run([], { ticketKey, repos: [tmpRepo], tracker: trackerName });
    } finally {
      console.log = originalLog;
    }

    assert('run 2: no prior review/plan note once the artifact is gone', !consoleOutput.includes('Using scope summary from prior review/plan'), consoleOutput);
    assert(
      'run 2: no scope summary is passed once the artifact is gone',
      capturedOptions?.scopeSummary === undefined,
      `got: ${JSON.stringify(capturedOptions)}`
    );

    const gitLog2 = execSync('git log -1 --format=%B', { cwd: tmpRepo, encoding: 'utf-8' });
    assert('run 2: a second real git commit was created', gitLog2.includes('canned commit message #2'), gitLog2);
  } finally {
    commitStageService.generateCommitMessage = originalGenerate;
    if (originalWfHome) process.env.WF_HOME = originalWfHome;
    else delete process.env.WF_HOME;
    fs.rmSync(tmpWfHome, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    await app.close();
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${counts.passed} passed   ${counts.failed} failed`);
  if (counts.failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (counts.failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
