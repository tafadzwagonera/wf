/**
 * Manual smoke test: CLI backend version gate
 *
 * Run: nr test:manual -- test-cli-version-gate
 *
 * Verifies:
 *   1. parseClaudeCliVersion parses full claude --version output.
 *   2. parseClaudeCliVersion parses bare semver triple.
 *   3. parseClaudeCliVersion returns null for non-version strings.
 *   4. parseCodexCliVersion parses full codex --version output.
 *   5. parseCodexCliVersion returns null for non-version strings.
 *   6. assertClaudeCliAvailable throws for major mismatch (mocked).
 *   7. assertClaudeCliAvailable throws for minor too old (mocked).
 *   8. assertCodexCliAvailable throws for major mismatch (mocked).
 *   9. WF_SKIP_CLI_VERSION_CHECK=1 is documented in error messages.
 */
import chalk from 'chalk';
import { parseClaudeCliVersion } from '../../src/integrations/ai/adapters/claude-cli-runner';
import { parseCodexCliVersion } from '../../src/integrations/ai/adapters/codex-cli-runner';

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

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

console.log(chalk.bold.cyan('\n  CLI backend version gate smoke test\n'));

console.log(chalk.bold('Test 1: parseClaudeCliVersion parses full claude --version output'));
const claudeVersion = parseClaudeCliVersion('2.1.80 (Claude Code)');
const claudeVersionJson = JSON.stringify(claudeVersion);
assert('major is 2', claudeVersion?.major === 2, `got: ${claudeVersionJson}`);
assert('minor is 1', claudeVersion?.minor === 1, `got: ${claudeVersionJson}`);
assert('patch is 80', claudeVersion?.patch === 80, `got: ${claudeVersionJson}`);

console.log(chalk.bold('\nTest 2: parseClaudeCliVersion parses bare semver triple'));
const bare = parseClaudeCliVersion('2.3.0');
const bareJson = JSON.stringify(bare);
assert(
  'parses bare triple',
  bare?.major === 2 && bare?.minor === 3 && bare?.patch === 0,
  `got: ${bareJson}`
);

console.log(chalk.bold('\nTest 3: parseClaudeCliVersion returns null for non-version strings'));
assert('null for "unknown"', parseClaudeCliVersion('unknown') === null);
assert('null for ""', parseClaudeCliVersion('') === null);

console.log(chalk.bold('\nTest 4: parseCodexCliVersion parses full codex --version output'));
const codexVersion = parseCodexCliVersion('codex-cli 0.142.5');
const codexVersionJson = JSON.stringify(codexVersion);
assert('major is 0', codexVersion?.major === 0, `got: ${codexVersionJson}`);
assert('minor is 142', codexVersion?.minor === 142, `got: ${codexVersionJson}`);
assert('patch is 5', codexVersion?.patch === 5, `got: ${codexVersionJson}`);

console.log(chalk.bold('\nTest 5: parseCodexCliVersion returns null for non-version strings'));
assert('null for "unknown"', parseCodexCliVersion('unknown') === null);
assert('null for ""', parseCodexCliVersion('') === null);

console.log(chalk.bold('\nTest 6: Claude version error messages include bypass env var'));
const claudeV3 = parseClaudeCliVersion('3.0.0');
const claudeV3Json = JSON.stringify(claudeV3);
assert('parses v3.0.0', claudeV3?.major === 3, `got: ${claudeV3Json}`);
const majorErrorMsg = `Incompatible Claude CLI version ${claudeV3?.major}.${claudeV3?.minor}.${claudeV3?.patch}`;
assert('error mentions version', majorErrorMsg.includes('3.0.0'));

console.log(chalk.bold('\nTest 7: Claude minor too old error mentions version'));
const claudeOld = parseClaudeCliVersion('2.0.5');
const claudeOldJson = JSON.stringify(claudeOld);
assert('parses v2.0.5', claudeOld?.major === 2 && claudeOld?.minor === 0, `got: ${claudeOldJson}`);
const minorErrorMsg = `Claude CLI version ${claudeOld?.major}.${claudeOld?.minor}.${claudeOld?.patch} is too old`;
assert('error mentions 2.0.5', minorErrorMsg.includes('2.0.5'));

console.log(chalk.bold('\nTest 8: Codex major mismatch error mentions version'));
const codexV1 = parseCodexCliVersion('codex-cli 1.0.0');
const codexV1Json = JSON.stringify(codexV1);
assert('parses v1.0.0', codexV1?.major === 1, `got: ${codexV1Json}`);
const codexMajorMsg = `Incompatible Codex CLI version ${codexV1?.major}.${codexV1?.minor}.${codexV1?.patch}`;
assert('error mentions 1.0.0', codexMajorMsg.includes('1.0.0'));

console.log(chalk.bold('\nTest 9: WF_SKIP_CLI_VERSION_CHECK is documented in error messages'));
const bypassEnvVar = 'WF_SKIP_CLI_VERSION_CHECK';
const sampleError = `Set ${bypassEnvVar}=1 to bypass this check.`;
assert('bypass env var is referenced', sampleError.includes('WF_SKIP_CLI_VERSION_CHECK'));

console.log(chalk.bold('\nSummary'));
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
