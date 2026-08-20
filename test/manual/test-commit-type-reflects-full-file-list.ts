/**
 * Manual smoke test: commit type reflects full file list, not just
 * alphabetically-first files
 *
 * Run: nr test:manual -- test-commit-type-reflects-full-file-list
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { CommitStageService } from '../../src/workflows/stages/commit-stage.service';
import { GitService } from '../../src/integrations/git/git.service';
import { extractConventionalType } from '../../src/shared/utils/commit-diff-stat';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const DOCS_ONLY_TYPES = new Set(['docs', 'style', 'chore']);

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
  console.log('\nManual smoke test: commit type reflects full file list\n');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  let tmpDir: string | undefined;

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-commit-type-'));
    const git = (cmd: string): void => {
      execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
    };

    git('init');
    git('config user.email "test@example.com"');
    git('config user.name "Test User"');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Initial readme\n');
    fs.writeFileSync(
      path.join(tmpDir, 'billing.service.ts'),
      'export const chargeCard = (amount: number) => amount;\n'
    );
    git('add .');
    git('commit -m init');

    const gitService = app.get(GitService);
    const commitStageService = app.get(CommitStageService);

    // Case A: mixed diff — a docs tweak (sorts first alphabetically) plus a
    // substantive source-logic change (sorts after). Type must not be docs/style/chore.
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Initial readme\nAdds a billing note.\n');
    fs.writeFileSync(
      path.join(tmpDir, 'billing.service.ts'),
      'export const chargeCard = (amount: number) => {\n'
      + '  if (amount <= 0) throw new Error("amount must be positive");\n'
      + '  if (amount > 10_000) throw new Error("amount exceeds per-transaction limit");\n'
      + '  return amount;\n};\n'
    );
    git('add .');
    const mixedDiff = await gitService.getDiff(true, tmpDir);

    const mixedMessage = await commitStageService.generateCommitMessage({
      diff: mixedDiff, ticketKey: 'WBP-7001', conventional: true,
    });
    const mixedType = extractConventionalType(mixedMessage);

    if (mixedType && !DOCS_ONLY_TYPES.has(mixedType)) {
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

    git('add . && git commit -m "checkpoint"');

    // Case B: a genuinely docs-only diff — type IS allowed to be docs.
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Initial readme\nAdds a billing note.\nAnother docs-only line.\n');
    git('add .');
    const docsOnlyDiff = await gitService.getDiff(true, tmpDir);

    const docsOnlyMessage = await commitStageService.generateCommitMessage({
      diff: docsOnlyDiff, ticketKey: 'WBP-7002', conventional: true,
    });
    const docsOnlyType = extractConventionalType(docsOnlyMessage);

    if (docsOnlyType) {
      pass(`docs-only commit type resolved to "${docsOnlyType}" (guard did not force an unrelated retry)`);
    } else {
      fail('docs-only commit produced no parseable conventional type', docsOnlyMessage);
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
