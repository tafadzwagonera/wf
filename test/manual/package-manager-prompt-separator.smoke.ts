/**
 * Manual smoke test: formatTestInfraPromptSection applies the detected package manager
 * and its conditional " -- " separator throughout the rendered prompt section.
 *
 * Run: nr test:manual package-manager-prompt-separator.smoke
 *
 * Verifies:
 *   1. Default call (no packageManager arg) renders "npm test -- ..." in the allowlist
 *   2. Explicit yarn renders "yarn test ..." without the " -- " separator
 *   3. Verification rules example uses the correct package manager and separator for npm
 *   4. Verification rules example uses the correct package manager and separator for yarn
 */

import chalk from 'chalk';
import { formatTestInfraPromptSection } from '../../src/shared/utils/detect-test-infra';
import type { TestInfraContext } from '../../src/shared/utils/detect-test-infra';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const lacks = (text: string, fragment: string): boolean => !text.includes(fragment);

const check = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

const nodeCtx = (scripts: Record<string, string>): TestInfraContext =>
  ({
    primary: 'node',
    ecosystems: [{
      ecosystem: 'node',
      nodeVersionMajor: 22,
      hasNodeTest: true,
      frameworks: ['jest'],
      scripts,
      allScriptNames: Object.keys(scripts),
    }],
  }) as any;

function checkNpmDefaultSeparator(): void {
  const output = formatTestInfraPromptSection(nodeCtx({ test: 'jest', build: 'nest build' }));
  check(
    'default (no packageManager arg) renders "npm test -- ..." in allowlist',
    output.includes('npm test -- ...'),
    `allowlist block: ${output.split('\n').filter(l => l.includes('test')).join(' | ')}`,
  );
}

function checkYarnNoSeparator(): void {
  const output = formatTestInfraPromptSection(nodeCtx({ test: 'jest' }), 'yarn');
  check(
    'yarn renders "yarn test ..." in allowlist',
    output.includes('yarn test ...'),
    `allowlist block: ${output.split('\n').filter(l => l.includes('test')).join(' | ')}`,
  );
  check(
    '"yarn test -- ..." absent from allowlist',
    lacks(output, 'yarn test -- ...'),
    `unexpected "-- " found in: ${output.split('\n').filter(l => l.includes('test')).join(' | ')}`,
  );
}

function checkNpmVerificationRulesExample(): void {
  const output = formatTestInfraPromptSection(nodeCtx({ test: 'jest' }), 'npm');
  check(
    'npm verification rules example contains "npm test -- pricing/pricing.spec.ts"',
    output.includes('npm test -- pricing/pricing.spec.ts'),
    `verification rules excerpt: ${output.split('\n').filter(l => l.includes('pricing')).join(' | ')}`,
  );
}

function checkYarnVerificationRulesExample(): void {
  const output = formatTestInfraPromptSection(nodeCtx({ test: 'jest' }), 'yarn');
  check(
    'yarn verification rules example contains "yarn test pricing/pricing.spec.ts"',
    output.includes('yarn test pricing/pricing.spec.ts'),
    `verification rules excerpt: ${output.split('\n').filter(l => l.includes('pricing')).join(' | ')}`,
  );
  check(
    '"yarn test -- pricing" absent from verification rules',
    lacks(output, 'yarn test -- pricing'),
    `unexpected "-- " found in verification rules`,
  );
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Package-manager prompt separator smoke test\n'));

  console.log(chalk.bold('Allowlist command forms'));
  checkNpmDefaultSeparator();
  checkYarnNoSeparator();

  console.log(chalk.bold('\nVerification rules example'));
  checkNpmVerificationRulesExample();
  checkYarnVerificationRulesExample();

  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
