/**
 * Manual Test: authored example comments render as wrapped "# ..." lines in real CLI output
 *
 * Run: nr test:manual -- test-issue-examples-comment-rendering
 *
 * Verifies that:
 *   1. `wf issue:fetch --help` prints "  # Fetch ticket from primary tracker"
 *      directly above its "wf issue:fetch WBP-2971" command line
 *   2. `wf issue:review --help`'s longest comment wraps across multiple lines,
 *      each no wider than 80 columns
 *   3. Comment lines are visually distinct from command lines (start with "#",
 *      never with "wf " or "yarn ")
 *   4. The same behaviour holds for the runtime header (not just -h), using
 *      `wf issue:commit --dry-run` (--message bypasses AI so it fails fast on
 *      the missing repo instead of hanging)
 *
 * This is a live-process regression guard for a fix applied after code review:
 * renderExamplesSection originally dropped example.comment entirely, silently
 * regressing UX the old printExamples helper had. Unit tests cover the
 * renderer's return value with a mocked chalk; this test instead spawns the
 * built CLI as a real child process (non-TTY stdout, so chalk's real color
 * logic runs and disables ANSI codes) to confirm the fix holds end-to-end.
 *
 * No AI / API keys required — --help never executes command logic, and the
 * issue:commit --dry-run path fails fast on a non-git scratch dir.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const DIST_MAIN = path.join(__dirname, '../../dist/main.js');
const ANSI_ESCAPE = String.fromCodePoint(27);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g');

let passed = 0;
let failed = 0;
const pass = (msg: string) => {
  console.log(`  ✓ ${msg}`);
  passed++;
};
const fail = (msg: string, detail?: string) => {
  console.error(`  ✗ ${msg}${detail ? `\n    -> ${detail}` : ''}`);
  failed++;
};

function runCli(args: string[], cwd: string): string {
  try {
    return execFileSync('node', [DIST_MAIN, ...args], { encoding: 'utf-8', cwd });
  } catch (err: any) {
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

async function main() {
  console.log('\n example comment rendering (live CLI)\n');

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-comment-render-'));

  try {
    const fetchHelp = runCli(['issue:fetch', '--help'], scratchDir).replaceAll(ANSI_PATTERN, '');
    const fetchLines = fetchHelp.split('\n').map(l => l.trimEnd());
    const commentIndex = fetchLines.findIndex(l => l.trim() === '# Fetch ticket from primary tracker');

    if (commentIndex !== -1 && fetchLines[commentIndex + 1]?.trim() === 'wf issue:fetch WBP-2971') {
      pass('issue:fetch --help prints the authored comment directly above its command');
    } else {
      fail('Comment line not found (or not immediately above the command)', fetchHelp.slice(0, 400));
    }

    const reviewHelp = runCli(['issue:review', '--help'], scratchDir).replaceAll(ANSI_PATTERN, '');
    const reviewLines = reviewHelp.split('\n');
    const longCommentStart = reviewLines.findIndex(l => l.includes('Resume a provider-backed review session'));

    if (longCommentStart !== -1) {
      const wrappedLines = [reviewLines[longCommentStart]];
      if (reviewLines[longCommentStart + 1]?.trim().startsWith('human-readable summary')) {
        wrappedLines.push(reviewLines[longCommentStart + 1]);
      }
      if (wrappedLines.length > 1 && wrappedLines.every(l => l.length <= 80)) {
        pass('The longest comment wraps across multiple lines, each within 80 columns');
      } else {
        fail('Long comment did not wrap as expected', wrappedLines.join('\\n'));
      }
    } else {
      fail('Could not locate the long "Resume a provider-backed" comment in issue:review --help');
    }

    const examplesStart = reviewLines.findIndex(l => l.trim() === 'Examples:');
    const exampleBlockLines = examplesStart === -1
      ? []
      : reviewLines.slice(examplesStart + 1).filter(l => l.trim().length > 0);
    const misplacedCommandStarts = exampleBlockLines.filter(l => {
      const trimmed = l.trim();
      return (trimmed.startsWith('wf ') || trimmed.startsWith('yarn ')) && trimmed.startsWith('#');
    });

    if (exampleBlockLines.length > 0 && misplacedCommandStarts.length === 0) {
      pass('Comment lines and command lines remain visually distinct (no line is both)');
    } else {
      fail('Found a line that looks like both a comment and a command', misplacedCommandStarts.join('\\n'));
    }

    const commitHeaderOutput = runCli(['issue:commit', '--dry-run', '-k', 'WBP-1'], scratchDir).replaceAll(ANSI_PATTERN, '');
    if (commitHeaderOutput.includes('# AI-generated commit message')) {
      pass('The runtime header (not just -h) also renders authored comments');
    } else {
      fail('Runtime header did not render the authored comment', commitHeaderOutput.slice(0, 400));
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed!');
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
