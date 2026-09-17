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
 * Run: nr test:manual -- branch-name-pattern-flag-gate.smoke
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

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

const FLAG_ERROR = '--branch-name-pattern is not a valid regular expression: [';

function main(): void {
  console.log('\nManual smoke test: invalid --branch-name-pattern rejected at parse time\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-flag-gate-'));
  const git = (cmd: string): string => execSync(`git ${cmd}`, { cwd: tmpDir, encoding: 'utf-8' }).trim();

  try {
    fs.writeFileSync(path.join(tmpDir, 'wf.config.js'), 'module.exports = {};\n');
    git('init -q -b develop');
    git('config user.email "test@example.com"');
    git('config user.name "Test"');
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;\n');
    git('add .');
    git('commit -q -m init');

    const headBefore = git('rev-parse HEAD');
    const branchesBefore = git('branch --list');

    const implementResult = runCli("issue:implement -k WBP-1 --branch-name-pattern '['", tmpDir);
    if (implementResult.exitCode > 0 && implementResult.output.includes(FLAG_ERROR)) {
      pass('issue:implement rejects the invalid flag with the parse-time message');
    } else {
      fail('issue:implement should reject the invalid flag', `exit ${implementResult.exitCode}\n${implementResult.output.slice(0, 500)}`);
    }

    const issueResult = runCli("issue -k WBP-1 --action fix --branch-name-pattern '['", tmpDir);
    if (issueResult.exitCode > 0 && issueResult.output.includes(FLAG_ERROR)) {
      pass('issue rejects the invalid flag with the same message');
    } else {
      fail('issue should reject the invalid flag', `exit ${issueResult.exitCode}\n${issueResult.output.slice(0, 500)}`);
    }

    if (git('rev-parse HEAD') === headBefore && git('branch --list') === branchesBefore) {
      pass('rejected runs left the git repository untouched');
    } else {
      fail('rejected runs mutated the git repository', git('branch --list'));
    }

    const validResult = runCli("issue:implement -k WBP-1 --dry-run --branch-name-pattern '^[a-z]+\\/[\\w-]+$'", tmpDir);
    if (validResult.output.includes('not a valid regular expression')) {
      fail('a valid pattern should pass the flag gate', validResult.output.slice(0, 500));
    } else {
      pass('a valid pattern passes the flag gate');
    }

    const exclusionResult = runCli("issue:implement -k WBP-1 --no-branch --branch-name-pattern '['", tmpDir);
    if (exclusionResult.output.includes('mutually exclusive')) {
      pass('--no-branch with --branch-name-pattern still reports the mutual-exclusion error first');
    } else {
      fail('expected the mutual-exclusion error to fire first', exclusionResult.output.slice(0, 500));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
  console.log('\nManual smoke test passed: --branch-name-pattern flag gate');
}

main();
