/**
 * Manual smoke test: prebuild clean prevents stale dist artifacts
 *
 * Run: nr test:manual -- test-prebuild-clean-stale-dist
 *
 * Verifies:
 *   1. A sentinel file placed in dist/ is removed by the prebuild step
 *   2. dist/main.js exists after build (build succeeded)
 *   3. dist/config/wf-config-loader.js exists (core module compiled)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  \u2713 ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  const suffix = detail ? `\n    \u2192 ${detail}` : '';
  console.error(chalk.red(`  \u2717 ${message}${suffix}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
    return;
  }
  fail(label, detail);
};

console.log(chalk.bold.cyan('\nPrebuild clean smoke test\n'));

const cwd = process.cwd();
const sentinelPath = path.join(cwd, 'dist', '__stale-artifact.js');

// Ensure dist/ exists before planting sentinel
fs.mkdirSync(path.join(cwd, 'dist'), { recursive: true });
fs.writeFileSync(sentinelPath, '// stale artifact\n');
assert('Sentinel file created in dist/', fs.existsSync(sentinelPath));

// Run build
console.log(chalk.gray('  Running yarn build...'));
try {
  execSync('yarn build', { cwd, encoding: 'utf-8', stdio: 'pipe' });
} catch (error: unknown) {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error
    ? String((error as { stderr: unknown }).stderr)
    : '';
  fail('yarn build succeeded', stderr.slice(0, 300));
  process.exit(1);
}

assert('Sentinel file removed by prebuild', !fs.existsSync(sentinelPath));
assert('dist/main.js exists after build', fs.existsSync(path.join(cwd, 'dist', 'main.js')));
assert('dist/config/wf-config-loader.js exists', fs.existsSync(path.join(cwd, 'dist', 'config', 'wf-config-loader.js')));

console.log(
  chalk.bold(
    `\n${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`
  )
);

if (failed > 0) {
  process.exit(1);
}
