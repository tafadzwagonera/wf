/**
 * Manual test runner entry point.
 *
 * Usage: nr test:manual -- <test-file-name>
 * Example: nr test:manual -- test-issue-review
 *
 * Resolves the test file from src/test/manual/<name>.ts first, then falls
 * back to test/manual/<name>.ts for legacy manual tests.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

const moduleRequire = createRequire(__filename);

/**
 * Resolve and execute a manual test file after loading wf config.
 *
 * @returns Resolves when the manual test module has been required
 */
export const runManualTest = async (): Promise<void> => {
  const testName = process.argv[2];

  if (!testName) {
    console.error('Usage: nr test:manual -- <test-file-name>');
    console.error('Example: nr test:manual -- test-issue-review');
    process.exit(1);
  }

  const candidatePaths = [
    path.join(__dirname, 'src', 'test', 'manual', `${testName}.ts`),
    path.join(__dirname, 'test', 'manual', `${testName}.ts`),
  ];

  const resolvedTestPath = candidatePaths.find((candidatePath) =>
    fs.existsSync(candidatePath),
  );

  if (!resolvedTestPath) {
    console.error(
      `Manual test "${testName}" not found in src/test/manual or test/manual.`,
    );
    process.exit(1);
  }

  const { resolveConfigCwd } = moduleRequire('./src/bootstrap/resolve-config-cwd');
  const { initializeWfConfig } = moduleRequire('./src/config/wf-config-loader');
  await initializeWfConfig(resolveConfigCwd(process.argv.slice(2)));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(resolvedTestPath);
};

void runManualTest();
