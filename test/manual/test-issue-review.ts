/**
 * Manual Test Script for issue:review command
 *
 * Run: nr test:manual -- test-issue-review
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY — required only for Test 11 (live AI call).
 *   All other tests use --dry-run or trigger throw paths; no external APIs called.
 *
 * Test 11 reviews a real non-git temp directory created inline by this script.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';

async function testIssueReview() {
  console.log('🧪 Testing issue:review command\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const command = app.get(IssueReviewCommand);

  // ── Helpers ─────────────────────────────────────────────────────────────

  let _criteriaSeq = 0;
  /** Write a temporary criteria markdown file and return its absolute path. */
  const writeTempCriteria = (lines: string[]): string => {
    const filePath = path.join(
      os.tmpdir(),
      `criteria-${Date.now()}-${++_criteriaSeq}.md`,
    );
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  };

  /** Create a non-git temp directory with two sample source files. */
  const makeNonGitDir = (): string => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
    fs.writeFileSync(
      path.join(dirPath, 'index.ts'),
      'export const greet = (name: string) => `Hello, ${name}!`;\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(dirPath, 'package.json'),
      JSON.stringify({ name: 'sample', version: '0.0.1' }, null, 2) + '\n',
      'utf-8',
    );
    return dirPath;
  };

  /**
   * Run a test case that is expected to trigger ErrorHandler → process.exit(1).
   * Temporarily overrides process.exit so the test suite can continue running.
   * @returns true if process.exit was called (expected), false otherwise
   */
  const expectProcessExit = async (
    label: string,
    fn: () => Promise<void>,
  ): Promise<boolean> => {
    const originalExit = process.exit.bind(process);
    let exited = false;
    process.exit = (code?: number | string) => {
      exited = true;
      throw new Error(`process.exit(${code ?? ''})`);
    };
    try {
      await fn();
      console.error(`❌ ${label}: expected process.exit but none occurred\n`);
      return false;
    } catch (err: any) {
      if (exited) {
        console.log(`✓ ${label}\n`);
        return true;
      }
      console.error(`❌ ${label}: unexpected error: ${err.message}\n`);
      return false;
    } finally {
      process.exit = originalExit;
    }
  };

  // ── Shared state ─────────────────────────────────────────────────────────

  const nonGitDir = makeNonGitDir();
  const gitDir = fs.existsSync(path.join(process.cwd(), '.git'))
    ? process.cwd()
    : null;

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`✓ ${msg}\n`);
    passed++;
  };
  const fail = (msg: string) => {
    console.error(`❌ ${msg}\n`);
    failed++;
  };

  try {
    // Test 1: --dry-run with no source (current repo)
    console.log('Test 1: --dry-run with no source');
    try {
      await command.run([], { dryRun: true });
      pass('Dry-run with no source completed without error');
    } catch (err: any) {
      fail(`Test 1: ${err.message}`);
    }

    // Test 2: --dry-run with a ticket key argument
    console.log('Test 2: --dry-run with ticket key (ABC-123)');
    try {
      await command.run(['ABC-123'], { dryRun: true });
      pass('Dry-run with ticket key completed without error');
    } catch (err: any) {
      fail(`Test 2: ${err.message}`);
    }

    // Test 3: --dry-run with a PR URL argument
    console.log('Test 3: --dry-run with PR URL');
    try {
      await command.run(
        ['https://bitbucket.org/workspace/repo/pull-requests/1'],
        { dryRun: true },
      );
      pass('Dry-run with PR URL completed without error');
    } catch (err: any) {
      fail(`Test 3: ${err.message}`);
    }

    // Test 4: --dry-run with a valid non-git directory path
    console.log('Test 4: --dry-run with non-git directory path');
    try {
      await command.run([nonGitDir], { dryRun: true });
      pass('Dry-run with non-git directory completed without error');
    } catch (err: any) {
      fail(`Test 4: ${err.message}`);
    }

    // Test 5: --dry-run with a valid git directory path (skipped if cwd has no .git)
    console.log('Test 5: --dry-run with git directory path');
    if (gitDir) {
      try {
        await command.run([gitDir], { dryRun: true });
        pass('Dry-run with git directory completed without error');
      } catch (err: any) {
        fail(`Test 5: ${err.message}`);
      }
    } else {
      console.log('  ↷ Skipped — cwd is not a git repo\n');
    }

    // Test 6: --criteria with a valid temp file (append mode)
    console.log('Test 6: --criteria with valid temp file (append)');
    const appendCriteriaPath = writeTempCriteria([
      '- Performance: Are there obvious bottlenecks?',
      '- Accessibility: Does the UI meet WCAG AA?',
    ]);
    try {
      await command.run([], { dryRun: true, criteria: appendCriteriaPath });
      pass('--criteria append mode accepted without error');
    } catch (err: any) {
      fail(`Test 6: ${err.message}`);
    } finally {
      fs.unlinkSync(appendCriteriaPath);
    }

    // Test 7: --replace-criteria with a valid temp file (replace mode)
    console.log('Test 7: --replace-criteria with valid temp file (replace)');
    const replaceCriteriaPath = writeTempCriteria([
      '- Correctness: Does it do what the ticket says?',
    ]);
    try {
      await command.run([], {
        dryRun: true,
        replaceCriteria: replaceCriteriaPath,
      });
      pass('--replace-criteria mode accepted without error');
    } catch (err: any) {
      fail(`Test 7: ${err.message}`);
    } finally {
      fs.unlinkSync(replaceCriteriaPath);
    }

    // Test 8: --criteria and --replace-criteria together (expect immediate throw)
    // After the Step 1 fix, this throws before the try-catch in run(), so it
    // propagates naturally without going through ErrorHandler.handle().
    console.log(
      'Test 8: --criteria and --replace-criteria together (expect error)',
    );
    const criteriaA = writeTempCriteria(['- A: criterion A']);
    const criteriaB = writeTempCriteria(['- B: criterion B']);
    try {
      await command.run([], {
        criteria: criteriaA,
        replaceCriteria: criteriaB,
      });
      fail('Test 8: expected mutual-exclusion error but none was thrown');
    } catch (err: any) {
      if (
        err.message.includes('Cannot use --criteria and --replace-criteria')
      ) {
        pass('Correctly threw mutual-exclusion error');
      } else {
        fail(`Test 8: unexpected error: ${err.message}`);
      }
    } finally {
      fs.unlinkSync(criteriaA);
      fs.unlinkSync(criteriaB);
    }

    // Test 9: --criteria with a non-existent file (expect immediate throw)
    // After the Step 1 fix, loadCriteriaFromFile runs before the try-catch.
    console.log('Test 9: --criteria with non-existent file (expect error)');
    try {
      await command.run([], {
        criteria: '/tmp/does-not-exist-criteria-xyzzy.md',
      });
      fail('Test 9: expected file-not-found error but none was thrown');
    } catch (err: any) {
      if (err.message.includes('Criteria file not found')) {
        pass('Correctly threw file-not-found error');
      } else {
        fail(`Test 9: unexpected error: ${err.message}`);
      }
    }

    // Test 10: Invalid source string (expect ErrorHandler → process.exit(1))
    // The "Invalid source" error is thrown inside run()'s try-catch and handled
    // by ErrorHandler.handle(), which calls process.exit(1).
    console.log(
      'Test 10: Invalid source string (expect process.exit via ErrorHandler)',
    );
    const t10Passed = await expectProcessExit(
      'Correctly exited on invalid source string',
      () => command.run(['not-a-ticket-not-a-url-not-a-path'], {}),
    );
    if (t10Passed) passed++;
    else failed++;

    // Test 11: Live AI review of a non-git directory — tests the git-waiver fix.
    // Requires ANTHROPIC_API_KEY. Expects the yellow warning + successful review.
    console.log(
      'Test 11: Live AI review of non-git directory (tests git-waiver fix)',
    );
    console.log(`  Directory: ${nonGitDir}`);
    try {
      await command.run([nonGitDir], {});
      pass('Live review of non-git directory completed successfully');
    } catch (err: any) {
      if (err.message.includes('Not a git repository')) {
        fail(
          `Test 11 REGRESSION: fix not applied — still throwing: ${err.message}`,
        );
      } else {
        fail(`Test 11: ${err.message}`);
      }
    }

    // Test 13: invalid --repos path emits a warning and falls back to cwd
    // Verifies that resolveRepoBasePath is called and its warning surfaces.
    console.log(
      'Test 13: --dry-run with invalid --repos path (expect warning, no crash)',
    );
    {
      const warnMessages: string[] = [];
      const origWarn = console.log.bind(console);
      console.log = (...args: any[]) => {
        const text = args.join(' ');
        if (text.includes('not found as a path')) warnMessages.push(text);
        origWarn(...args);
      };
      try {
        await command.run(['ABC-123'], {
          dryRun: true,
          repos: ['/nonexistent/repo/path-xyzzy'],
        });
        if (warnMessages.length > 0) {
          pass('Invalid --repos path emitted a warning before dry-run preview');
        } else {
          fail('Test 13: no warning emitted for invalid --repos path');
        }
      } catch (err: any) {
        fail(`Test 13: unexpected error: ${err.message}`);
      } finally {
        console.log = origWarn;
      }
    }

    // Test 12: --repos is optional — dry-run with ticket key, no repos provided
    // Verifies: (a) TypeScript no longer requires repos in IssueReviewOptions,
    //           (b) runtime path reaches the dry-run preview without error.
    console.log('Test 12: --dry-run with ticket key, no --repos (repos optional)');
    try {
      await command.run(['ABC-123'], { dryRun: true });
      pass('Dry-run with ticket key and no repos completed without error');
    } catch (err: any) {
      fail(`Test 12: ${err.message}`);
    }

    // ── Summary ───────────────────────────────────────────────────────────
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
    if (failed === 0) {
      console.log('✅ All tests passed!');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (err: any) {
    console.error('❌ Unexpected top-level error:', err.message);
    if (err.stack) console.error(err.stack);
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
    await app.close();
  }
}

testIssueReview();
