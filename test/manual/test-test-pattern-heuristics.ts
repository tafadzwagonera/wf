/**
 * Manual smoke test: Test-pattern detection heuristics (mockCleanup, diSetupPattern, errorHandlerExits)
 *
 * Run: nr test:manual -- test-test-pattern-heuristics
 *
 * Verifies:
 *   1. mockCleanup detects dominant restoreAllMocks from test files
 *   2. mockCleanup returns null when no cleanup calls exist
 *   3. mockCleanup counts unique files (not call-site occurrences)
 *   4. diSetupPattern detects testing-module from Test.createTestingModule
 *   5. diSetupPattern detects factory-function from buildCommand/buildAgent
 *   6. diSetupPattern returns null when no pattern is found
 *   7. errorHandlerExits detects handle() + process.exit(1) co-location in src/
 *   8. errorHandlerExits returns false when src/ is absent
 *   9. formatTestInfraPromptSection renders assumption-stating guidance for each heuristic
 *  10. formatTestInfraPromptSection renders shell-safety guidance for inline node commands
 */

import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectTestPatterns, formatTestInfraPromptSection } from '../../src/shared/utils/detect-test-infra';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

const check = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

const createTempRepo = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wf-heuristics-'));

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  Test-pattern heuristics smoke test\n'));

  // ── 1. mockCleanup detects dominant restoreAllMocks ───────────────────
  console.log(chalk.bold('mockCleanup detection'));
  {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, 'src'));
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(dir, 'src', `svc${i}.spec.ts`),
        'afterEach(() => { jest.restoreAllMocks(); }); it("x", () => {})'
      );
    }
    fs.writeFileSync(path.join(dir, 'src', 'plain.spec.ts'), 'it("x", () => {})');

    const result = detectTestPatterns(dir);
    check(
      'detects restoreAllMocks as dominant',
      result?.mockCleanup === 'restoreAllMocks',
      `got: ${result?.mockCleanup}`
    );
  }

  // ── 2. mockCleanup null when absent ───────────────────────────────────
  {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.spec.ts'), 'it("x", () => {})');

    const result = detectTestPatterns(dir);
    check(
      'mockCleanup is null when no cleanup calls exist',
      result?.mockCleanup === null,
      `got: ${result?.mockCleanup}`
    );
  }

  // ── 3. mockCleanup counts unique files ────────────────────────────────
  {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, 'src'));
    // 2 files with restoreAllMocks only
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(
        path.join(dir, 'src', `restore${i}.spec.ts`),
        'afterEach(() => { jest.restoreAllMocks(); }); it("x", () => {})'
      );
    }
    // 1 file with BOTH restoreAllMocks and resetAllMocks
    fs.writeFileSync(
      path.join(dir, 'src', 'mixed.spec.ts'),
      'afterEach(() => { jest.restoreAllMocks(); jest.resetAllMocks(); }); it("x", () => {})'
    );

    const result = detectTestPatterns(dir);
    // 3 unique files with cleanup; restoreAllMocks appears in 3/3 = 100% → should win
    check(
      'restoreAllMocks wins even with mixed file (unique-file counting)',
      result?.mockCleanup === 'restoreAllMocks',
      `got: ${result?.mockCleanup}`
    );
  }

  // ── 4. diSetupPattern detects testing-module ──────────────────────────
  console.log(chalk.bold('\ndiSetupPattern detection'));
  {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'svc.spec.ts'),
      'const module = Test.createTestingModule({ providers: [] }); it("x", () => {})'
    );

    const result = detectTestPatterns(dir);
    check('detects testing-module', result?.diSetupPattern === 'testing-module', `got: ${result?.diSetupPattern}`);
  }

  // ── 5. diSetupPattern detects factory-function ────────────────────────
  {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'cmd.spec.ts'), 'const cmd = buildCommand({ deps: {} }); it("x", () => {})');

    const result = detectTestPatterns(dir);
    check(
      'detects factory-function via buildCommand',
      result?.diSetupPattern === 'factory-function',
      `got: ${result?.diSetupPattern}`
    );
  }

  // ── 6. diSetupPattern null when absent ────────────────────────────────
  {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'plain.spec.ts'), 'it("x", () => {})');

    const result = detectTestPatterns(dir);
    check(
      'diSetupPattern is null when no DI pattern found',
      result?.diSetupPattern === null,
      `got: ${result?.diSetupPattern}`
    );
  }

  // ── 7. errorHandlerExits detects co-location ─────────────────────────
  console.log(chalk.bold('\nerrorHandlerExits detection'));
  {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'error-handler.ts'),
      'export class ErrorHandler { handle(err: Error) { console.error(err); process.exit(1); } }'
    );
    fs.writeFileSync(path.join(dir, 'src', 'test.spec.ts'), 'it("x", () => {})');

    const result = detectTestPatterns(dir);
    check(
      'detects handle() + process.exit(1) co-location',
      result?.errorHandlerExits === true,
      `got: ${result?.errorHandlerExits}`
    );
  }

  // ── 8. errorHandlerExits false when no src/ ───────────────────────────
  {
    const dir = createTempRepo();
    // Test file at root, no src/ directory
    fs.writeFileSync(path.join(dir, 'root.spec.ts'), 'it("x", () => {})');

    const result = detectTestPatterns(dir);
    check(
      'errorHandlerExits is false when src/ absent',
      result?.errorHandlerExits === false,
      `got: ${result?.errorHandlerExits}`
    );
  }

  // ── 9. formatTestInfraPromptSection renders assumption-stating guidance ─
  console.log(chalk.bold('\nPrompt rendering'));
  {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: 'mock',
            mockFactoryPrefix: null,
            describeStyle: 'nested',
            helperPaths: [],
            mockCleanup: 'restoreAllMocks',
            diSetupPattern: 'testing-module',
            errorHandlerExits: true,
          },
        },
      ],
      primary: 'node',
    });

    check(
      'renders mockCleanup line',
      output.includes('jest.restoreAllMocks()') && output.includes('afterEach()'),
      'missing mockCleanup prompt text'
    );
    check(
      'renders testing-module DI line with assumption guidance',
      output.includes('testing-module pattern') && output.includes('State which DI framework'),
      'missing testing-module prompt text'
    );
    check(
      'renders errorHandlerExits line',
      output.includes('process.exit(1)') && output.includes('MUST mock process.exit'),
      'missing errorHandlerExits prompt text'
    );
    check(
      'renders shell-safety guidance for node -e',
      output.includes('Verification commands MUST be shell-safe by construction.')
      && output.includes('single-quoted JS strings or properly escaped backticks'),
      'missing shell-safety prompt text'
    );
  }

  // ── 10. formatTestInfraPromptSection renders factory-function guidance ─
  {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest' },
          allScriptNames: ['test'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: null,
            mockFactoryPrefix: null,
            describeStyle: 'flat',
            helperPaths: [],
            mockCleanup: null,
            diSetupPattern: 'factory-function',
            errorHandlerExits: false,
          },
        },
      ],
      primary: 'node',
    });

    check(
      'renders factory-function DI line with assumption guidance',
      output.includes('factory helpers') && output.includes('State which factory'),
      'missing factory-function prompt text'
    );
    check(
      'omits mockCleanup when null',
      !output.includes('Mock isolation'),
      'mockCleanup rendered when it should be absent'
    );
    check(
      'omits errorHandlerExits when false',
      !output.includes('Error handler'),
      'errorHandlerExits rendered when it should be absent'
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
