import chalk from 'chalk';

export interface TestCounts {
  passed: number;
  failed: number;
}

export interface Reporter {
  counts: TestCounts;
  pass: (msg: string) => void;
  fail: (msg: string, detail?: string) => void;
}

export function createReporter(): Reporter {
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

export function summarise(counts: TestCounts): void {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Results: ✓ ${counts.passed} passed   ✗ ${counts.failed} failed`);
  if (counts.failed === 0) console.log('✓ All tests passed!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (counts.failed > 0) process.exit(1);
}
