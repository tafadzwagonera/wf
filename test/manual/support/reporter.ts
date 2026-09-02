import chalk from 'chalk';

export interface TestCounts {
  passed: number;
  failed: number;
}

/**
 * Create pass/fail reporters that share one mutable counts object.
 *
 * @returns The shared counts object plus `pass`/`fail` reporter functions
 */
export function createReporter(): {
  counts: TestCounts;
  pass: (msg: string) => void;
  fail: (msg: string, detail?: string) => void;
} {
  const counts: TestCounts = { passed: 0, failed: 0 };

  const pass = (msg: string): void => {
    console.log(chalk.green(`  PASS  ${msg}`));
    counts.passed++;
  };

  const fail = (msg: string, detail?: string): void => {
    const suffix = detail ? '\n    → ' + detail : '';
    console.error(chalk.red('  FAIL  ' + msg + suffix));
    counts.failed++;
  };

  return { counts, pass, fail };
}
