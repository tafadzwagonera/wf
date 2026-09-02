/**
 * Manual smoke test: Test-pattern detection heuristics (mockCleanup, diSetupPattern, errorHandlerExits)
 *
 * Run: nr test:manual -- test-test-pattern-heuristics
 *
 * Verifies:
 *   1. mockCleanup detects dominant restoreAllMocks from test files
 *   2. mockCleanup returns null when no cleanup calls exist
 *   3. mockCleanup counts unique files (not call-site occurrences)
 *   3a. mockCleanup detects vi namespace when Vitest dominates
 *   3b. formatTestInfraPromptSection renders vi.restoreAllMocks for Vitest projects
 *   4. diSetupPattern detects testing-module from Test.createTestingModule
 *   5. diSetupPattern detects factory-function from buildCommand/buildAgent
 *   6. diSetupPattern returns null when no pattern is found
 *   7. errorHandlerExits detects handle() + process.exit(1) co-location in src/
 *   8. errorHandlerExits returns false when src/ is absent
 *   9. formatTestInfraPromptSection renders assumption-stating guidance for each heuristic
 *  10. formatTestInfraPromptSection renders shell-safety guidance for inline node commands
 */

import chalk from 'chalk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectTestPatterns, formatTestInfraPromptSection } from '../../src/shared/utils/detect-test-infra';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

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
      result?.mockCleanup?.method === 'restoreAllMocks' && result?.mockCleanup?.namespace === 'jest',
      `got: ${JSON.stringify(result?.mockCleanup)}`
    );
  }

  {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.spec.ts'), 'it("x", () => {})');

    const result = detectTestPatterns(dir);
    check(
      'mockCleanup is null when no cleanup calls exist',
      result?.mockCleanup === null,
      `got: ${JSON.stringify(result?.mockCleanup)}`
    );
  }

  {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, 'src'));
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(
        path.join(dir, 'src', `restore${i}.spec.ts`),
        'afterEach(() => { jest.restoreAllMocks(); }); it("x", () => {})'
      );
    }
    fs.writeFileSync(
      path.join(dir, 'src', 'mixed.spec.ts'),
      'afterEach(() => { jest.restoreAllMocks(); jest.resetAllMocks(); }); it("x", () => {})'
    );

    const result = detectTestPatterns(dir);
    check(
      'restoreAllMocks wins even with mixed file (unique-file counting)',
      result?.mockCleanup?.method === 'restoreAllMocks' && result?.mockCleanup?.namespace === 'jest',
      `got: ${JSON.stringify(result?.mockCleanup)}`
    );
  }

  {
    const dir = createTempRepo();
    fs.mkdirSync(path.join(dir, 'src'));
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(dir, 'src', `cmp${i}.spec.ts`),
        'afterEach(() => { vi.restoreAllMocks(); }); it("x", () => {})'
      );
    }

    const result = detectTestPatterns(dir);
    check(
      'detects vi namespace when Vitest cleanup dominates',
      result?.mockCleanup?.method === 'restoreAllMocks' && result?.mockCleanup?.namespace === 'vi',
      `got: ${JSON.stringify(result?.mockCleanup)}`
    );
  }

  {
    const output = formatTestInfraPromptSection({
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: false,
          frameworks: ['vitest'],
          scripts: { test: 'vitest' },
          allScriptNames: ['test'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: 'mock',
            mockFactoryPrefix: null,
            describeStyle: 'flat',
            helperPaths: [],
            mockCleanup: { namespace: 'vi', method: 'restoreAllMocks' },
            diSetupPattern: null,
            errorHandlerExits: false,
          },
        },
      ],
      primary: 'node',
    });

    check(
      'renders vi.restoreAllMocks (not jest.restoreAllMocks) for Vitest',
      output.includes('vi.restoreAllMocks()') && !output.includes('jest.restoreAllMocks()'),
      `prompt contains: ${output.includes('vi.restoreAllMocks()') ? 'vi.restoreAllMocks' : 'MISSING vi.restoreAllMocks'}; ${output.includes('jest.restoreAllMocks()') ? 'UNEXPECTED jest.restoreAllMocks' : 'no jest.restoreAllMocks (correct)'}`
    );
  }

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

  {
    const dir = createTempRepo();
    fs.writeFileSync(path.join(dir, 'root.spec.ts'), 'it("x", () => {})');

    const result = detectTestPatterns(dir);
    check(
      'errorHandlerExits is false when src/ absent',
      result?.errorHandlerExits === false,
      `got: ${result?.errorHandlerExits}`
    );
  }

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
            mockCleanup: { namespace: 'jest', method: 'restoreAllMocks' },
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

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${counts.passed}`);
  console.log(`  Failed: ${counts.failed}`);

  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
