/**
 * Manual smoke test: wf issue:commit without --conventional produces an
 * unscoped, type-free description
 *
 * Run: nr test:manual -- test-issue-commit-freeform-vs-conventional
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { CommitStageService } from '../../src/workflows/stages/commit-stage.service';
import { GitService } from '../../src/integrations/git/git.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const CONVENTIONAL_TYPE_PATTERN = /^(?:[A-Z][A-Z0-9]*-\d+:\s*)?[a-z]+(?:\([^)]+\))?:/;

let passed = 0;
let failed = 0;

const pass = (msg: string): void => {
  console.log(`  ✓ ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string): void => {
  console.error(`  ✗ ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

async function main(): Promise<void> {
  console.log('\nManual smoke test: issue:commit freeform vs conventional message format\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  let tmpDir: string | undefined;

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-freeform-commit-'));
    const git = (cmd: string): void => {
      execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
    };

    git('init');
    git('config user.email "test@example.com"');
    git('config user.name "Test User"');
    fs.writeFileSync(path.join(tmpDir, 'auth.ts'), 'export const login = () => true;\n');
    git('add .');
    git('commit -m init');

    const gitService = app.get(GitService);
    const commitStageService = app.get(CommitStageService);

    // Case A: no conventional flag — expect an unscoped, type-free description
    fs.writeFileSync(
      path.join(tmpDir, 'auth.ts'),
      'export const login = (token: string) => {\n  if (!token) throw new Error("missing token");\n  return true;\n};\n'
    );
    git('add .');
    const diffA = await gitService.getDiff(true, tmpDir);

    const freeformMessage = await commitStageService.generateCommitMessage({
      diff: diffA, ticketKey: 'WBP-9999', conventional: false,
    });

    const withoutTicketA = freeformMessage.replace(/^WBP-9999:\s*/, '');
    if (!CONVENTIONAL_TYPE_PATTERN.test(withoutTicketA)) {
      pass(`freeform message has no conventional type prefix: "${freeformMessage}"`);
    } else {
      fail('freeform message unexpectedly contains a conventional type prefix', freeformMessage);
    }

    if (freeformMessage.startsWith('WBP-9999:')) {
      pass('freeform message is prefixed with the ticket key exactly once');
    } else {
      fail('freeform message missing ticket key prefix', freeformMessage);
    }

    // Case B: same shape of change, now with conventional: true — expect a type(scope): prefix
    fs.writeFileSync(
      path.join(tmpDir, 'auth.ts'),
      'export const login = (token: string) => {\n  if (!token) throw new Error("missing token");\n'
      + '  if (token.length < 8) throw new Error("token too short");\n  return true;\n};\n'
    );
    git('add .');
    const diffB = await gitService.getDiff(true, tmpDir);

    const conventionalMessage = await commitStageService.generateCommitMessage({
      diff: diffB, ticketKey: 'WBP-9998', conventional: true,
    });

    const withoutTicketB = conventionalMessage.replace(/^WBP-9998:\s*/, '');
    if (CONVENTIONAL_TYPE_PATTERN.test(withoutTicketB)) {
      pass(`conventional=true message has a type prefix: "${conventionalMessage}"`);
    } else {
      fail('conventional=true message is missing a conventional type prefix', conventionalMessage);
    }
  } finally {
    await app.close();
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
