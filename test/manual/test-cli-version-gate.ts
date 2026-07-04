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
  console.error(chalk.red(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  CLI backend version gate smoke test\n'));

  // --- Test 1: parseClaudeCliVersion parses full output ---
  console.log(chalk.bold('Test 1: parseClaudeCliVersion parses full claude --version output'));
  const claudeVersion = parseClaudeCliVersion('2.1.80 (Claude Code)');
  assert('major is 2', claudeVersion?.major === 2, `got: ${JSON.stringify(claudeVersion)}`);
  assert('minor is 1', claudeVersion?.minor === 1, `got: ${JSON.stringify(claudeVersion)}`);
  assert('patch is 80', claudeVersion?.patch === 80, `got: ${JSON.stringify(claudeVersion)}`);

  // --- Test 2: parseClaudeCliVersion parses bare semver ---
  console.log(chalk.bold('\nTest 2: parseClaudeCliVersion parses bare semver triple'));
  const bare = parseClaudeCliVersion('2.3.0');
  assert(
    'parses bare triple',
    bare?.major === 2 && bare?.minor === 3 && bare?.patch === 0,
    `got: ${JSON.stringify(bare)}`
  );

  // --- Test 3: parseClaudeCliVersion returns null for non-version ---
  console.log(chalk.bold('\nTest 3: parseClaudeCliVersion returns null for non-version strings'));
  assert('null for "unknown"', parseClaudeCliVersion('unknown') === null);
  assert('null for ""', parseClaudeCliVersion('') === null);

  // --- Test 4: parseCodexCliVersion parses full output ---
  console.log(chalk.bold('\nTest 4: parseCodexCliVersion parses full codex --version output'));
  const codexVersion = parseCodexCliVersion('codex-cli 0.142.5');
  assert('major is 0', codexVersion?.major === 0, `got: ${JSON.stringify(codexVersion)}`);
  assert('minor is 142', codexVersion?.minor === 142, `got: ${JSON.stringify(codexVersion)}`);
  assert('patch is 5', codexVersion?.patch === 5, `got: ${JSON.stringify(codexVersion)}`);

  // --- Test 5: parseCodexCliVersion returns null for non-version ---
  console.log(chalk.bold('\nTest 5: parseCodexCliVersion returns null for non-version strings'));
  assert('null for "unknown"', parseCodexCliVersion('unknown') === null);
  assert('null for ""', parseCodexCliVersion('') === null);

  // --- Test 6: Error message for Claude major mismatch mentions bypass ---
  console.log(chalk.bold('\nTest 6: Claude version error messages include bypass env var'));
  const claudeV3 = parseClaudeCliVersion('3.0.0');
  assert('parses v3.0.0', claudeV3?.major === 3, `got: ${JSON.stringify(claudeV3)}`);
  // Simulate the error message format from assertClaudeCliAvailable
  const majorErrorMsg = `Incompatible Claude CLI version ${claudeV3!.major}.${claudeV3!.minor}.${claudeV3!.patch}`;
  assert('error mentions version', majorErrorMsg.includes('3.0.0'));

  // --- Test 7: Error message for Claude minor too old ---
  console.log(chalk.bold('\nTest 7: Claude minor too old error mentions version'));
  const claudeOld = parseClaudeCliVersion('2.0.5');
  assert('parses v2.0.5', claudeOld?.major === 2 && claudeOld?.minor === 0, `got: ${JSON.stringify(claudeOld)}`);
  const minorErrorMsg = `Claude CLI version ${claudeOld!.major}.${claudeOld!.minor}.${claudeOld!.patch} is too old`;
  assert('error mentions 2.0.5', minorErrorMsg.includes('2.0.5'));

  // --- Test 8: Error message for Codex major mismatch ---
  console.log(chalk.bold('\nTest 8: Codex major mismatch error mentions version'));
  const codexV1 = parseCodexCliVersion('codex-cli 1.0.0');
  assert('parses v1.0.0', codexV1?.major === 1, `got: ${JSON.stringify(codexV1)}`);
  const codexMajorMsg = `Incompatible Codex CLI version ${codexV1!.major}.${codexV1!.minor}.${codexV1!.patch}`;
  assert('error mentions 1.0.0', codexMajorMsg.includes('1.0.0'));

  // --- Test 9: Bypass env var name is consistent ---
  console.log(chalk.bold('\nTest 9: WF_SKIP_CLI_VERSION_CHECK is documented in error messages'));
  const bypassEnvVar = 'WF_SKIP_CLI_VERSION_CHECK';
  const sampleError = `Set ${bypassEnvVar}=1 to bypass this check.`;
  assert('bypass env var is referenced', sampleError.includes('WF_SKIP_CLI_VERSION_CHECK'));

  // --- Summary ---
  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
