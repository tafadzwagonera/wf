/**
 * Manual smoke test: bare --repos <value> form actually resolves config to
 * the target repo, not just a silent cwd fallback
 *
 * Run: nr test:manual repos-bare-form-resolves-target-config.smoke.ts
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');

const { counts, pass, fail } = createReporter();

interface CliResult {
  stdout: string;
  stderr: string;
}

const runCli = (args: string, cwd: string): CliResult => {
  try {
    const stdout = execSync(`node ${DIST_MAIN} ${args}`, {
      encoding: 'utf-8',
      cwd,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '' };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
};

const writeProviderConfig = (dir: string, provider: string): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'wf.config.js'),
    `module.exports = { ai: [{ provider: '${provider}', model: 'x', apiKey: 'k' }] };\n`
  );
};

const CALLER_MARKER = 'Google Gemini';
const SIBLING_MARKER = 'Anthropic Claude';

function checkCaseA(callerDir: string): void {
  const result = runCli('issue:commit --dry-run --repos sibling-repo', callerDir);
  const output = result.stdout + result.stderr;
  if (output.includes(SIBLING_MARKER)) {
    pass('bare --repos sibling-repo picks up the sibling config (provider marker: Anthropic Claude)');
  } else {
    fail('bare --repos sibling-repo did not pick up the sibling config', output.slice(0, 800));
  }
  if (output.includes(CALLER_MARKER)) {
    fail('bare --repos sibling-repo incorrectly used the caller\'s own config', output.slice(0, 800));
  } else {
    pass('bare --repos sibling-repo does NOT fall back to the caller\'s own config marker');
  }
}

function checkCaseB(callerDir: string): void {
  const result = runCli('issue:commit --dry-run -r sibling-repo', callerDir);
  const output = result.stdout + result.stderr;
  if (output.includes(SIBLING_MARKER)) {
    pass('-r sibling-repo picks up the sibling config (short-flag regression guard)');
  } else {
    fail('-r sibling-repo did not pick up the sibling config', output.slice(0, 800));
  }
}

function checkCaseC(callerDir: string): void {
  const result = runCli('issue:commit --dry-run', callerDir);
  const output = result.stdout + result.stderr;
  if (output.includes(CALLER_MARKER)) {
    pass('no --repos/-r flag resolves to the caller\'s own config (provider marker: Google Gemini)');
  } else {
    fail('no --repos/-r flag did not resolve to the caller\'s own config', output.slice(0, 800));
  }
}

function runChecks(callerDir: string, siblingDir: string): void {
  writeProviderConfig(callerDir, 'google');
  writeProviderConfig(siblingDir, 'anthropic');
  checkCaseA(callerDir);
  checkCaseB(callerDir);
  checkCaseC(callerDir);
}

function main(): void {
  console.log('\nManual smoke test: bare --repos <value> resolves the target repo config\n');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repos-bare-form-'));
  const callerDir = path.join(tempRoot, 'caller');
  const siblingDir = path.join(tempRoot, 'sibling-repo');
  try {
    runChecks(callerDir, siblingDir);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  summarise(counts);
}

main();
