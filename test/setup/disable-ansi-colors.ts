/**
 * Forces chalk to emit plain text for the whole test run.
 *
 * Specs assert on exact console output, but chalk resolves its color level from the
 * invoking shell (`FORCE_COLOR`, TTY detection) at import time. A shell that forces
 * color makes the same suite fail with ANSI codes embedded in otherwise identical
 * strings — invisible in terminal diffs and absent in sandboxed runs.
 *
 * Runs as a `setupFiles` entry so the variable is in place before any module imports
 * chalk.
 */
process.env['FORCE_COLOR'] = '0';
