/**
 * Manual smoke test: inquirer prompts must set `prefix: ''`
 *
 * Run: nr test:manual inquirer-no-trailing-question-mark.smoke.ts
 *
 * Verifies:
 *   Inquirer prefixes every prompt with a green `?` by default. This collides
 *   with question-phrased messages, producing a distracting leading `?`.
 *   All inquirer prompt objects in src/ must set `prefix: ''` to suppress it.
 */
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createReporter, summarise } from './support/reporter';

type Violation = { line: number; text: string };
const { counts, pass, fail } = createReporter();

/**
 * Check whether a question object contains a `prefix:` property within ~10 lines.
 *
 * @param lines - All source lines of the file
 * @param startIndex - Index of the `type:` line that opens the question object
 * @returns True when `prefix:` appears before the closing brace
 */
const hasNearbyPrefix = (lines: string[], startIndex: number): boolean => {
  for (let k = startIndex; k < Math.min(startIndex + 10, lines.length); k++) {
    if (/prefix:/.test(lines[k])) return true;
    if (/^\s*\}/.test(lines[k]) && k > startIndex) return false;
  }
  return false;
};

function isPromptCallLine(lines: string[], i: number): boolean {
  return /inquirer\.prompt\s*[(<]|this\.inquirer\s*\(/.test(lines[i])
    || /inquirer\.prompt\s*[(<]|this\.inquirer\s*\(/.test(lines[i - 1] ?? '');
}

function recordViolation(violations: Violation[], j: number, lines: string[]): void {
  violations.push({ line: j + 1, text: lines[j].trim() });
}

function findMissingPrefixInCall(lines: string[], startIdx: number, violations: Violation[]): void {
  for (let j = startIdx; j < Math.min(startIdx + 30, lines.length); j++) {
    if (/^\s*type:\s*['"]/.test(lines[j]) && !hasNearbyPrefix(lines, j)) {
      recordViolation(violations, j, lines);
    }
    if (/^\s*\]\s*\)/.test(lines[j]) && j > startIdx + 1) break;
  }
}

const findMissingPrefix = (file: string, content: string): Violation[] => {
  const lines = content.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (isPromptCallLine(lines, i)) {
      findMissingPrefixInCall(lines, i, violations);
    }
  }

  return violations;
};

function walkTsFiles(dir: string, result: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, result);
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      result.push(full);
    }
  }
}

function collectTsFiles(dir: string): string[] {
  const result: string[] = [];
  walkTsFiles(dir, result);
  return result;
}

function collectViolations(tsFiles: string[]): string[] {
  const allViolations: string[] = [];
  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    if (!content.includes('inquirer.prompt') && !content.includes('this.inquirer')) continue;
    const violations = findMissingPrefix(file, content);
    for (const v of violations) {
      const rel = path.relative(path.resolve(__dirname, '../..'), file);
      allViolations.push(`${rel}:${v.line}: ${v.text}`);
    }
  }
  return allViolations;
}

function checkAllPromptsHavePrefix(allViolations: string[]): void {
  if (allViolations.length === 0) {
    pass('All inquirer prompt objects set prefix to suppress the default `?`');
    return;
  }
  fail('All inquirer prompt objects set prefix to suppress the default `?`');
  console.log(chalk.yellow('\n  Missing `prefix: \'\'` in:'));
  for (const v of allViolations) {
    console.log(chalk.yellow(`    ${v}`));
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: inquirer prompts suppress default `?` prefix\n'));
  const srcDir = path.resolve(__dirname, '../../src');
  const tsFiles = collectTsFiles(srcDir);
  const allViolations = collectViolations(tsFiles);
  checkAllPromptsHavePrefix(allViolations);
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
