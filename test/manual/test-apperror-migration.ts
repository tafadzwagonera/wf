/**
 * Manual smoke test: raw `new Error` → `AppError` subclass migration
 *
 * Run: nr test:manual -- test-apperror-migration
 *
 * Verifies:
 *   1. `ApprovalError` carries the APPROVAL_ERROR code and is non-recoverable
 *   2. `isAiProviderErrorLike` still detects `AiProviderError` instances
 *   3. No raw `new Error(` remains in `src/` outside the two documented exclusions
 *
 * @returns void
 */
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ApprovalError, AiProviderError, ERROR_CODE, isAiProviderErrorLike } from '../../src/shared/utils/errors';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.log(chalk.red(`  ✗ ${message}`));
  if (detail) console.log(chalk.red(`    ${detail}`));
  failed += 1;
};

const assert = (label: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
};

const ALLOWED_RAW_ERROR_FILES = [
  path.join('src', 'shared', 'utils', 'execute-with-retry.ts'),
  path.join('src', 'test', 'manual', 'jira-update-smoke.ts'),
];

const walkTsFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTsFiles(fullPath);
    return entry.name.endsWith('.ts') ? [fullPath] : [];
  });

const findRawErrorSites = (srcDir: string): string[] => {
  const repoRoot = path.resolve(srcDir, '..');
  return walkTsFiles(srcDir)
    .filter(filePath => !filePath.endsWith('.spec.ts'))
    .filter(filePath => /new Error\(/.test(fs.readFileSync(filePath, 'utf-8')))
    .map(filePath => path.relative(repoRoot, filePath))
    .filter(relativePath => !ALLOWED_RAW_ERROR_FILES.includes(relativePath));
};

function main(): void {
  console.log(chalk.bold('\nAppError migration smoke test\n'));

  // 1. ApprovalError
  const approvalError = new ApprovalError('approval denied', { approvalId: 'abc-123' });
  assert('ApprovalError carries APPROVAL_ERROR code', approvalError.code === ERROR_CODE.APPROVAL_ERROR, `got: ${approvalError.code}`);
  assert('ApprovalError is not recoverable', approvalError.recoverable === false, `got: ${approvalError.recoverable}`);

  // 2. isAiProviderErrorLike
  const aiError = new AiProviderError('provider failed');
  assert('isAiProviderErrorLike detects AiProviderError', isAiProviderErrorLike(aiError));

  // 3. No raw new Error remains outside documented exclusions
  const srcDir = path.join(__dirname, '..', '..', 'src');
  const remaining = findRawErrorSites(srcDir);
  assert(
    'no raw new Error remains outside execute-with-retry.ts and jira-update-smoke.ts',
    remaining.length === 0,
    remaining.length > 0 ? `found: ${remaining.join(', ')}` : undefined
  );

  // Summary
  console.log(
    chalk.bold(
      `\n${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`
    )
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main();
