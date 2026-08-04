/**
 * Manual smoke test: git hooks detection in repo conventions
 *
 * Run: nr test:manual -- test-git-hooks-detection
 *
 * Scenario: detectRepoConventions should detect lefthook, husky, and
 * simple-git-hooks configurations and include them in the gitHooks field
 * of the returned RepoConventionsContext. The formatter should render
 * detected hooks into the prompt section.
 *
 * Config under test:
 *   lefthook.yml with pre-commit and pre-push hooks
 *   .husky/ directory with pre-commit script
 *   package.json with simple-git-hooks key
 *
 * Verify:
 *   1. lefthook.yml detection: creates a temp repo with lefthook.yml,
 *      runs detectRepoConventions, asserts gitHooks[0].tool === 'lefthook'
 *      and hooks include detected hook names
 *   2. Husky directory detection: creates .husky/pre-commit, runs detection,
 *      asserts gitHooks[0].tool === 'husky'
 *   3. simple-git-hooks detection: creates package.json with simple-git-hooks
 *      key, runs detection, asserts gitHooks[0].tool === 'simple-git-hooks'
 *   4. No hooks present: asserts gitHooks is an empty array
 *   5. Malformed lefthook.yml: asserts no throw, gitHooks is empty
 *   6. Formatter renders git hooks line in prompt section
 *   7. Formatter omits git hooks line when gitHooks is empty
 *   8. gitHooks field defaults to [] when constructed via Zod parse
 *
 * Wire up: create temp directories with the appropriate config files, call
 * detectRepoConventions(tempDir) directly, then call
 * formatRepoConventionsPromptSection with the result.
 *
 * Teardown: remove temp directories with fs.rmSync(path, { recursive: true }).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { detectRepoConventions, formatRepoConventionsPromptSection } from '../../src/shared/utils/detect-repo-conventions';
import { repoConventionsContextSchema } from '../../src/shared/schemas/detection.schema';

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

const createTempRepo = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wf-hooks-${prefix}-`));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test-repo', version: '1.0.0' }));
  return dir;
};

const cleanupDir = (dir: string): void => {
  fs.rmSync(dir, { recursive: true, force: true });
};

const run = (): void => {
  console.log(chalk.bold.cyan('\nGit hooks detection smoke test\n'));

  // Test 1: lefthook.yml detection
  console.log(chalk.bold('Test 1: lefthook.yml detection'));
  {
    const dir = createTempRepo('lefthook');
    try {
      fs.writeFileSync(path.join(dir, 'lefthook.yml'), [
        'pre-commit:',
        '  commands:',
        '    lint:',
        '      run: yarn lint',
        '    typecheck:',
        '      run: yarn typecheck',
        'pre-push:',
        '  commands:',
        '    test:',
        '      run: yarn test',
        '',
      ].join('\n'));

      const result = detectRepoConventions(dir);
      assert('gitHooks is non-empty', result.gitHooks.length > 0,
        `Got ${result.gitHooks.length} entries`);
      assert('tool is "lefthook"',
        result.gitHooks.length > 0 && result.gitHooks[0].tool === 'lefthook',
        `Got: ${result.gitHooks[0]?.tool}`);
      assert('pre-commit hooks detected',
        result.gitHooks.length > 0 && 'pre-commit' in result.gitHooks[0].hooks,
        `Got hooks: ${JSON.stringify(result.gitHooks[0]?.hooks)}`);
      assert('pre-push hooks detected',
        result.gitHooks.length > 0 && 'pre-push' in result.gitHooks[0].hooks,
        `Got hooks: ${JSON.stringify(result.gitHooks[0]?.hooks)}`);
      const preCommitCmds = result.gitHooks[0]?.hooks['pre-commit'];
      assert('pre-commit contains "yarn lint"',
        result.gitHooks.length > 0
        && Array.isArray(preCommitCmds)
        && preCommitCmds.includes('yarn lint'),
        `Got: ${JSON.stringify(preCommitCmds)}`);
    } finally {
      cleanupDir(dir);
    }
  }

  // Test 2: .lefthook.yml variant (dot-prefixed)
  console.log(chalk.bold('\nTest 2: .lefthook.yml (dot-prefixed) detection'));
  {
    const dir = createTempRepo('lefthook-dot');
    try {
      fs.writeFileSync(path.join(dir, '.lefthook.yml'), [
        'commit-msg:',
        '  commands:',
        '    commitlint:',
        '      run: npx commitlint --edit',
        '',
      ].join('\n'));

      const result = detectRepoConventions(dir);
      assert('gitHooks detects .lefthook.yml', result.gitHooks.length > 0,
        `Got ${result.gitHooks.length} entries`);
      assert('tool is "lefthook"',
        result.gitHooks.length > 0 && result.gitHooks[0].tool === 'lefthook');
    } finally {
      cleanupDir(dir);
    }
  }

  // Test 3: Husky directory detection
  console.log(chalk.bold('\nTest 3: .husky/ directory detection'));
  {
    const dir = createTempRepo('husky');
    try {
      const huskyDir = path.join(dir, '.husky');
      fs.mkdirSync(huskyDir, { recursive: true });
      fs.writeFileSync(path.join(huskyDir, 'pre-commit'), '#!/usr/bin/env sh\nyarn lint-staged\n');
      fs.writeFileSync(path.join(huskyDir, '_'), '#!/usr/bin/env sh\n. "$(dirname "$0")/_/husky.sh"\n');

      const result = detectRepoConventions(dir);
      assert('gitHooks is non-empty', result.gitHooks.length > 0,
        `Got ${result.gitHooks.length} entries`);
      assert('tool is "husky"',
        result.gitHooks.length > 0 && result.gitHooks[0].tool === 'husky',
        `Got: ${result.gitHooks[0]?.tool}`);
      assert('pre-commit hook detected',
        result.gitHooks.length > 0 && 'pre-commit' in result.gitHooks[0].hooks,
        `Got hooks: ${JSON.stringify(result.gitHooks[0]?.hooks)}`);
      assert('_ file excluded from hooks',
        result.gitHooks.length > 0 && !('_' in result.gitHooks[0].hooks),
        `Got hooks: ${JSON.stringify(result.gitHooks[0]?.hooks)}`);
    } finally {
      cleanupDir(dir);
    }
  }

  // Test 4: simple-git-hooks detection via package.json
  console.log(chalk.bold('\nTest 4: simple-git-hooks detection via package.json'));
  {
    const dir = createTempRepo('sgh');
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'test-repo',
        version: '1.0.0',
        'simple-git-hooks': {
          'pre-commit': 'npx lint-staged',
          'commit-msg': 'npx commitlint --edit',
        },
      }));

      const result = detectRepoConventions(dir);
      assert('gitHooks is non-empty', result.gitHooks.length > 0,
        `Got ${result.gitHooks.length} entries`);
      assert('tool is "simple-git-hooks"',
        result.gitHooks.length > 0 && result.gitHooks[0].tool === 'simple-git-hooks',
        `Got: ${result.gitHooks[0]?.tool}`);
      assert('pre-commit detected',
        result.gitHooks.length > 0 && 'pre-commit' in result.gitHooks[0].hooks);
    } finally {
      cleanupDir(dir);
    }
  }

  // Test 5: No hooks present
  console.log(chalk.bold('\nTest 5: No hooks present returns empty array'));
  {
    const dir = createTempRepo('empty');
    try {
      const result = detectRepoConventions(dir);
      assert('gitHooks is empty array', result.gitHooks.length === 0,
        `Got ${result.gitHooks.length} entries: ${JSON.stringify(result.gitHooks)}`);
    } finally {
      cleanupDir(dir);
    }
  }

  // Test 6: Malformed lefthook.yml does not throw
  console.log(chalk.bold('\nTest 6: Malformed lefthook.yml does not throw'));
  {
    const dir = createTempRepo('malformed');
    try {
      fs.writeFileSync(path.join(dir, 'lefthook.yml'), '{{{{invalid yaml::::');
      let threw = false;
      try {
        const result = detectRepoConventions(dir);
        assert('gitHooks is empty on malformed YAML', result.gitHooks.length === 0,
          `Got ${result.gitHooks.length} entries`);
      } catch {
        threw = true;
      }
      assert('No exception thrown for malformed YAML', !threw);
    } finally {
      cleanupDir(dir);
    }
  }

  // Test 7: Formatter renders git hooks
  console.log(chalk.bold('\nTest 7: Formatter renders git hooks in prompt section'));
  {
    const ctx = repoConventionsContextSchema.parse({
      language: 'typescript',
      linter: null,
      typescript: null,
      go: null,
      python: null,
      terraform: null,
      folderStructure: [],
      namingPattern: 'camelCase',
      nestjsDetected: false,
      importStyle: 'commonjs',
      keyDependencies: [],
      errorHandlingPaths: [],
      gitHooks: [{ tool: 'lefthook', hooks: { 'pre-commit': ['yarn lint', 'yarn test'] } }],
    });

    const output = formatRepoConventionsPromptSection(ctx, 'test-repo');
    assert('Output contains "Git hooks (lefthook)"', output.includes('Git hooks (lefthook)'),
      `Got: ${output}`);
    assert('Output contains "pre-commit: yarn lint, yarn test"',
      output.includes('pre-commit: yarn lint, yarn test'),
      `Got: ${output}`);
  }

  // Test 8: Formatter omits git hooks when empty
  console.log(chalk.bold('\nTest 8: Formatter omits git hooks line when gitHooks is empty'));
  {
    const ctx = repoConventionsContextSchema.parse({
      language: 'unknown',
      linter: null,
      typescript: null,
      go: null,
      python: null,
      terraform: null,
      folderStructure: [],
      namingPattern: 'mixed',
      nestjsDetected: false,
      importStyle: 'unknown',
      keyDependencies: [],
      errorHandlingPaths: [],
    });

    const output = formatRepoConventionsPromptSection(ctx, 'test-repo');
    assert('Output is empty when only gitHooks:[] and no other data', output === '',
      `Got: "${output}"`);
  }

  // Test 9: Zod .default([]) fills in gitHooks when omitted
  console.log(chalk.bold('\nTest 9: Zod .default([]) fills in gitHooks when omitted'));
  {
    const parsed = repoConventionsContextSchema.parse({
      language: 'typescript',
      linter: null,
      typescript: null,
      go: null,
      python: null,
      terraform: null,
      folderStructure: [],
      namingPattern: 'camelCase',
      nestjsDetected: false,
      importStyle: 'commonjs',
      keyDependencies: [],
      errorHandlingPaths: [],
    });
    assert('gitHooks defaults to empty array', Array.isArray(parsed.gitHooks) && parsed.gitHooks.length === 0,
      `Got: ${JSON.stringify(parsed.gitHooks)}`);
  }

  // Summary
  console.log(
    chalk.bold(
      `\n${passed + failed} assertions: ${chalk.green(`${passed} passed`)}${failed > 0 ? `, ${chalk.red(`${failed} failed`)}` : ''}`
    )
  );

  if (failed > 0) {
    process.exit(1);
  }
};

run();
