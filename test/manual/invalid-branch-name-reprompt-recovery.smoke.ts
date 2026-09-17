/**
 * Manual smoke test: implement stage recovers from an invalid branch name by
 * logging and re-prompting instead of terminating
 *
 * Verifies:
 *   1. A generated name that violates the configured pattern does not end the
 *      workflow — the branch-name prompt reopens with the rejected name as its
 *      default
 *   2. The failure is appended to ~/.wf/logs/agent-<today>.log with the
 *      [implement] context
 *   3. A pasted `git checkout -b team/recovered-branch` answer is sanitized and
 *      creates that real branch, leaving HEAD on it
 *   4. The reopened prompt validates input inline against the configured pattern
 *   5. In non-interactive mode the same failure propagates and creates no branch
 *
 * Run: nr test:manual -- invalid-branch-name-reprompt-recovery.smoke
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import inquirer from 'inquirer';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import { getWfLogDir } from '../../src/shared/utils/wf-paths';
import type { PlanArtifact, TicketArtifact } from '../../src/agents/interfaces';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();

const CONFIGURED_PATTERN = '^team\\/[a-z-]+$';

const readAgentLog = (): string => {
  const logFile = path.join(getWfLogDir(), `agent-${new Date().toISOString().split('T')[0]}.log`);
  if (fs.existsSync(logFile)) return fs.readFileSync(logFile, 'utf-8');
  return '';
};

const countRecoveryLogLines = (log: string): number =>
  log.split('\n').filter(line => line.includes('[implement]') && line.includes('Invalid branch name')
    && line.includes('WBP-9101')).length;

async function main(): Promise<void> {
  console.log('Manual smoke: invalid branch name re-prompt recovery\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const implementer = app.get(ImplementerAgent);
  const configService = app.get(ConfigService);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reprompt-recovery-'));
  git(repoDir, ['init', '-q', '-b', 'develop']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# repo\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-q', '-m', 'base']);

  const originalGet = configService.get.bind(configService);
  (configService as any).get = (key: string, fallback?: unknown) =>
    key === 'git.branchNamePattern' ? CONFIGURED_PATTERN : originalGet(key, fallback);

  const originalIsInteractive = (implementer as any).isInteractiveSession;
  const originalPrompt = inquirer.prompt;

  let customNameQuestion: any;
  const scriptedPrompt = async (questions: any[]): Promise<Record<string, unknown>> => {
    const [question] = questions;
    if (question.name === 'branchAction') return { branchAction: 'create' };
    if (question.name === 'shouldPull') return { shouldPull: false };
    if (question.name === 'choice') return { choice: 'accept' };
    if (question.name === 'customName') {
      customNameQuestion = question;
      return { customName: 'git checkout -b team/recovered-branch' };
    }
    throw new Error(`Unscripted prompt: ${question.name}`);
  };

  const ticket: TicketArtifact = {
    ticketKey: 'WBP-9101',
    content: '# WBP-9101: Reprompt recovery smoke\n',
    path: path.join(repoDir, 'WBP-9101.md'),
  };
  const planArtifact: PlanArtifact = {
    action: 'feature',
    path: path.join(repoDir, 'WBP-9101-plan-feature.json'),
    plan: {
      action: 'feature',
      summary: 'Reprompt recovery smoke',
      steps: ['n/a'],
      estimatedComplexity: 'low',
      affectedFiles: [],
      affectedRepositories: ['repo'],
      risks: [],
    },
  };
  const options = { trackerName: 'jira', repoDir, silent: false, suppressHeader: true };

  try {
    (implementer as any).isInteractiveSession = () => true;
    (inquirer as any).prompt = scriptedPrompt;
    const recoveryLinesBefore = countRecoveryLogLines(readAgentLog());

    const branchName = await (implementer as any).handleBranchWorkflow(ticket, planArtifact, options);

    if (branchName === 'team/recovered-branch') {
      pass('workflow survived the invalid generated name and returned the recovered branch');
    } else {
      fail('expected the recovered branch name', `got: ${branchName}`);
    }

    const branchIsReal = git(repoDir, ['branch', '--list', 'team/recovered-branch']).includes('team/recovered-branch');
    const headIsRecovered = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'team/recovered-branch';
    if (branchIsReal && headIsRecovered) {
      pass('pasted `git checkout -b team/recovered-branch` was sanitized into a real, checked-out branch');
    } else {
      fail('recovered branch missing or not checked out', git(repoDir, ['branch', '--list']));
    }

    if (customNameQuestion?.default === 'feature/WBP-9101__reprompt-recovery-smoke') {
      pass('reopened prompt carried the rejected name as its default');
    } else {
      fail('expected the rejected generated name as the prompt default', `got: ${customNameQuestion?.default}`);
    }

    if (typeof customNameQuestion?.validate === 'function'
      && customNameQuestion.validate('git checkout -b team/inline-check') === true
      && String(customNameQuestion.validate('fix/rejected')).includes(CONFIGURED_PATTERN)) {
      pass('reopened prompt validates inline against the configured pattern');
    } else {
      fail('expected an inline validate callback honoring the configured pattern');
    }

    const recoveryLinesAfter = countRecoveryLogLines(readAgentLog());
    if (recoveryLinesAfter > recoveryLinesBefore) {
      pass('failure was appended to the agent log with the [implement] context');
    } else {
      fail('expected a new [implement] Invalid-branch-name log line', `before: ${recoveryLinesBefore}, after: ${recoveryLinesAfter}`);
    }

    git(repoDir, ['checkout', '-q', 'develop']);
    git(repoDir, ['branch', '-q', '-D', 'team/recovered-branch']);
    (implementer as any).isInteractiveSession = () => false;

    let nonInteractiveError: Error | undefined;
    try {
      await (implementer as any).handleBranchWorkflow(ticket, planArtifact, { ...options, silent: true });
    } catch (error) {
      nonInteractiveError = error as Error;
    }
    const branchListAfter = git(repoDir, ['branch', '--list']);
    if (nonInteractiveError?.message.includes('Invalid branch name') && branchListAfter === '* develop') {
      pass('non-interactive mode propagates the error and creates no branch');
    } else {
      fail('expected a propagated Invalid-branch-name error and no new branch',
        `error: ${nonInteractiveError?.message}, branches: ${branchListAfter}`);
    }
  } finally {
    (configService as any).get = originalGet;
    (implementer as any).isInteractiveSession = originalIsInteractive;
    (inquirer as any).prompt = originalPrompt;
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  await app.close();
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: invalid branch name re-prompt recovery');
}

main().catch(error => {
  console.error(`\nManual smoke test failed: ${error.message}`);
  process.exit(1);
});
