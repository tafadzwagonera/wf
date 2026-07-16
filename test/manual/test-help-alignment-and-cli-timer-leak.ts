/**
 * Manual smoke test: help text alignment and CLI timer leak fix
 *
 * Run: nr test:manual -- test-help-alignment-and-cli-timer-leak
 *
 * Verifies:
 *   1. Help catalog --repos description matches the current command source
 *   2. Help output for issue:generate contains repo-scoped artifact correlation text
 *   3. Help output for issue:generate contains provider-aware diagnostics text
 *   4. spawnCli SIGKILL grace timer calls .unref() (no open handle leak)
 *   5. Full test suite exits cleanly without --forceExit
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getCommandHelpCatalog } from '../../src/bootstrap/help-catalog-parser';
import { getHelpText } from '../../src/bootstrap/help-output';

const repoRoot = path.join(__dirname, '..', '..');

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

/**
 * Run a command and capture stdout + stderr.
 *
 * @param command - Shell command to execute
 * @param args - Arguments array
 * @returns Promise resolving to stdout, stderr, and exit code
 */
const run = (command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
  new Promise(resolve => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'pipe', shell: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('close', code => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        code: code ?? 1,
      });
    });
  });

async function main(): Promise<void> {
  console.log(chalk.bold('\nHelp text alignment & CLI timer leak smoke test\n'));

  const catalog = getCommandHelpCatalog(path.join(repoRoot, 'src', 'commands'));

  {
    console.log(chalk.bold('Test 1: help catalog --repos description'));
    const entry = catalog['issue:generate'];
    const reposOption = entry?.options?.find(o => o.flags.includes('--repos'));

    assert(
      '--repos description mentions artifact storage and read context',
      reposOption?.description?.includes('the first repo anchors artifact storage and read context') === true,
      `Got: ${reposOption?.description}`
    );
  }

  {
    console.log(chalk.bold('Test 2: help output contains repo-scoped generation text'));
    const helpText = getHelpText(['issue:generate', '--help'], catalog);
    const plainText = helpText.replaceAll(/\n\s*/g, ' ');

    assert(
      'Help text mentions repo-scoped artifact correlation',
      plainText.includes('Repo-scoped generation inspects prior plan artifacts'),
      'Missing repo-scoped generation text'
    );
  }

  {
    console.log(chalk.bold('Test 3: help output contains provider-aware diagnostics text'));
    const helpText = getHelpText(['issue:generate', '--help'], catalog);
    const plainText = helpText.replaceAll(/\n\s*/g, ' ');

    assert(
      'Help text mentions provider-aware diagnostics',
      plainText.includes('Blank AI generate-stage responses fail fast with provider-aware diagnostics'),
      'Missing provider-aware diagnostics text'
    );
  }

  {
    console.log(chalk.bold('Test 4: SIGKILL grace timer calls .unref()'));
    const source = fs.readFileSync(
      path.join(repoRoot, 'src', 'integrations', 'ai', 'adapters', 'claude-cli-runner.ts'),
      'utf-8'
    );

    const sigkillBlock = /setTimeout\(\(\)\s*=>\s*\{[^}]*SIGKILL[^}]*\}[^)]*\)[^;]*/s.exec(source);
    assert(
      'SIGKILL grace setTimeout calls .unref()',
      sigkillBlock !== null && sigkillBlock[0].includes('.unref()'),
      `Matched block: ${sigkillBlock?.[0] ?? 'no match'}`
    );
  }

  {
    console.log(chalk.bold('Test 5: test suite exits cleanly (no open handle warning)'));
    const result = await run('npx', [
      'jest',
      '--detectOpenHandles',
      'src/integrations/ai/adapters/claude-cli-runner.spec.ts',
    ]);
    const combined = result.stdout + result.stderr;

    assert('Tests pass', result.code === 0, `Exit code: ${result.code}`);
    assert(
      'No open handle warning in output',
      !combined.includes('open handle') && !combined.includes('force exited'),
      'Found open handle or force exit warning'
    );
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
}

main();
