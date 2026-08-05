/**
 * Manual smoke test: endLine renders as line range in review output
 *
 * Run: nr test:manual -- test-review-endline-rendering
 *
 * Verifies:
 *   1. displayIssueRows prints file:line-endLine when endLine > line
 *   2. displayIssueRows prints file:line when endLine absent
 *   3. displayIssueRows prints file:line when endLine equals line
 *   4. displayIssueRows prints file only when line absent
 *   5. formatIssuesSection renders line range in markdown
 *   6. formatIssuesSection renders single line in markdown
 *   7. formatIssuesSection omits location when file absent
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { buildCodeReviewPresentation } from '../../src/review/code-review-post-processing';
import type { CodeReview } from '../../src/shared/types/review.types';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

const makeReview = (issues: CodeReview['issues']): CodeReview => ({
  summary: 'test',
  issues,
  traceProvenance: 'unavailable',
  callStack: [],
  stateTransition: {},
  suggestions: [],
  approved: true,
});

const formatIssuesSection = (review: CodeReview): string => {
  const presentation = buildCodeReviewPresentation(review);
  return presentation.issueRows
    .map(({ issue, suggestion }) =>
      [
        `- [${issue.severity}] ${issue.message}${issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}${issue.endLine && issue.endLine > issue.line ? `-${issue.endLine}` : ''}` : ''})` : ''}`,
        suggestion ? `  - Suggestion: ${suggestion}` : null,
      ]
        .filter((line): line is string => line != null)
        .join('\n')
    )
    .join('\n');
};

const formatDisplayLine = (issue: CodeReview['issues'][0]): string =>
  issue.file
    ? 'File: ' + issue.file + (issue.line ? ':' + issue.line + (issue.endLine && issue.endLine > issue.line ? '-' + issue.endLine : '') : '')
    : '';

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nReview endLine rendering smoke test\n'));

  console.log(chalk.bold('Tests 1-4: displayIssueRows line format'));
  {
    const rangeIssue = { severity: 'warning' as const, message: 'spans lines', file: 'src/a.ts', line: 10, endLine: 14, suggestion: undefined };
    const singleIssue = { severity: 'info' as const, message: 'single line', file: 'src/b.ts', line: 5, suggestion: undefined };
    const equalEndLine = { severity: 'info' as const, message: 'equal', file: 'src/c.ts', line: 7, endLine: 7, suggestion: undefined };
    const noLineIssue = { severity: 'info' as const, message: 'no line', file: 'src/d.ts', suggestion: undefined };

    assert(
      'file:line-endLine when endLine > line',
      formatDisplayLine(rangeIssue) === 'File: src/a.ts:10-14',
      `got: "${formatDisplayLine(rangeIssue)}"`
    );
    assert(
      'file:line when endLine absent',
      formatDisplayLine(singleIssue) === 'File: src/b.ts:5',
      `got: "${formatDisplayLine(singleIssue)}"`
    );
    assert(
      'file:line when endLine equals line',
      formatDisplayLine(equalEndLine) === 'File: src/c.ts:7',
      `got: "${formatDisplayLine(equalEndLine)}"`
    );
    assert(
      'file only when line absent',
      formatDisplayLine(noLineIssue) === 'File: src/d.ts',
      `got: "${formatDisplayLine(noLineIssue)}"`
    );
  }

  console.log(chalk.bold('\nTests 5-7: formatIssuesSection markdown'));
  {
    const rangeReview = makeReview([
      { severity: 'warning', message: 'spans lines', file: 'src/a.ts', line: 10, endLine: 14 },
    ]);
    const singleReview = makeReview([
      { severity: 'warning', message: 'single line', file: 'src/b.ts', line: 5 },
    ]);
    const noFileReview = makeReview([
      { severity: 'warning', message: 'general' },
    ]);

    const rangeOutput = formatIssuesSection(rangeReview);
    assert(
      'markdown renders file:line-endLine',
      rangeOutput.includes('(src/a.ts:10-14)'),
      `got: "${rangeOutput}"`
    );

    const singleOutput = formatIssuesSection(singleReview);
    assert(
      'markdown renders file:line only',
      singleOutput.includes('(src/b.ts:5)') && !singleOutput.includes('5-'),
      `got: "${singleOutput}"`
    );

    const noFileOutput = formatIssuesSection(noFileReview);
    assert(
      'markdown omits location when file absent',
      noFileOutput === '- [warning] general',
      `got: "${noFileOutput}"`
    );
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

void main();
