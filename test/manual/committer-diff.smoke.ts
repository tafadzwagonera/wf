/**
 * Manual Test: CommitterAgent generates accurate commit messages and executes commits
 *
 * Run: nr test:manual -- test-committer-diff
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
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  let tmpDir: string | undefined;

  try {
    // ── Set up temporary git repo ──────────────────────────────────────────
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-committer-test-'));

    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });

    git('init');
    git('config user.email "test@example.com"');
    git('config user.name "Test User"');

    // Create an initial commit so HEAD exists
    const initialFile = path.join(tmpDir, 'passenger.service.ts');
    fs.writeFileSync(initialFile, 'export const updatePax = (pax: any) => pax;\n');
    git('add .');
    git('commit -m "init"');

    // Simulate ImplementerAgent: write file changes without staging
    fs.writeFileSync(
      initialFile,
      [
        'export const updatePax = (pax: any) => {',
        '  if (pax.travelers === 1 && pax.roomShare === "Double bed room") {',
        '    throw new Error("Solo travelers cannot select double room");',
        '  }',
        '  return pax;',
        '};',
        '',
        'const hasMultipleTravelers = (pax: any) => pax.travelers > 1;',
        'export { hasMultipleTravelers };',
      ].join('\n')
    );

    // ── Capture stdout from CommitterAgent ────────────────────────────────
    const committer = app.get(CommitterAgent);

    let output = '';

    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as any) = (chunk: any) => {
      output += String(chunk);
      return originalWrite(chunk);
    };

    console.log('\n🧪 CommitterAgent: ticket context → accurate commit message + real commit\n');
    console.log('─'.repeat(60));

    const ticketContext
      = 'Prevent solo travelers from selecting double room options by adding validation in service-passengerv1';

    try {
      await committer.execute('TEST-001', tmpDir, ticketContext);
    } finally {
      (process.stdout.write as any) = originalWrite;
    }

    // ── Assertions ────────────────────────────────────────────────────────
    const lowerOutput = output.toLowerCase();

    // 1. No empty-diff error
    if (!lowerOutput.includes('git diff is empty') && !lowerOutput.includes('no changes to analyze')) {
      pass('Commit message does not contain empty-diff error text');
    } else {
      fail('Commit message contains empty-diff error text', output.slice(0, 200));
    }

    // 2. Ticket key prefix
    if (output.includes('TEST-001:')) {
      pass('Commit message is prefixed with ticket key TEST-001:');
    } else {
      fail('Commit message is not prefixed with TEST-001:', output.slice(0, 200));
    }

    // 3. Message reflects ticket intent (not just implementation detail)
    const intentKeywords = ['solo', 'traveler', 'room', 'double', 'prevent', 'validat', 'single'];
    const hasIntentWord = intentKeywords.some(kw => lowerOutput.includes(kw));
    if (hasIntentWord) {
      pass('Commit message reflects ticket intent (contains domain keyword)');
    } else {
      fail('Commit message does not reflect ticket intent', output.slice(0, 300));
    }

    // 4. Commit was actually created
    let gitLog: string;
    try {
      gitLog = execSync('git log --oneline -1', {
        cwd: tmpDir,
        encoding: 'utf-8',
      });
    } catch {
      gitLog = '';
    }
    if (gitLog.includes('TEST-001:')) {
      pass('Git commit was created in the repo (git log shows TEST-001:)');
    } else {
      fail('No git commit was created', gitLog ? `git log: ${gitLog.trim()}` : 'git log failed');
    }

    // 5. Next step shows git push (not git add/commit)
    if (output.includes('git push') && !output.includes('git add .')) {
      pass('Output shows only git push as next step (add/commit already executed)');
    } else {
      fail('Output should show git push and NOT git add .', output.slice(0, 300));
    }

    // ── Test 6: .wf/** files are never staged/committed ───────────────────
    console.log('\n─'.repeat(30));
    console.log('Test 6: .wf/** exclusion from commits\n');

    // Create a .wf/jira/ artifact file that must never be committed
    const wfDir = path.join(tmpDir, '.wf', 'jira');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'ticket.json'), JSON.stringify({ key: 'TEST-001' }));

    // Make another source change so there is something real to commit
    fs.writeFileSync(
      initialFile,
      [
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
      ].join('\n')
    );

    output = '';
    const originalWrite2 = process.stdout.write.bind(process.stdout);

    (process.stdout.write as any) = (chunk: any) => {
      output += String(chunk);
      return originalWrite2(chunk);
    };

    try {
      await committer.execute('TEST-002', tmpDir, ticketContext);
    } finally {
      (process.stdout.write as any) = originalWrite2;
    }

    let committedFiles: string;
    try {
      committedFiles = execSync('git show --name-only --format="" HEAD', {
        cwd: tmpDir,
        encoding: 'utf-8',
      }).trim();
    } catch {
      committedFiles = '';
    }

    if (committedFiles.includes('.wf/')) {
      fail('.wf/** files appeared in the commit — exclusion not working', committedFiles);
    } else {
      pass('.wf/** artifact files were NOT committed');
    }

    if (committedFiles.includes('passenger.service.ts')) {
      pass('Source file passenger.service.ts WAS committed');
    } else {
      fail('Source file was not committed — pathspec exclusion too broad', committedFiles);
    }

    // ── Test 7: wf.config.* files are never staged/committed ──────────────
    console.log('\n─'.repeat(30));
    console.log('Test 7: wf.config.* exclusion from commits\n');

    // Simulate the implementer agent creating wf config files in the target repo
    const wfConfigFiles = [
      'wf.config.js',
      'wf.config.mjs',
      'wf.config.ts',
      'wf.config.mts',
      'wf.config.yaml',
      'wf.config.yml',
    ];
    for (const cfgFile of wfConfigFiles) {
      fs.writeFileSync(
        path.join(tmpDir, cfgFile),
        `// wf tooling config — should never be committed\nmodule.exports = {};\n`
      );
    }

    // Make another source change so there is something real to commit
    fs.writeFileSync(
      initialFile,
      [
        'export const updatePax = (pax: any) => {',
        '  // v3: even stricter',
        '  if (pax.travelers === 1 && pax.roomShare === "Double bed room") {',
        '    throw new Error("Solo travelers cannot select double room");',
        '  }',
        '  return pax;',
        '};',
      ].join('\n')
    );

    output = '';
    const originalWrite3 = process.stdout.write.bind(process.stdout);
    (process.stdout.write as any) = (chunk: any) => {
      output += String(chunk);
      return originalWrite3(chunk);
    };

    try {
      await committer.execute('TEST-003', tmpDir, ticketContext);
    } finally {
      (process.stdout.write as any) = originalWrite3;
    }

    let committedFiles3: string;
    try {
      committedFiles3 = execSync('git show --name-only --format="" HEAD', {
        cwd: tmpDir,
        encoding: 'utf-8',
      }).trim();
    } catch {
      committedFiles3 = '';
    }

    const leakedConfig = wfConfigFiles.find(f => committedFiles3.includes(f));
    if (leakedConfig) {
      fail(`wf config file leaked into commit: ${leakedConfig}`, committedFiles3);
    } else {
      pass('wf.config.* files were NOT committed');
    }

    if (committedFiles3.includes('passenger.service.ts')) {
      pass('Source file passenger.service.ts WAS committed alongside wf config files');
    } else {
      fail('Source file was not committed — wf.config.* exclusion too broad', committedFiles3);
    }
  } finally {
    await app.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) {
    console.log('✓ All tests passed!');
  }
  console.log('━'.repeat(60));

  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
