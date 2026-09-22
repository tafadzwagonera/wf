/**
 * Manual smoke test: empty repoFiles warning and ⚠ icon standardization
 *
 * Run: nr test:manual empty-repofiles-warning.smoke.ts
 *
 * Verifies:
 *   1. buildPlanContext renders "(none listed)" for empty repoFiles.
 *   2. buildPlanContext renders "(none listed)" for empty trackedFilePaths.
 *   3. ⚠ icon (U+26A0) is used consistently — no ⚠️ (U+26A0 U+FE0F) remains.
 */
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildPlanContext } from '../../src/integrations/ai/adapters/shared-routing';
import type { VerificationScript } from '../../src/agents/interfaces';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean): void => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}`));
    failed++;
  }
};

function buildTestContext(): string {
  return buildPlanContext({
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
}

function checkContextShowsNoneListed(ctx: string): void {
  assert('buildPlanContext shows "(none listed)" for empty repoFiles', ctx.includes('Files to implement:\n  (none listed)'));
  assert('buildPlanContext shows "(same as files to implement)" for empty trackedFilePaths', ctx.includes('Tracked files:\n  (same as files to implement)'));
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function scanFileForEmojiWarnings(file: string, srcDir: string): string[] {
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      if (line.charCodeAt(j) === 0x26a0 && j + 1 < line.length && line.charCodeAt(j + 1) === 0xfe0f) {
        found.push(`${path.relative(srcDir, file)}:${i + 1}`);
      }
    }
  }
  return found;
}

function findEmojiWarnings(srcDir: string): string[] {
  return collectTsFiles(srcDir).flatMap(file => scanFileForEmojiWarnings(file, srcDir));
}

function checkNoEmojiWarnings(warnings: string[]): void {
  assert('No ⚠️ (U+26A0 U+FE0F) in src/', warnings.length === 0);
  for (const loc of warnings) {
    console.log(chalk.red(`    ⚠️ at ${loc}`));
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: empty repoFiles warning\n'));
  const ctx = buildTestContext();
  checkContextShowsNoneListed(ctx);
  const srcDir = path.resolve(__dirname, '../../src');
  checkNoEmojiWarnings(findEmojiWarnings(srcDir));
  console.log(chalk.bold(`\n  ${passed} passed, ${failed} failed\n`));
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
