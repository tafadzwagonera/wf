/**
 * Manual smoke test: inquirer prompts must set `prefix: ''`
 *
 * Run: nr test:manual -- test-inquirer-no-trailing-question-mark
 *
 * Verifies:
 *   Inquirer prefixes every prompt with a green `?` by default. This collides
 *   with question-phrased messages, producing a distracting leading `?`.
 *   All inquirer prompt objects in src/ must set `prefix: ''` to suppress it.
 */
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

/**
 * Finds inquirer prompt objects that are missing `prefix: ''`.
 *
 * Scans for `inquirer.prompt(` or `this.inquirer(` call sites, then checks
 * whether each question object in the array contains `prefix:`.
 */
const findMissingPrefix = (file: string, content: string): { line: number; text: string }[] => {
  const lines = content.split('\n');
  const violations: { line: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Detect inquirer prompt call with array argument
    if (
      /inquirer\.prompt\s*[(<]|this\.inquirer\s*\(/.test(lines[i])
      || /inquirer\.prompt\s*[(<]|this\.inquirer\s*\(/.test(lines[i - 1] ?? '')
    ) {
      // Walk forward to find each `type:` property (marks start of a question object)
      for (let j = i; j < Math.min(i + 30, lines.length); j++) {
        if (/^\s*type:\s*['"]/.test(lines[j]) && !hasNearbyPrefix(lines, j)) {
          violations.push({ line: j + 1, text: lines[j].trim() });
        }
        // Stop scanning if we leave the prompt call
        if (/^\s*\]\s*\)/.test(lines[j]) && j > i + 1) break;
      }
    }
  }

  return violations;
};

async function main(): Promise<void> {
  console.log(chalk.bold('\nSmoke test: inquirer prompts suppress default `?` prefix\n'));

  const srcDir = path.resolve(__dirname, '../../src');
  const tsFiles: string[] = [];

  const collectTs = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectTs(full);
      if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        tsFiles.push(full);
      }
    }
  };
  collectTs(srcDir);

  const allViolations: string[] = [];

  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    // Only check files that call inquirer.prompt or this.inquirer
    if (!content.includes('inquirer.prompt') && !content.includes('this.inquirer')) {
      continue;
    }
    const violations = findMissingPrefix(file, content);
    for (const v of violations) {
      const rel = path.relative(path.resolve(__dirname, '../..'), file);
      allViolations.push(`${rel}:${v.line}: ${v.text}`);
    }
  }

  assert('All inquirer prompt objects set prefix to suppress the default `?`', allViolations.length === 0);

  if (allViolations.length > 0) {
    console.log(chalk.yellow('\n  Missing `prefix: \'\'` in:'));
    for (const v of allViolations) {
      console.log(chalk.yellow(`    ${v}`));
    }
  }

  // Summary
  console.log(`\n${chalk.bold('Results:')} ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
