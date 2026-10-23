/**
 * Manual Test: SEA binary runs from a bare directory with no dist/, node_modules or node
 *
 * Run: nr test:manual sea-binary-runs-without-repo-or-node.smoke
 * Precondition: yarn build:sea
 *
 * Verifies:
 *   1. PATH=/usr/bin:/bin has no node (environment guard)
 *   2. --help from the copied binary equals scripts/sea/golden/help.txt
 *   3. issue:commit --help is rendered from the embedded catalog
 *   4. issue:cowsay reports the package.json version
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertNodeAbsentFromCleanPath, assertSeaBinaryBuilt, cleanPath, createTempDir, projectRoot, removeDir,
  runSeaBinary, seaBinaryPath,
} from './support/sea-binary-harness';
import { createReporter, summarise } from './support/reporter';

const { counts, pass, fail } = createReporter();

const check = (condition: boolean, message: string, detail?: string): void => {
  if (condition) pass(message);
  else fail(message, detail);
};

type RunOptions = { cwd: string; env: Record<string, string> };

function checkHelpMatchesGolden(binaryCopy: string, options: RunOptions): void {
  const help = runSeaBinary(binaryCopy, ['--help'], options);
  const golden = fs.readFileSync(path.join(projectRoot, 'scripts', 'sea', 'golden', 'help.txt'), 'utf-8');
  check(help.exitCode === 0 && help.output.includes(golden.trim()), '--help equals the golden file', `exit ${help.exitCode}`);
}

function checkCommandHelpFromCatalog(binaryCopy: string, options: RunOptions): void {
  const commitHelp = runSeaBinary(binaryCopy, ['issue:commit', '--help'], options);
  check(commitHelp.exitCode === 0 && commitHelp.output.includes('Usage:') && commitHelp.output.includes('-k, --ticket-key'),
    'issue:commit --help renders from the embedded catalog', commitHelp.output.slice(0, 300));
}

function checkCowsayVersion(binaryCopy: string, options: RunOptions): void {
  const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')) as { version: string };
  const cowsay = runSeaBinary(binaryCopy, ['issue:cowsay'], options);
  check(cowsay.exitCode === 0 && cowsay.output.includes(`wf v${version} is installed and working!`),
    `issue:cowsay reports v${version}`, `exit ${cowsay.exitCode}: ${cowsay.output.slice(-300)}`);
}

function copyBinaryToBareDir(tempRoot: string): { binaryCopy: string; options: RunOptions } {
  const binaryCopy = path.join(tempRoot, 'bin', 'wf');
  const emptyDir = path.join(tempRoot, 'empty');
  fs.mkdirSync(path.dirname(binaryCopy));
  fs.mkdirSync(emptyDir);
  fs.copyFileSync(seaBinaryPath, binaryCopy);
  fs.chmodSync(binaryCopy, 0o755);
  return { binaryCopy, options: { cwd: emptyDir, env: { PATH: cleanPath, HOME: path.join(tempRoot, 'home') } } };
}

function assertCleanEnvironment(): void {
  assertSeaBinaryBuilt();
  assertNodeAbsentFromCleanPath();
  pass(`no node in PATH=${cleanPath}`);
}

function main(): void {
  assertCleanEnvironment();
  console.log('\n SEA binary: bare directory run\n');
  const tempRoot = createTempDir('sea-bare-');
  try {
    const { binaryCopy, options } = copyBinaryToBareDir(tempRoot);
    checkHelpMatchesGolden(binaryCopy, options);
    checkCommandHelpFromCatalog(binaryCopy, options);
    checkCowsayVersion(binaryCopy, options);
  } finally {
    removeDir(tempRoot);
  }
  summarise(counts);
}

main();
