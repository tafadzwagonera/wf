import chalk from 'chalk';
import type { VerificationOutcome, VerificationScript } from '../../../shared/types/agent.types';

/**
 * Fills in 'skipped' entries for verification scripts that have no matching outcome.
 *
 * @param scripts - The full list of configured verification scripts.
 * @param outcomes - The outcomes collected during the session.
 * @returns A complete list of outcomes with skipped entries appended.
 */
export function resolveSkippedSteps(
  scripts: VerificationScript[],
  outcomes: VerificationOutcome[],
): VerificationOutcome[] {
  const result = [...outcomes];
  for (const script of scripts) {
    const alreadyRecorded = outcomes.some(
      o => o.command.includes(script.command) || script.command.includes(o.command),
    );
    if (!alreadyRecorded) {
      result.push({ id: script.id, command: script.command, policy: script.policy, status: 'skipped' });
    }
  }
  return result;
}

const STATUS_ICONS: Record<VerificationOutcome['status'], string> = {
  passed: chalk.green('✅'),
  failed: chalk.red('❌'),
  skipped: chalk.yellow('⏭'),
};

/**
 * Prints a deterministic verification report to the console.
 * Each step is printed with a status icon: ✅ passed, ❌ failed, ⏭ skipped.
 *
 * @param outcomes - The complete list of verification outcomes.
 */
export function printVerificationReport(outcomes: VerificationOutcome[]): void {
  if (outcomes.length === 0) return;
  console.log(chalk.bold('\n  Verification report:'));
  for (const outcome of outcomes) {
    const icon = STATUS_ICONS[outcome.status];
    const policy = outcome.policy === 'enforced' ? chalk.red('[enforced]') : chalk.gray('[best_effort]');
    console.log(`    ${icon} ${policy} ${outcome.command}`);
  }
}

/**
 * Returns only the enforced-failed outcomes from the given list.
 *
 * @param outcomes - Verification outcomes to filter.
 * @returns Enforced outcomes with status 'failed'.
 */
export function getEnforcedFailures(outcomes: VerificationOutcome[]): VerificationOutcome[] {
  return outcomes.filter(o => o.policy === 'enforced' && o.status === 'failed');
}

/**
 * Removes enforced-failed outcomes from the array in place, keeping all others.
 * This allows a fix pass to record fresh results without duplicating prior failures.
 *
 * @param outcomes - Mutable outcomes array to prune.
 * @returns The same array reference after removal.
 */
export function clearEnforcedFailures(outcomes: VerificationOutcome[]): VerificationOutcome[] {
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i].policy === 'enforced' && outcomes[i].status === 'failed') {
      outcomes.splice(i, 1);
    }
  }
  return outcomes;
}

const MAX_VERIFICATION_FIX_PASSES = 2;

/**
 * Maximum number of fix passes the adapter should attempt before giving up.
 */
export const VERIFICATION_FIX_PASS_LIMIT = MAX_VERIFICATION_FIX_PASSES;

/**
 * Builds a prompt instructing the AI to fix enforced verification failures.
 *
 * @param failedCommands - Bullet list of failed command strings.
 * @returns The prompt string for the fix pass.
 */
export function buildVerificationFixPrompt(failedCommands: string): string {
  return (
    `The following enforced verification commands failed:\n\n${failedCommands}\n\n`
    + `Read the error output carefully, identify the root cause of each failure, `
    + `and fix the code so all listed commands pass. `
    + `After making your changes, re-run each failed command to confirm it passes. `
    + `Do not output any text or plan before making your first tool call.`
  );
}
