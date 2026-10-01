/**
 * Manual smoke test: terraform fmt -recursive warning in verification manifests.
 *
 * Run: nr test:manual verification-manifest-fmt-scope.smoke.ts
 *
 * Verifies:
 *   1. parseVerificationManifest warns when a baseline step uses terraform fmt -recursive
 *   2. parseVerificationManifest warns when a baseline step uses terraform fmt --recursive
 *   3. parseVerificationManifest does not warn for a scoped terraform fmt -check <file.tf> step
 *   4. parseVerificationManifest does not warn for non-terraform baseline steps
 */

import { parseVerificationManifest } from '../../src/shared/utils/verification-manifest';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const check = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

const checkAbsent = (message: string, text: string, fragment: string, detail?: string): void => {
  if (text.includes(fragment)) {
    fail(message, detail);
    return;
  }
  pass(message);
};

const captureWarn = (): { messages: string[]; restore: () => void } => {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.join(' '));
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
    },
  };
};

const makeManifest = (run: string): string =>
  JSON.stringify({ version: 1, baseline: [{ id: 'format', run, policy: 'enforced' }] });

function checkRecursiveSingleDash(): void {
  const { messages, restore } = captureWarn();
  parseVerificationManifest(makeManifest('terraform fmt -check -recursive'), '/tmp/verification.json');
  restore();
  const joined = messages.join('\n');
  check('warns for -recursive flag', messages.length > 0, 'expected at least one warning');
  check('warning mentions terraform fmt -recursive', joined.includes('terraform fmt -recursive'), `got: ${joined}`);
  check('warning names the step id', joined.includes('"format"'), `got: ${joined}`);
}

function checkRecursiveDoubleDash(): void {
  const { messages, restore } = captureWarn();
  parseVerificationManifest(makeManifest('terraform fmt --recursive'), '/tmp/verification.json');
  restore();
  check('warns for --recursive flag', messages.some(m => m.includes('terraform fmt -recursive')), `got: ${messages.join('\n')}`);
}

function checkScopedFormNoWarn(): void {
  const { messages, restore } = captureWarn();
  parseVerificationManifest(makeManifest('terraform fmt -check main.tf variables.tf'), '/tmp/verification.json');
  restore();
  checkAbsent('no warning for scoped terraform fmt -check', messages.join('\n'), 'terraform fmt -recursive', `got: ${messages.join('\n')}`);
}

function checkNonTerraformNoWarn(): void {
  const { messages, restore } = captureWarn();
  parseVerificationManifest(
    JSON.stringify({ version: 1, baseline: [{ id: 'lint', run: 'yarn lint', policy: 'enforced' }] }),
    '/tmp/verification.json',
  );
  restore();
  checkAbsent('no warning for non-terraform step', messages.join('\n'), 'terraform fmt -recursive', `got: ${messages.join('\n')}`);
}

async function main(): Promise<void> {
  console.log('\n  Verification manifest terraform fmt scope warning\n');
  checkRecursiveSingleDash();
  checkRecursiveDoubleDash();
  checkScopedFormNoWarn();
  checkNonTerraformNoWarn();
  summarise(counts);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
