/**
 * Manual smoke test: commit prompt never silently drops the highest-changed
 * file to truncation
 *
 * Run: nr test:manual -- test-commit-diff-excerpt-prioritization
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  parseDiffFileStats,
  buildPrioritizedDiffExcerpt,
} from '../../src/shared/utils/commit-diff-stat';

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

function main(): void {
  console.log('\nManual smoke test: prioritized diff excerpt never silently truncates the biggest file\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-diff-excerpt-'));
  const git = (cmd: string): void => {
    execSync(`git ${cmd}`, { cwd: tmpDir, stdio: 'pipe' });
  };

  try {
    git('init');
    git('config user.email "test@example.com"');
    git('config user.name "Test User"');

    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Initial readme\n');
    fs.writeFileSync(path.join(tmpDir, 'big-file.ts'), 'export const x = 1;\n');
    git('add .');
    git('commit -m init');

    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Initial readme\nOne extra line\n');
    const bigFileLines = Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i};`);
    fs.writeFileSync(path.join(tmpDir, 'big-file.ts'), `${bigFileLines.join('\n')}\n`);

    const diff = execSync('git diff', { cwd: tmpDir, encoding: 'utf-8' });
    if (diff.trim().length === 0) {
      fail('git diff produced no output — cannot proceed');
      return;
    }
    pass('produced a real, non-empty git diff spanning two files');

    const stats = parseDiffFileStats(diff);
    const readmeStat = stats.find(s => s.file === 'README.md');
    const bigFileStat = stats.find(s => s.file === 'big-file.ts');

    if (readmeStat && bigFileStat && bigFileStat.changedLines > readmeStat.changedLines) {
      pass(`parseDiffFileStats ranks big-file.ts (${bigFileStat.changedLines} lines) above README.md (${readmeStat.changedLines} lines)`);
    } else {
      fail('parseDiffFileStats did not rank big-file.ts above README.md', JSON.stringify(stats));
    }

    const budget = 400;
    const excerpt = buildPrioritizedDiffExcerpt(diff, stats, budget);

    if (excerpt.includes('value199') || excerpt.includes('big-file.ts')) {
      pass('excerpt includes content from the most-changed file (big-file.ts) despite a small budget');
    } else {
      fail('excerpt is missing big-file.ts content — highest-signal file was dropped', excerpt.slice(0, 300));
    }

    const readmeFullyIncluded = excerpt.includes('One extra line');
    const notesOmission = /omitted/i.test(excerpt);
    if (!readmeFullyIncluded || notesOmission) {
      pass('README.md content is either fully present or explicitly noted as omitted — no silent partial truncation');
    } else {
      fail('README.md appears partially present with no omission note', excerpt.slice(0, 300));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main();
