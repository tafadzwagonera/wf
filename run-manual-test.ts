/**
 * Manual test runner entry point.
 *
 * Usage: nr test:manual -- <test-file-name>
 * Example: nr test:manual -- test-issue-review
 *
 * Resolves the test file from test/manual/<name>.ts and requires it.
 */

const testName = process.argv[2];

if (!testName) {
  console.error('Usage: nr test:manual -- <test-file-name>');
  console.error('Example: nr test:manual -- test-issue-review');
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(`./test/manual/${testName}`);
