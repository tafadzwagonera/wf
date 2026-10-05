/**
 * Manual Test: CommitterAgent generates accurate commit messages and executes commits
 *
 * Run: nr test:manual committer-diff.smoke.ts
 *
 * Verifies:
 *   1. CommitterAgent.execute() generates a meaningful commit message from the unstaged diff
 *   2. When ticket context (plan summary) is provided, the message reflects the ticket's intent
 *   3. A real git commit is created in the target repo directory
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { CommitterAgent } from '../../src/agents/committer.agent';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const TICKET_CONTEXT = 'Prevent solo travelers from selecting double room options by adding validation in service-passengerv1';

const wfConfigFiles = ['wf.config.js', 'wf.config.mjs', 'wf.config.ts', 'wf.config.mts', 'wf.config.yaml', 'wf.config.yml'];

const INITIAL_V2_CONTENT = [
  'export const updatePax = (pax: any) => {',
  '  if (pax.travelers === 1 && pax.roomShare === "Double bed room") {',
  '    throw new Error("Solo travelers cannot select double room");',
  '  }',
  '  return pax;',
  '};',
  '',
  'const hasMultipleTravelers = (pax: any) => pax.travelers > 1;',
  'export { hasMultipleTravelers };',
].join('\n');

const INITIAL_V3_CONTENT = [
  'export const updatePax = (pax: any) => {',
  '  // v2: stricter validation',
  '  if (pax.travelers === 1 && pax.roomShare === "Double bed room") {',
  '    throw new Error("Solo travelers cannot select double room");',
  '  }',
  '  return pax;',
  '};',
  '',
  'const hasMultipleTravelers = (pax: any) => pax.travelers > 1;',
  'export { hasMultipleTravelers };',
].join('\n');

const INITIAL_V4_CONTENT = [
  'export const updatePax = (pax: any) => {',
  '  // v3: even stricter',
  '  if (pax.travelers === 1 && pax.roomShare === "Double bed room") {',
  '    throw new Error("Solo travelers cannot select double room");',
  '  }',
  '  return pax;',
  '};',
].join('\n');

function setupInitialRepo(tmpDir: string): void {
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  const initialFile = path.join(tmpDir, 'passenger.service.ts');
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  fs.writeFileSync(initialFile, 'export const updatePax = (pax: any) => pax;\n');
  git('add .');
  git('commit -m "init"');
  fs.writeFileSync(initialFile, INITIAL_V2_CONTENT);
}

function interceptStdout(): { getOutput: () => string; restore: () => void } {
  let output = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any) => {
    output += String(chunk);
    return originalWrite(chunk);
  };
  return {
    getOutput: () => output,
    restore: () => { (process.stdout.write as any) = originalWrite; },
  };
}

async function captureCommitterOutput(
  committer: CommitterAgent,
  ticketKey: string,
  dir: string,
  context: string,
): Promise<string> {
  const { getOutput, restore } = interceptStdout();
  try {
    await committer.execute(ticketKey, dir, context);
  } finally {
    restore();
  }
  return getOutput();
}

function getGitLog(dir: string): string {
  try {
    return execSync('git log --oneline -1', { cwd: dir, encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function getCommittedFiles(dir: string): string {
  try {
    return execSync('git show --name-only --format="" HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function checkEmptyDiffAndPrefix(output: string): void {
  const lowerOutput = output.toLowerCase();
  if (lowerOutput.includes('git diff is empty') || lowerOutput.includes('no changes to analyze')) {
    fail('Commit message contains empty-diff error text', output.slice(0, 200));
  } else {
    pass('Commit message does not contain empty-diff error text');
  }
  if (output.includes('TEST-001:')) pass('Commit message is prefixed with ticket key TEST-001:');
  else fail('Commit message is not prefixed with TEST-001:', output.slice(0, 200));
}

function checkIntentAndCommit(output: string, dir: string): void {
  const lowerOutput = output.toLowerCase();
  const intentKeywords = ['solo', 'traveler', 'room', 'double', 'prevent', 'validat', 'single'];
  if (intentKeywords.some(kw => lowerOutput.includes(kw))) pass('Commit message reflects ticket intent (contains domain keyword)');
  else fail('Commit message does not reflect ticket intent', output.slice(0, 300));
  const gitLog = getGitLog(dir);
  if (gitLog.includes('TEST-001:')) pass('Git commit was created in the repo (git log shows TEST-001:)');
  else fail('No git commit was created', gitLog ? `git log: ${gitLog.trim()}` : 'git log failed');
  if (output.includes('git push') && !output.includes('git add .')) pass('Output shows only git push as next step (add/commit already executed)');
  else fail('Output should show git push and NOT git add .', output.slice(0, 300));
}

async function runTest6Setup(committer: CommitterAgent, tmpDir: string): Promise<string> {
  const initialFile = path.join(tmpDir, 'passenger.service.ts');
  const wfDir = path.join(tmpDir, '.wf', 'jira');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'ticket.json'), JSON.stringify({ key: 'TEST-001' }));
  fs.writeFileSync(initialFile, INITIAL_V3_CONTENT);
  await captureCommitterOutput(committer, 'TEST-002', tmpDir, TICKET_CONTEXT);
  return getCommittedFiles(tmpDir);
}

function checkWfExclusion(committedFiles: string): void {
  if (committedFiles.includes('.wf/')) fail('.wf/** files appeared in the commit — exclusion not working', committedFiles);
  else pass('.wf/** artifact files were NOT committed');
  if (committedFiles.includes('passenger.service.ts')) pass('Source file passenger.service.ts WAS committed');
  else fail('Source file was not committed — pathspec exclusion too broad', committedFiles);
}

async function runTest7Setup(committer: CommitterAgent, tmpDir: string): Promise<string> {
  const initialFile = path.join(tmpDir, 'passenger.service.ts');
  for (const cfgFile of wfConfigFiles) {
    fs.writeFileSync(path.join(tmpDir, cfgFile), `// wf tooling config — should never be committed\nmodule.exports = {};\n`);
  }
  fs.writeFileSync(initialFile, INITIAL_V4_CONTENT);
  await captureCommitterOutput(committer, 'TEST-003', tmpDir, TICKET_CONTEXT);
  return getCommittedFiles(tmpDir);
}

function checkConfigExclusion(committedFiles: string): void {
  const leakedConfig = wfConfigFiles.find(f => committedFiles.includes(f));
  if (leakedConfig) fail(`wf config file leaked into commit: ${leakedConfig}`, committedFiles);
  else pass('wf.config.* files were NOT committed');
  if (committedFiles.includes('passenger.service.ts')) pass('Source file passenger.service.ts WAS committed alongside wf config files');
  else fail('Source file was not committed — wf.config.* exclusion too broad', committedFiles);
}

async function runAllChecks(committer: CommitterAgent, tmpDir: string): Promise<void> {
  setupInitialRepo(tmpDir);
  const output1 = await captureCommitterOutput(committer, 'TEST-001', tmpDir, TICKET_CONTEXT);
  checkEmptyDiffAndPrefix(output1);
  checkIntentAndCommit(output1, tmpDir);
  checkWfExclusion(await runTest6Setup(committer, tmpDir));
  checkConfigExclusion(await runTest7Setup(committer, tmpDir));
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const committer = app.get(CommitterAgent);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-committer-test-'));
  try {
    await runAllChecks(committer, tmpDir);
  } finally {
    await app.close();
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
