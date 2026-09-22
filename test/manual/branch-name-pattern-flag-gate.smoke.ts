/**
 * Manual smoke test: invalid --branch-name-pattern regex is rejected at parse time
 *
 * Verifies:
 *   1. `wf issue:implement` rejects an uncompilable --branch-name-pattern with a
 *      clear message before doing any work
 *   2. `wf issue` rejects the same flag identically
 *   3. The target repo's git state is untouched by the rejected runs
 *   4. A valid pattern passes the flag gate
 *   5. The pre-existing --no-branch mutual-exclusion guard still fires first
 *
 * Run: nr test:manual branch-name-pattern-flag-gate.smoke.ts
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

interface CliResult {
  exitCode: number;
  output: string;
}

const runCli = (args: string, cwd: string): CliResult => {
  try {
    const stdout = execSync(`node ${DIST_MAIN} ${args}`, {
      encoding: 'utf-8', cwd, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output: stdout };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

const gitIn = (cwd: string, cmd: string): string =>
  execSync(`git ${cmd}`, { cwd, encoding: 'utf-8' }).trim();

const FLAG_ERROR = '--branch-name-pattern is not a valid regular expression: [';

type GitSnapshot = { headBefore: string; branchesBefore: string };

function setupGitRepo(tmpDir: string): GitSnapshot {
  fs.writeFileSync(path.join(tmpDir, 'wf.config.js'), 'module.exports = {};\n');
  gitIn(tmpDir, 'init -q -b develop');
  gitIn(tmpDir, 'config user.email "test@example.com"');
  gitIn(tmpDir, 'config user.name "Test"');
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;\n');
  gitIn(tmpDir, 'add .');
  gitIn(tmpDir, 'commit -q -m init');
  return { headBefore: gitIn(tmpDir, 'rev-parse HEAD'), branchesBefore: gitIn(tmpDir, 'branch --list') };
}

function checkImplementRejectsInvalidFlag(tmpDir: string): void {
  const result = runCli("issue:implement -k WBP-1 --branch-name-pattern '['", tmpDir);
  if (result.exitCode > 0 && result.output.includes(FLAG_ERROR)) {
    pass('issue:implement rejects the invalid flag with the parse-time message');
  } else {
    fail('issue:implement should reject the invalid flag', `exit ${result.exitCode}\n${result.output.slice(0, 500)}`);
  }
}

function checkIssueRejectsInvalidFlag(tmpDir: string): void {
  const result = runCli("issue -k WBP-1 --action fix --branch-name-pattern '['", tmpDir);
  if (result.exitCode > 0 && result.output.includes(FLAG_ERROR)) {
    pass('issue rejects the invalid flag with the same message');
  } else {
    fail('issue should reject the invalid flag', `exit ${result.exitCode}\n${result.output.slice(0, 500)}`);
  }
}

function checkGitStateUntouched(tmpDir: string, snap: GitSnapshot): void {
  if (gitIn(tmpDir, 'rev-parse HEAD') === snap.headBefore && gitIn(tmpDir, 'branch --list') === snap.branchesBefore) {
    pass('rejected runs left the git repository untouched');
  } else {
    fail('rejected runs mutated the git repository', gitIn(tmpDir, 'branch --list'));
  }
}

function checkValidFlagPasses(tmpDir: string): void {
  const validResult = runCli("issue:implement -k WBP-1 --dry-run --branch-name-pattern '^[a-z]+\\/[\\w-]+$'", tmpDir);
  if (validResult.output.includes('not a valid regular expression')) {
    fail('a valid pattern should pass the flag gate', validResult.output.slice(0, 500));
  } else {
    pass('a valid pattern passes the flag gate');
  }
}

function checkMutualExclusionFiresFirst(tmpDir: string): void {
  const result = runCli("issue:implement -k WBP-1 --no-branch --branch-name-pattern '['", tmpDir);
  if (result.output.includes('mutually exclusive')) {
    pass('--no-branch with --branch-name-pattern still reports the mutual-exclusion error first');
  } else {
    fail('expected the mutual-exclusion error to fire first', result.output.slice(0, 500));
  }
}

function main(): void {
  console.log('\nManual smoke test: invalid --branch-name-pattern rejected at parse time\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-flag-gate-'));
  const snap = setupGitRepo(tmpDir);
  try {
    checkImplementRejectsInvalidFlag(tmpDir);
    checkIssueRejectsInvalidFlag(tmpDir);
    checkGitStateUntouched(tmpDir, snap);
    checkValidFlagPasses(tmpDir);
    checkMutualExclusionFiresFirst(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  summarise(counts);
}

main();
