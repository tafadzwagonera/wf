/**
 * Manual test runner entry point.
 *
 * Usage: nr test:manual {testFileNameWithoutTsExtension}
 * Example: nr test:manual bar.smoke
 *
 * Resolves the test file from test/manual/{testFileNameWithoutTsExtension}.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const moduleRequire = createRequire(__filename);
const { ExecutionError } = moduleRequire('./src/shared/errors/app.error');

/**
 * Verify that the runner is executing from the wf project root.
 *
 * @throws ExecutionError if not in the wf project root
 */
function assertWfProjectRoot(): void {
  const packageJsonPath = path.join(__dirname, 'package.json');
  const isWfProject
    = fs.existsSync(packageJsonPath)
      && JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).name === 'wf';

  if (!isWfProject) {
    throw new ExecutionError(
      `Manual tests must be run from the wf project root. Current directory: ${__dirname}`,
    );
  }
}

/**
 * Resolve and execute a manual test file after loading wf config.
 *
 * @returns Resolves when the manual test module has been required
 * @throws ExecutionError when not executed from the wf project root
 */
// eslint-disable-next-line max-lines-per-function
export const runManualTest = async (): Promise<void> => {
  assertWfProjectRoot();

  const testName = process.argv[2];

  if (!testName) {
    console.error('Usage: nr test:manual {testFileNameWithoutTsExtension}');
    console.error('Example: nr test:manual bar.smoke');
    process.exit(1);
  }

  const resolvedTestPath = path.join(__dirname, 'test', 'manual', `${testName}.ts`);

  if (!fs.existsSync(resolvedTestPath)) {
    console.error(`Manual test "${testName}" not found in test/manual.`);
    process.exit(1);
  }

  const { resolveConfigCwd } = moduleRequire('./src/bootstrap/resolve-config-cwd');
  const { initializeWfConfig } = moduleRequire('./src/config/wf-config-loader');
  await initializeWfConfig(resolveConfigCwd(process.argv.slice(2)));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(resolvedTestPath);
};

runManualTest().catch(error => {
  console.error(error.message ?? error);
  process.exit(1);
});
