/**
 * Manual smoke test: wf config clean
 *
 * Run: nr test:manual config-clean.smoke.ts
 *
 * Prerequisites: yarn build  (the CLI runs from dist/)
 *
 * Each scenario creates its own scratch sessions and cleans them up on exit.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import chalk from 'chalk';
import { createReporter, summarise } from './support/reporter';
import { buildSessionFileName } from '../../src/shared/utils/session-file-name';

const SESSION_DIR = path.join(os.homedir(), '.wf', 'state', 'sessions');

const { counts, pass, fail } = createReporter();

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
};

const parseExecError = (err: unknown): { stdout: string; stderr: string; status: number } => {
  const e = err as { stdout?: string; stderr?: string; status?: number };
  return {
    stdout: e.stdout ?? '',
    stderr: e.stderr ?? '',
    status: e.status ?? 1,
  };
};

const run = (args: string): { stdout: string; stderr: string; status: number } => {
  try {
    const stdout = execSync(`node dist/main.js config clean ${args}`, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    return parseExecError(err);
  }
};

const buildSessionObject = (now: string, overrides: {
  sessionId: string;
  ticketKey: string;
  createdAt?: string;
  completedAt?: string | null;
}): any => ({
  sessionId: overrides.sessionId,
  ticketKey: overrides.ticketKey,
  toStage: null, action: null, sourceType: null,
  customPlanRef: null,
  createdAt: overrides.createdAt ?? now,
  updatedAt: now,
  completedAt: overrides.completedAt ?? null,
  stages: {},
});

const writeSessionFile = (session: any): void => {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const filePath = path.join(SESSION_DIR, buildSessionFileName(session));
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
};

const createScratchSession = (overrides: {
  sessionId: string;
  ticketKey: string;
  createdAt?: string;
  completedAt?: string | null;
}): string => {
  const now = new Date().toISOString();
  const session = buildSessionObject(now, overrides);
  writeSessionFile(session);
  return session.sessionId;
};

const scratchSessionExists = (sessionId: string): boolean => {
  if (!fs.existsSync(SESSION_DIR)) return false;
  return fs.readdirSync(SESSION_DIR).some(f => f.includes(sessionId));
};

function cleanupSessions(sessionIds: string[]): void {
  for (const sid of sessionIds) {
    for (const f of fs.readdirSync(SESSION_DIR).filter(f => f.includes(sid))) {
      fs.unlinkSync(path.join(SESSION_DIR, f));
    }
  }
}

function checkScenario1(): void {
  const noFilter = run('');
  assert('exits with code 1', noFilter.status === 1, `status: ${noFilter.status}`);
  assert('stderr contains "At least one filter is required"', noFilter.stderr.includes('At least one filter is required'), noFilter.stderr.slice(0, 200));
}

function checkScenario2(): void {
  const sid2 = `smoke-test-${Date.now()}-a`;
  createScratchSession({ sessionId: sid2, ticketKey: 'SMOKE-2' });
  const dryRun = run(`--session-id ${sid2} --dry-run`);
  assert('exits with code 0', dryRun.status === 0, `status: ${dryRun.status}\n${dryRun.stderr}`);
  assert('stdout contains "Matched 1 session(s)"', dryRun.stdout.includes('Matched 1 session(s)'), dryRun.stdout.slice(0, 300));
  assert('stdout contains "Dry run"', dryRun.stdout.includes('Dry run'), dryRun.stdout.slice(0, 300));
  assert('session file still exists after --dry-run', scratchSessionExists(sid2));
  cleanupSessions([sid2]);
}

function checkScenario3(): void {
  const sid3 = `smoke-test-${Date.now()}-b`;
  createScratchSession({ sessionId: sid3, ticketKey: 'SMOKE-3-UNIQUE' });
  const forceDelete = run('--ticket SMOKE-3-UNIQUE --force');
  assert('exits with code 0', forceDelete.status === 0, `status: ${forceDelete.status}\n${forceDelete.stderr}`);
  assert('stdout contains "Deleted 1 session(s)"', forceDelete.stdout.includes('Deleted 1 session(s)'), forceDelete.stdout.slice(0, 300));
  assert('session file is gone after delete', !scratchSessionExists(sid3));
}

function checkScenario4(): void {
  const sid4a = `smoke-test-${Date.now()}-c`;
  const sid4b = `smoke-test-${Date.now()}-d`;
  createScratchSession({ sessionId: sid4a, ticketKey: 'SMOKE-PAT-123' });
  createScratchSession({ sessionId: sid4b, ticketKey: 'OTHER-99' });
  const patternRun = run('--pattern "^SMOKE-PAT-" --dry-run');
  assert('exits with code 0', patternRun.status === 0, `status: ${patternRun.status}\n${patternRun.stderr}`);
  assert('stdout contains the matching ticket key', patternRun.stdout.includes('SMOKE-PAT-123'), patternRun.stdout.slice(0, 300));
  assert('stdout does not contain the non-matching ticket key', !patternRun.stdout.includes('OTHER-99'), patternRun.stdout.slice(0, 300));
  cleanupSessions([sid4a, sid4b]);
}

function checkScenario5(): void {
  const sid5old = `smoke-test-${Date.now()}-e`;
  const sid5new = `smoke-test-${Date.now()}-f`;
  createScratchSession({ sessionId: sid5old, ticketKey: 'SMOKE-BEFORE-OLD', createdAt: '2020-01-01T00:00:00.000Z' });
  createScratchSession({ sessionId: sid5new, ticketKey: 'SMOKE-BEFORE-NEW' });
  const beforeRun = run('--before 2021-01-01 --dry-run');
  assert('exits with code 0', beforeRun.status === 0, `status: ${beforeRun.status}\n${beforeRun.stderr}`);
  assert('stdout contains the old session ticket key', beforeRun.stdout.includes('SMOKE-BEFORE-OLD'), beforeRun.stdout.slice(0, 300));
  assert('stdout does not contain the new session ticket key', !beforeRun.stdout.includes('SMOKE-BEFORE-NEW'), beforeRun.stdout.slice(0, 300));
  cleanupSessions([sid5old, sid5new]);
}

function checkScenario6(): void {
  const sid6active = `smoke-test-${Date.now()}-g`;
  const sid6done = `smoke-test-${Date.now()}-h`;
  createScratchSession({ sessionId: sid6active, ticketKey: 'SMOKE-STATUS', completedAt: null });
  createScratchSession({ sessionId: sid6done, ticketKey: 'SMOKE-STATUS', completedAt: new Date().toISOString() });
  const statusRun = run('--ticket SMOKE-STATUS --dry-run');
  assert('exits with code 0', statusRun.status === 0, `status: ${statusRun.status}\n${statusRun.stderr}`);
  assert('stdout contains "status: active"', statusRun.stdout.includes('status: active'), statusRun.stdout.slice(0, 400));
  assert('stdout contains "status: completed"', statusRun.stdout.includes('status: completed'), statusRun.stdout.slice(0, 400));
  cleanupSessions([sid6active, sid6done]);
}

function checkScenario7(): void {
  const sid7 = `smoke-test-${Date.now()}-i`;
  createScratchSession({ sessionId: sid7, ticketKey: 'SMOKE-NOFORCE' });
  const noForce = run(`--session-id ${sid7}`);
  assert('exits with code 1', noForce.status === 1, `status: ${noForce.status}`);
  assert('stderr contains "Non-interactive mode requires --force"', noForce.stderr.includes('Non-interactive mode requires --force'), noForce.stderr.slice(0, 200));
  assert('session file still exists (no delete occurred)', scratchSessionExists(sid7));
  cleanupSessions([sid7]);
}

function checkScenario8(): void {
  const noMatchRun = run('--session-id this-id-does-not-exist-at-all --force');
  assert('exits with code 0', noMatchRun.status === 0, `status: ${noMatchRun.status}\n${noMatchRun.stderr}`);
  assert('stdout contains "No matching sessions found."', noMatchRun.stdout.includes('No matching sessions found.'), noMatchRun.stdout.slice(0, 200));
}

const ensureDistBuilt = (): void => {
  if (!fs.existsSync(path.join(process.cwd(), 'dist', 'main.js'))) {
    console.error(chalk.red('dist/main.js not found — run `yarn build` first.'));
    process.exit(1);
  }
};

function main(): void {
  console.log(chalk.bold.cyan('\nconfig-clean smoke tests\n'));
  ensureDistBuilt();
  checkScenario1();
  checkScenario2();
  checkScenario3();
  checkScenario4();
  checkScenario5();
  checkScenario6();
  checkScenario7();
  checkScenario8();
  summarise(counts);
}

main();
