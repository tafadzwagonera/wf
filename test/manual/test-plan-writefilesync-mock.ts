/**
 * Manual Test: issue-plan spec mocks writePlanArtifactManifest
 *
 * Run: nr test:manual -- test-plan-writefilesync-mock
 *
 * Verifies:
 *   1. The spec mocks `writePlanArtifactManifest` at the module level so the
 *      synchronous `fs.writeFileSync` inside it never hits the filesystem on CI
 *      where `.wf/` dirs are absent.
 *   2. `npx jest issue-plan.command.spec.ts` exits cleanly.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

const repoRoot = path.join(__dirname, '..', '..');
const specPath = path.join(repoRoot, 'src', 'commands', 'issue-plan.command.spec.ts');

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
};

const fail = (message: string): void => {
  console.error(chalk.red(`  \u2717 ${message}`));
};

async function main() {
  console.log(chalk.bold.cyan('\n\uD83E\uDDEA issue-plan writePlanArtifactManifest mock coverage\n'));

  let passed = 0;
  let failed = 0;

  // Test 1: Verify spec file mocks writePlanArtifactManifest at module level
  console.log(chalk.bold('Test 1: Spec mocks writePlanArtifactManifest at the module level'));
  try {
    const content = fs.readFileSync(specPath, 'utf8');
    const hasModuleMock =
      content.includes("jest.mock('../shared/utils/plan-artifact'") &&
      content.includes('writePlanArtifactManifest: jest.fn()');

    if (hasModuleMock) {
      pass('Module-level mock for writePlanArtifactManifest found');
      passed += 1;
    } else {
      fail('Missing module-level mock for writePlanArtifactManifest');
      failed += 1;
    }
  } catch (error: any) {
    fail(`Spec file read failed: ${error.message}`);
    failed += 1;
  }

  // Test 2: Run the Jest spec and verify it passes
  console.log(chalk.bold('Test 2: npx jest issue-plan.command.spec.ts passes'));
  try {
    const output = execSync('npx jest src/commands/issue-plan.command.spec.ts --no-coverage 2>&1', {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });

    if (output.includes('Tests:') && !output.includes('failed')) {
      pass('All issue-plan spec tests pass');
      passed += 1;
    } else {
      fail('Some issue-plan spec tests failed');
      failed += 1;
    }
  } catch (error: any) {
    fail(`Jest run failed: ${error.stdout || error.message}`);
    failed += 1;
  }

  // Summary
  console.log(chalk.bold(`\nResults: ${passed} passed, ${failed} failed\n`));
  process.exit(failed > 0 ? 1 : 0);
}

main();
