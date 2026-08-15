/**
 * Manual smoke test: empty repoFiles warning and ⚠ icon standardization
 *
 * Run: nr test:manual -- test-empty-repofiles-warning
 *
 * Verifies:
 *   1. buildPlanContext renders "(none listed)" for empty repoFiles.
 *   2. buildPlanContext renders "(none listed)" for empty trackedFilePaths.
 *   3. ⚠ icon (U+26A0) is used consistently — no ⚠️ (U+26A0 U+FE0F) remains.
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { buildPlanContext } from '../../src/integrations/ai/adapters/shared-routing';
import type { VerificationScript } from '../../src/agents/interfaces';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  \u2713 ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  \u2717 ${label}`));
    failed++;
  }
};

const run = async (): Promise<void> => {
  console.log(chalk.bold('\nSmoke test: empty repoFiles warning\n'));

  // 1. buildPlanContext with empty repoFiles
  const ctx = buildPlanContext({
    ticketKey: 'TEST-1',
    repoDir: '/tmp/repo',
    repoName: 'repo',
    repoFiles: [],
    trackedFilePaths: [],
    verificationScripts: [{ id: 'build', command: 'yarn build', policy: 'enforced' }] as VerificationScript[],
    planSteps: ['Step 1'],
    planSummary: 'Summary',
    planAction: 'fix' as const,
  });

  assert(
    'buildPlanContext shows "(none listed)" for empty repoFiles',
    ctx.includes('Files to implement:\n  (none listed)')
  );

  assert(
    'buildPlanContext shows "(same as files to implement)" for empty trackedFilePaths',
    ctx.includes('Tracked files:\n  (same as files to implement)')
  );

  // 2. Icon standardization: scan source files for emoji ⚠️ (U+26A0 U+FE0F)
  const srcDir = path.resolve(__dirname, '../../src');
  const tsFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) tsFiles.push(full);
    }
  };
  walk(srcDir);

  const emojiWarnings: string[] = [];
  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match ⚠️ (U+26A0 immediately followed by U+FE0F)
      for (let j = 0; j < line.length; j++) {
        if (line.charCodeAt(j) === 0x26a0 && j + 1 < line.length && line.charCodeAt(j + 1) === 0xfe0f) {
          emojiWarnings.push(`${path.relative(srcDir, file)}:${i + 1}`);
        }
      }
    }
  }

  assert('No ⚠️ (U+26A0 U+FE0F) in src/', emojiWarnings.length === 0);
  if (emojiWarnings.length > 0) {
    for (const loc of emojiWarnings) {
      console.log(chalk.red(`    ⚠️ at ${loc}`));
    }
  }

  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));

  if (failed > 0) {
    process.exit(1);
  }
};

run();
