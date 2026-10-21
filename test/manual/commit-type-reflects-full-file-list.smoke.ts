/**
 * Manual smoke test: commit type reflects full file list, not just
 * alphabetically-first files
 *
 * Run: nr test:manual commit-type-reflects-full-file-list.smoke.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { CommitStageService } from '../../src/workflows/stages/commit-stage.service';
import { GitService } from '../../src/integrations/git/git.service';
import { extractConventionalType } from '../../src/common/utils/commit-diff-stat';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createReporter, summarise } from './support/reporter';

const docsOnlyTypes = new Set(['docs', 'style', 'chore']);

const BILLING_V2 = [
  'export const chargeCard = (amount: number) => {',
  '  if (amount <= 0) throw new Error("amount must be positive");',
  '  if (amount > 10_000) throw new Error("amount exceeds per-transaction limit");',
  '  return amount;',
  '};',
].join('\n') + '\n';

const { counts, pass, fail } = createReporter();

function initRepo(tmpDir: string): (cmd: string) => void {
  const git = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  };
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
  fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Initial readme\n');
  fs.writeFileSync(path.join(tmpDir, 'billing.service.ts'), 'export const chargeCard = (amount: number) => amount;\n');
  git('add .');
  git('commit -m init');
  return git;
}

async function runMixedDiff(
  git: (cmd: string) => void,
  tmpDir: string,
  gitService: GitService,
  commitStageService: CommitStageService,
): Promise<string> {
  fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Initial readme\nAdds a billing note.\n');
  fs.writeFileSync(path.join(tmpDir, 'billing.service.ts'), BILLING_V2);
  git('add .');
  const mixedDiff = await gitService.getDiff(true, tmpDir);
  const mixedMessage = await commitStageService.generateCommitMessage({ diff: mixedDiff, ticketKey: 'WBP-7001', conventional: true });
  git('add . && git commit -m "checkpoint"');
  return mixedMessage;
}

function checkMixedCommitType(mixedMessage: string): void {
  const mixedType = extractConventionalType(mixedMessage);
  if (mixedType && !docsOnlyTypes.has(mixedType)) {
    pass(`mixed-file commit type is "${mixedType}", not docs/style/chore: "${mixedMessage}"`);
  } else {
    fail('mixed-file commit type incorrectly resolved to docs/style/chore', mixedMessage);
  }
  const lowerMixed = mixedMessage.toLowerCase();
  const sourceKeywords = ['amount', 'limit', 'positive', 'validat', 'charge', 'billing'];
  if (sourceKeywords.some(k => lowerMixed.includes(k))) {
    pass('mixed-file commit message references the substantive source change, not just the docs tweak');
  } else {
    fail('mixed-file commit message does not reference the source change', mixedMessage);
  }
}

async function runDocsOnlyDiff(
  git: (cmd: string) => void,
  tmpDir: string,
  gitService: GitService,
  commitStageService: CommitStageService,
): Promise<string> {
  fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Initial readme\nAdds a billing note.\nAnother docs-only line.\n');
  git('add .');
  const docsOnlyDiff = await gitService.getDiff(true, tmpDir);
  return commitStageService.generateCommitMessage({ diff: docsOnlyDiff, ticketKey: 'WBP-7002', conventional: true });
}

function checkDocsOnlyCommitType(docsOnlyMessage: string): void {
  const docsOnlyType = extractConventionalType(docsOnlyMessage);
  if (docsOnlyType) {
    pass(`docs-only commit type resolved to "${docsOnlyType}" (guard did not force an unrelated retry)`);
  } else {
    fail('docs-only commit produced no parseable conventional type', docsOnlyMessage);
  }
}

async function runChecks(
  git: (cmd: string) => void,
  tmpDir: string,
  gitService: GitService,
  commitStageService: CommitStageService,
): Promise<void> {
  checkMixedCommitType(await runMixedDiff(git, tmpDir, gitService, commitStageService));
  checkDocsOnlyCommitType(await runDocsOnlyDiff(git, tmpDir, gitService, commitStageService));
}

async function main(): Promise<void> {
  console.log('\nManual smoke test: commit type reflects full file list\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-commit-type-'));
  try {
    const git = initRepo(tmpDir);
    const gitService = app.get(GitService);
    const commitStageService = app.get(CommitStageService);
    await runChecks(git, tmpDir, gitService, commitStageService);
  } finally {
    await app.close();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
