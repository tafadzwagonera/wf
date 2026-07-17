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
