/**
 * Manual Test: walkDir with .gitignore integration and detectTestPatterns
 *
 * Run:
 *   nr test:manual -- test-walk-dir-and-test-patterns
 *
 * Verifies:
 * 1. walkDir skips DEFAULT_SKIP_DIRS entries
 * 2. parseGitignore extracts bare directory names from a .gitignore file
 * 3. buildSkipDirs merges DEFAULT_SKIP_DIRS with .gitignore entries
 * 4. walkDir respects the merged skip set
 * 5. detectTestPatterns detects .spec suffix, mock prefix, factory prefix,
 *    nested describe style, and helper paths from a synthetic repo
 * 6. formatTestInfraPromptSection emits test conventions block and allowlist
 */

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { walkDir, DEFAULT_SKIP_DIRS, parseGitignore, buildSkipDirs } from '../../src/shared/utils/walk-dir';
import { detectTestPatterns, formatTestInfraPromptSection } from '../../src/shared/utils/detect-test-infra';

const createTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wf-smoke-'));

// --- 1. walkDir skips DEFAULT_SKIP_DIRS ---
{
  const dir = createTempDir();
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.ts'), '');
  fs.writeFileSync(path.join(dir, 'app.ts'), '');

  const result = walkDir(dir, f => f.endsWith('.ts'));
  assert.strictEqual(result.length, 1, 'walkDir should skip node_modules');
  assert.ok(result[0].endsWith('app.ts'), 'walkDir should return non-skipped files');
  console.log('PASS: walkDir skips DEFAULT_SKIP_DIRS');
}

// --- 2. parseGitignore extracts directory names ---
{
  const dir = createTempDir();
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    ['# Build artifacts', '.wf/', 'logs/', '', '*.log', '!important/', 'src/generated/', '.env'].join('\n')
  );

  const result = parseGitignore(path.join(dir, '.gitignore'));
  assert.ok(result.has('.wf'), 'should extract .wf/ as .wf');
  assert.ok(result.has('logs'), 'should extract logs/ as logs');
  assert.ok(result.has('.env'), 'should extract bare .env');
  assert.ok(!result.has('*.log'), 'should skip wildcard patterns');
  assert.ok(!result.has('important'), 'should skip negated patterns');
  assert.ok(!result.has('src/generated'), 'should skip patterns with embedded separators');
  console.log('PASS: parseGitignore extracts correct entries');
}

// --- 3. buildSkipDirs merges defaults with .gitignore ---
{
  const dir = createTempDir();
  fs.writeFileSync(path.join(dir, '.gitignore'), '.wf/\ncustom-out/\n');

  const result = buildSkipDirs(dir);
  for (const d of DEFAULT_SKIP_DIRS) {
    assert.ok(result.has(d), `buildSkipDirs should include default: ${d}`);
  }
  assert.ok(result.has('.wf'), 'buildSkipDirs should include .gitignore entry .wf');
  assert.ok(result.has('custom-out'), 'buildSkipDirs should include .gitignore entry custom-out');
  console.log('PASS: buildSkipDirs merges defaults with .gitignore');
}

// --- 4. walkDir respects merged skip set ---
{
  const dir = createTempDir();
  fs.writeFileSync(path.join(dir, '.gitignore'), '.wf/\n');
  fs.mkdirSync(path.join(dir, '.wf'));
  fs.writeFileSync(path.join(dir, '.wf', 'state.json'), '');
  fs.writeFileSync(path.join(dir, 'index.ts'), '');

  const skipDirs = buildSkipDirs(dir);
  const result = walkDir(dir, f => true, skipDirs);
  const hasWfFile = result.some(f => f.includes('.wf'));
  assert.ok(!hasWfFile, 'walkDir with merged skipDirs should skip .wf/');
  assert.ok(
    result.some(f => f.endsWith('index.ts')),
    'walkDir should still return non-skipped files'
  );
  console.log('PASS: walkDir respects merged skip set from .gitignore');
}

// --- 5. detectTestPatterns detects conventions from synthetic repo ---
{
  const dir = createTempDir();
  fs.mkdirSync(path.join(dir, 'src'));

  // Create 5 .spec.ts files with mock prefix, factory, and nested describe
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(
      path.join(dir, 'src', `service${i}.spec.ts`),
      [
        'const mockService = {};',
        'const createMockService = () => ({});',
        'describe("outer", () => {',
        '  describe("inner", () => {',
        '    it("works", () => {});',
        '  });',
        '});',
      ].join('\n')
    );
  }

  // Create a test-utils helper directory
  fs.mkdirSync(path.join(dir, 'src', 'test-utils'));
  fs.writeFileSync(path.join(dir, 'src', 'test-utils', 'helpers.ts'), '');

  const patterns = detectTestPatterns(dir);
  assert.ok(patterns, 'detectTestPatterns should return a result');
  assert.strictEqual(patterns.fileSuffix, '.spec', 'fileSuffix should be .spec');
  assert.strictEqual(patterns.mockPrefix, 'mock', 'mockPrefix should be mock');
  assert.strictEqual(patterns.mockFactoryPrefix, 'createMock', 'mockFactoryPrefix should be createMock');
  assert.strictEqual(patterns.describeStyle, 'nested', 'describeStyle should be nested');
  assert.ok(
    patterns.helperPaths.some(p => p.includes('test-utils')),
    'helperPaths should include test-utils'
  );
  console.log('PASS: detectTestPatterns detects .spec, mock, createMock, nested, helpers');
}

// --- 6. formatTestInfraPromptSection emits test conventions and allowlist ---
{
  const output = formatTestInfraPromptSection({
    ecosystems: [
      {
        ecosystem: 'node',
        nodeVersionMajor: 22,
        hasNodeTest: true,
        frameworks: ['jest'],
        scripts: { test: 'jest', build: 'nest build' },
        allScriptNames: ['test', 'build'],
        testPatterns: {
          fileSuffix: '.spec',
          mockPrefix: 'mock',
          mockFactoryPrefix: 'createMock',
          describeStyle: 'nested',
          helperPaths: ['src/test-utils/helpers.ts'],
        },
      },
    ],
    primary: 'node',
  });

  assert.ok(output.includes('Test conventions detected'), 'should include test conventions header');
  assert.ok(output.includes('*.spec.ts'), 'should include suffix label');
  assert.ok(output.includes('prefix mocks with "mock"'), 'should include mock prefix');
  assert.ok(output.includes('createMock'), 'should include factory prefix');
  assert.ok(output.includes('nested describe blocks'), 'should include describe style');
  assert.ok(output.includes('src/test-utils/helpers.ts'), 'should include helper path');
  assert.ok(output.includes('Allowed verification command forms'), 'should include allowlist header');
  assert.ok(output.includes('yarn test -- ...'), 'should include yarn test in allowlist');
  assert.ok(output.includes('yarn build -- ...'), 'should include yarn build in allowlist');
  console.log('PASS: formatTestInfraPromptSection emits conventions and allowlist');
}

console.log('\nAll smoke tests passed.');
