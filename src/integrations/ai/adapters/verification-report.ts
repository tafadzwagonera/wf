import { execSync, spawn } from 'node:child_process';
import chalk from 'chalk';
import { executeWithCatch } from '../../../shared/utils/execute-with-catch';
import { signalProcessTree } from '../../../shared/utils/signal-process-tree';
import type { VerificationOutcome, VerificationScript } from '../../../shared/types/agent.types';

/**
 * Fills in 'skipped' entries for verification scripts that have no matching outcome.
 * Used by agent backends that track outcomes during the AI session.
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
  passed: chalk.green('✔'),
  failed: chalk.red('✖'),
  skipped: chalk.yellow('⏭'),
};

const SCRIPT_TIMEOUT_MS = 120_000;
const EARLY_EXIT_KILL_GRACE_MS = 500;

/**
 * Extracts stdout and stderr from an execSync error, capped at 4000 chars.
 *
 * @param error - The caught error from execSync.
 * @returns Combined stdout + stderr output string.
 */
const extractErrorOutput = (error: unknown): string => {
  const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr: unknown }).stderr) : '';
  const stdout = error instanceof Error && 'stdout' in error ? String((error as { stdout: unknown }).stdout) : '';
  return [stdout, stderr].filter(Boolean).join('\n').slice(0, 4000);
};

const CD_PREFIX_PATTERN = /^cd\s+(?:'[^']+'|"[^"]+"|\S+)\s*&&\s*(.+)$/;
const LEADING_BINARY_PATTERN = /^([\w./-]+)(?:\s|$)/;

const extractLeadingBinary = (command: string): string | null => {
  const trimmed = command.trim();
  const cdMatch = CD_PREFIX_PATTERN.exec(trimmed);
  const target = cdMatch ? cdMatch[1].trim() : trimmed;
  const binaryMatch = LEADING_BINARY_PATTERN.exec(target);
  return binaryMatch ? binaryMatch[1] : null;
};

const isBinaryAvailable = (binary: string): boolean => {
  const [, error] = executeWithCatch({
    fn: () => execSync(`command -v ${binary}`, { stdio: 'pipe' }),
    onError: (error: unknown) => error,
  });
  return !error;
};

const createSkippedOutcome = (script: VerificationScript, binary: string): VerificationOutcome => {
  console.log(chalk.yellow(`    ⏭ ${script.command}`));
  return {
    id: script.id,
    command: script.command,
    policy: script.policy,
    status: 'skipped',
    output: `${binary}: command not found`,
  };
};

const executeScriptAndCreateOutcome = (script: VerificationScript, repoDir: string): VerificationOutcome => {
  const [, error] = executeWithCatch({
    fn: () => execSync(script.command, { cwd: repoDir, stdio: 'pipe', timeout: SCRIPT_TIMEOUT_MS }),
    onError: (error: unknown) => error,
  });

  if (error) {
    console.log(chalk.red(`    ✖ ${script.command}`));
    return { id: script.id, command: script.command, policy: script.policy, status: 'failed', output: extractErrorOutput(error) };
  }

  console.log(chalk.green(`    ✔ ${script.command}`));
  return { id: script.id, command: script.command, policy: script.policy, status: 'passed' };
};

type EarlyExitScript = VerificationScript & { earlyExitPattern: string };

class EarlyExitRun {
  private readonly script: EarlyExitScript;
  private readonly timeoutMs: number;
  private readonly child: ReturnType<typeof spawn>;
  private readonly pattern: RegExp;
  private output = '';
  private matched = false;
  private settled = false;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private killGrace: ReturnType<typeof setTimeout> | undefined;

  constructor(
    script: EarlyExitScript,
    repoDir: string,
    timeoutMs: number,
  ) {
    this.script = script;
    this.timeoutMs = timeoutMs;
    this.child = spawn(script.command, {
      cwd: repoDir,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.pattern = new RegExp(script.earlyExitPattern ?? '');
  }

  run(): Promise<VerificationOutcome> {
    return new Promise(resolve => this.listen(resolve));
  }

  private listen(resolve: (outcome: VerificationOutcome) => void): void {
    this.timeout = setTimeout(() => this.fail(resolve, 'Verification check timed out'), this.timeoutMs);
    this.child.stdout?.on('data', this.appendOutput);
    this.child.stderr?.on('data', this.appendOutput);
    this.child.once('error', error => this.fail(resolve, `Verification spawn failed: ${error.message}`));
    this.child.once('close', code => this.close(resolve, code));
  }

  private appendOutput = (chunk: Buffer): void => {
    this.output = (this.output + chunk.toString()).slice(-4000);
    if (this.matched || !this.pattern.test(this.output)) return;
    this.matched = true;
    this.terminate();
  };

  private close(resolve: (outcome: VerificationOutcome) => void, code: number | null): void {
    if (this.settled) return;
    if (!this.matched) this.terminate();
    this.finish(resolve, this.matched ? 'passed' : 'failed', `Command exited before early-exit match (code ${code ?? 'unknown'})`);
  }

  private fail(resolve: (outcome: VerificationOutcome) => void, diagnostic: string): void {
    this.terminate();
    signalProcessTree(this.child, 'SIGKILL');
    this.finish(resolve, 'failed', diagnostic);
  }

  private terminate(): void {
    if (this.settled) return;
    signalProcessTree(this.child, 'SIGTERM');
    if (this.killGrace) return;
    this.killGrace = setTimeout(() => signalProcessTree(this.child, 'SIGKILL'), EARLY_EXIT_KILL_GRACE_MS);
  }

  private finish(resolve: (outcome: VerificationOutcome) => void, status: VerificationOutcome['status'], diagnostic: string): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.killGrace) clearTimeout(this.killGrace);
    console.log(status === 'passed' ? chalk.green(`    ✔ ${this.script.command}`) : chalk.red(`    ✖ ${this.script.command}`));
    resolve({ id: this.script.id, command: this.script.command, policy: this.script.policy, status, output: `${diagnostic}\n${this.output}`.slice(0, 4000) });
  }
}

export const runScriptWithEarlyExit = (
  script: EarlyExitScript, repoDir: string, timeoutMs = SCRIPT_TIMEOUT_MS,
): Promise<VerificationOutcome> => new EarlyExitRun(script, repoDir, timeoutMs).run();

const runSingleScript = async (script: VerificationScript, repoDir: string): Promise<VerificationOutcome> => {
  const binary = extractLeadingBinary(script.command);
  if (binary && !isBinaryAvailable(binary)) {
    return createSkippedOutcome(script, binary);
  }
  if (script.earlyExitPattern) {
    return runScriptWithEarlyExit({ ...script, earlyExitPattern: script.earlyExitPattern }, repoDir);
  }
  return executeScriptAndCreateOutcome(script, repoDir);
};

/**
 * Runs each configured verification script programmatically. Scripts with an
 * early-exit pattern pass once their output matches; other scripts run to completion.
 * Returns one outcome per script with the exact configured command.
 *
 * @param scripts - Configured verification scripts to execute.
 * @param repoDir - Working directory for command execution.
 * @returns One outcome per script, in order.
 */
export async function runProgrammaticVerification(
  scripts: VerificationScript[],
  repoDir: string,
): Promise<VerificationOutcome[]> {
  if (scripts.length === 0) return [];
  const outcomes: VerificationOutcome[] = [];
  for (const script of scripts) outcomes.push(await runSingleScript(script, repoDir));
  return outcomes;
}

/**
 * Prints a deterministic verification report to the console.
 * Each step is printed with a status icon: ✔ passed, ✖ failed, ⏭ skipped.
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

const COMMAND_FAILURE_PATTERNS = [
  /unrecognized option/i,
  /unknown option/i,
  /unrecognized CLI parameter/i,
  /was replaced by/i,
  /command not found/i,
  /no such file or directory/i,
  /not a valid option/i,
];

/**
 * Classifies a failed verification outcome as a command-level failure
 * (broken command that the AI cannot fix) or a code-level failure
 * (fixable by changing source code).
 *
 * @param outcome - A failed verification outcome with captured output.
 * @returns True if the failure is command-level (unfixable by AI).
 */
export function isCommandFailure(outcome: VerificationOutcome): boolean {
  const output = (outcome as { output?: string }).output ?? '';
  return COMMAND_FAILURE_PATTERNS.some(p => p.test(output));
}

/**
 * Splits enforced failures into code failures (fixable) and command failures (unfixable).
 *
 * @param failures - Enforced-failed outcomes.
 * @returns Partitioned failures.
 */
export function partitionFailures(
  failures: VerificationOutcome[],
): { codeFailures: VerificationOutcome[]; commandFailures: VerificationOutcome[] } {
  const codeFailures: VerificationOutcome[] = [];
  const commandFailures: VerificationOutcome[] = [];
  for (const f of failures) {
    const target = isCommandFailure(f) ? commandFailures : codeFailures;
    target.push(f);
  }
  return { codeFailures, commandFailures };
}

/**
 * Builds a prompt instructing the AI to fix enforced verification failures.
 * Includes truncated command output so the AI can diagnose root causes.
 *
 * @param failures - Enforced-failed outcomes with captured output. Must be non-empty.
 * @returns The prompt string for the fix pass, or empty string if failures is empty.
 */
const buildFailureSection = (f: VerificationOutcome): string => {
  const output = (f as { output?: string }).output ?? '';
  const truncated = output.length > 500 ? `...${output.slice(-500)}` : output;
  return `Command: ${f.command}\nOutput:\n${truncated || '(no output captured)'}`;
};

const buildScopeNote = (scopedFiles: string[]): string =>
  `\n\nOnly modify files within this task's scope:\n${scopedFiles.join('\n')}\n`
  + `If a failure above is not caused by one of these files, treat it as a pre-existing issue unrelated `
  + `to this task — report it in your summary as a blocker rather than fixing it, and do not edit files `
  + `outside this list to work around it.\n\n`;

export function buildVerificationFixPrompt(failures: VerificationOutcome[], scopedFiles?: string[]): string {
  if (failures.length === 0) return '';
  const sections = failures.map(buildFailureSection).join('\n\n');
  const scopeNote = scopedFiles?.length ? buildScopeNote(scopedFiles) : '';
  return (
    `The following enforced verification commands failed:\n\n${sections}\n\n`
    + `Read the error output above, identify the root cause of each failure, `
    + `and fix the code so all listed commands pass. `
    + scopeNote
    + `Do not re-run the verification commands yourself — they will be re-run automatically after your changes. `
    + `Do not output any text or plan before making your first tool call.`
  );
}

/**
 * Default stall threshold: number of consecutive non-improving passes before the loop stops.
 * Used by continuation loops and the verification stall check.
 */
export const DEFAULT_STALL_THRESHOLD = 2;

/**
 * Checks whether the verification failure count is decreasing.
 * Returns -1 to signal the loop should stop (stalled for `threshold` consecutive passes).
 *
 * @param currentFailures - Number of enforced failures in this pass.
 * @param previousFailures - Number of enforced failures in the prior pass.
 * @param stalledPasses - Running count of non-decreasing passes.
 * @param adapterLabel - Adapter label for log messages.
 * @param threshold - Number of consecutive non-improving passes before stopping (default: DEFAULT_STALL_THRESHOLD).
 * @returns Updated stalledPasses count, or -1 to signal the loop should break.
 */
export function checkVerificationStall(
  currentFailures: number,
  previousFailures: number,
  stalledPasses: number,
  adapterLabel: string,
  threshold = DEFAULT_STALL_THRESHOLD,
): number {
  const updated = currentFailures < previousFailures ? 0 : stalledPasses + 1;
  if (updated < threshold) return updated;
  console.log(chalk.yellow(
    `\n  [${adapterLabel}] Verification failures not decreasing after ${threshold} passes — stopping`,
  ));
  return -1;
}
