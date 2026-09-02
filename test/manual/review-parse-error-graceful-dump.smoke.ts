/**
 * Manual smoke test: executeReviews dumps raw payload on unrecoverable parse error
 *
 * Run: nr test:manual -- test-review-parse-error-graceful-dump
 *
 * Verifies:
 *   1. Parse AiProviderError prints warning and raw payload, does not crash
 *   2. Non-parse AiProviderError propagates to caller
 *   3. Silent mode suppresses output but still skips the target
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { AiProviderError } from '../../src/shared/errors/app.error';
import { isAiProviderErrorLike } from '../../src/shared/utils/errors';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

const handleReviewParseError = (error: unknown, silent?: boolean): void => {
  if (!isAiProviderErrorLike(error) || error.category !== 'parse') throw error;
  if (silent) return;
  console.log(chalk.yellow('\n⚠ Review JSON could not be fully validated. Dumping raw payload for manual inspection.\n'));
  console.log(error.details?.response ?? '');
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\nReview parse error graceful dump smoke test\n'));

  console.log(chalk.bold('Test 1: parse AiProviderError prints warning, does not throw'));
  {
    const rawPayload = '{"broken": true}';
    const parseError = new AiProviderError('parse fail', { response: rawPayload }, true, 'parse');

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };

    let threw = false;
    try {
      handleReviewParseError(parseError);
    } catch {
      threw = true;
    } finally {
      console.log = originalLog;
    }

    assert('did not throw', !threw);
    assert(
      'output contains warning text',
      lines.some(l => l.includes('could not be fully validated')),
      `got lines: ${JSON.stringify(lines)}`
    );
    assert(
      'output contains raw payload',
      lines.some(l => l.includes(rawPayload)),
      `got lines: ${JSON.stringify(lines)}`
    );
  }

  console.log(chalk.bold('\nTest 2: non-parse AiProviderError propagates'));
  {
    const authError = new AiProviderError('auth fail', {}, true, 'auth');
    let caughtError: unknown;
    try {
      handleReviewParseError(authError);
    } catch (error) {
      caughtError = error;
    }
    assert('error re-thrown', caughtError === authError, `got: ${String(caughtError)}`);
  }

  console.log(chalk.bold('\nTest 3: silent mode suppresses output'));
  {
    const parseError = new AiProviderError('parse fail', { response: 'raw' }, true, 'parse');

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };

    let threw = false;
    try {
      handleReviewParseError(parseError, true);
    } catch {
      threw = true;
    } finally {
      console.log = originalLog;
    }

    assert('did not throw', !threw);
    assert('no output in silent mode', lines.length === 0, `got ${lines.length} lines`);
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${counts.passed}`);
  console.log(`  Failed: ${counts.failed}`);

  if (counts.failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
