import * as fs from 'fs';
import type {
  ImplementBackendSelection,
  ImplementRunArtifact,
  VerificationAttemptArtifact,
  VerificationFailureClassification,
} from '../../agents/interfaces';
import type {
  ImplementVerificationRunFile,
  VerificationSignal,
  ImplementProgressVerdict,
  ImplementProgressSignal,
  ImplementProgressVerificationSnapshot,
  ImplementProgressMutation,
  ImplementProgressStreamEvent,
} from '../types/implement-verification.types';

export type {
  ImplementVerificationRunFile,
  ImplementProgressVerdict,
  ImplementProgressSignal,
  ImplementProgressVerificationSnapshot,
  ImplementProgressMutation,
  ImplementProgressStreamEvent,
};

const SYNTAX_ERROR_PATTERNS: Array<RegExp> = [
  /SyntaxError/i,
  /unterminated template literal/i,
  /['"`}] expected/i,
  /unexpected token/i,
];

const LINT_ERROR_PATTERNS: Array<RegExp> = [/eslint/i, /no-unused-vars/i, /prettier/i, /code style/i, /lint/i];

const TYPECHECK_ERROR_PATTERNS: Array<RegExp> = [
  /\bTS\d{4}\b/i,
  /cannot find name/i,
  /property .* does not exist on type/i,
  /type .* is not assignable to type/i,
];

const TEST_RUNTIME_PATTERNS: Array<RegExp> = [
  /\bexpect\(/i,
  /\breceived\b/i,
  /\bexpected\b/i,
  /\bassert(ion)? failed\b/i,
];

const DIAGNOSTIC_FILE_PATTERN =
  /(?:[A-Za-z]:)?(?:\.{0,2}\/)?[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|txt)/g;
const ERROR_CLASS_SEVERITY: Record<string, number> = {
  syntax: 6,
  module: 5,
  reference: 5,
  type: 4,
  test: 3,
  generic: 3,
  lint: 2,
  format: 1,
};

/**
 * Classify a verification failure using command identity and deterministic
 * output patterns.
 *
 * @param params - Verification command and captured output
 * @returns A structured classification for retry scope and observability
 */
export const classifyVerificationFailure = (params: {
  command: string;
  stdout: string;
  stderr: string;
}): VerificationFailureClassification => {
  const output = `${params.stdout}\n${params.stderr}`.trim();
  const implicatedFiles = extractDiagnosticFiles(output);
  const signal = detectVerificationSignal(params.command, output);

  return {
    category: signal.category,
    implicatedFiles,
    companionFiles: [],
    rootSignal: signal.rootSignal,
    strategy: signal.strategy,
    confidence: signal.confidence,
  };
};

/**
 * Convert backend-selection details into a single terminal line.
 *
 * @param selection - Backend selection state
 * @returns Human-readable backend selection summary
 */
export const formatBackendSelection = (selection: ImplementBackendSelection): string =>
  `Implement backend: ${selection.selected} (provider: ${selection.provider})`;

/**
 * Append a verification attempt to the persisted run file.
 *
 * @param filePath - Absolute path of the persisted run file
 * @param attempt - Structured attempt summary to append
 * @returns The updated run file contents
 */
export const appendImplementVerificationAttempt = (
  filePath: string,
  attempt: VerificationAttemptArtifact
): ImplementVerificationRunFile => {
  const existing = readImplementVerificationRunFile(filePath);
  const updated: ImplementVerificationRunFile = {
    ...existing,
    attempts: [...existing.attempts, attempt],
  };

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
};

/**
 * Write a fresh verification run file.
 *
 * @param filePath - Absolute path of the persisted run file
 * @param run - Run metadata to persist
 * @returns The persisted run file contents
 */
export const writeImplementVerificationRunFile = (
  filePath: string,
  run: ImplementRunArtifact
): ImplementVerificationRunFile => {
  const payload: ImplementVerificationRunFile = {
    run,
    attempts: [],
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
};

/**
 * Read the existing verification run file or create an empty container.
 *
 * @param filePath - Absolute path of the persisted run file
 * @returns The existing or default run file contents
 */
export const readImplementVerificationRunFile = (filePath: string): ImplementVerificationRunFile => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Verification run file not found: ${filePath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<ImplementVerificationRunFile>;
  if (!parsed.run || !Array.isArray(parsed.attempts)) {
    throw new Error(`Verification run file is invalid: ${filePath}`);
  }

  return {
    run: parsed.run,
    attempts: parsed.attempts,
  };
};

/**
 * Build a stable command-to-index lookup for the configured verification scripts.
 *
 * @param verificationScripts - Ordered verification scripts from the plan
 * @returns Map from exact command string to its verification index
 */
export const buildVerificationCommandOrder = (verificationScripts: Array<{ command: string }>): Map<string, number> =>
  new Map(verificationScripts.map((script, index) => [script.command.trim(), index]));

/**
 * Build a progress signal for file mutations before the next verification run.
 *
 * @param mutation - The file mutation details since the last verification
 * @returns A heuristic progress signal that favors continuing the current pass
 */
export const buildMutationProgressSignal = (mutation: ImplementProgressMutation): ImplementProgressSignal => {
  const changedFileCount = mutation.changedFilesSinceLastVerification.length;

  return {
    score: Math.min(5, 3 + changedFileCount),
    verdict: 'continue',
    reasons: [
      `${mutation.change} ${mutation.path}`,
      `${changedFileCount} file(s) changed since the last verification run`,
    ],
    nextAction: 'Batch related edits, then rerun verification.',
  };
};

/**
 * Build a progress signal from a verification command result.
 *
 * @param params - Latest verification result plus previous state
 * @returns A bounded heuristic signal that favors convergence when failures shrink
 */
export const buildVerificationProgressSignal = (params: {
  currentSnapshot: ImplementProgressVerificationSnapshot;
  previousSnapshot?: ImplementProgressVerificationSnapshot;
  changedFilesSinceLastVerification: string[];
}): ImplementProgressSignal => {
  if (params.currentSnapshot.exitCode === 0) {
    return {
      score: 10,
      verdict: 'complete',
      reasons: ['verification passed'],
      nextAction: 'Stop and summarize the finished changes.',
    };
  }

  const reasons: string[] = [];
  let score = 0;

  if (params.changedFilesSinceLastVerification.length > 0) {
    score += Math.min(5, 3 + params.changedFilesSinceLastVerification.length);
    reasons.push(`recent file changes: ${params.changedFilesSinceLastVerification.join(', ')}`);
  }

  const previousSnapshot = params.previousSnapshot;
  if (!previousSnapshot) {
    score += 1;
    reasons.push('first failed verification snapshot');
  } else {
    const stageAdvanced = params.currentSnapshot.commandIndex > previousSnapshot.commandIndex;
    const stageRegressed = params.currentSnapshot.commandIndex < previousSnapshot.commandIndex;
    const diagnosticLinesReduced = params.currentSnapshot.diagnosticLineCount < previousSnapshot.diagnosticLineCount;
    const diagnosticLinesIncreased = params.currentSnapshot.diagnosticLineCount > previousSnapshot.diagnosticLineCount;
    const previousErrorClasses = previousSnapshot.errorClasses;
    const currentErrorClasses = params.currentSnapshot.errorClasses;
    const resolvedErrorClasses = [...previousErrorClasses].filter(errorClass => !currentErrorClasses.has(errorClass));
    const introducedErrorClasses = [...currentErrorClasses].filter(errorClass => !previousErrorClasses.has(errorClass));
    const previousSeverity = getHighestErrorSeverity(previousErrorClasses);
    const currentSeverity = getHighestErrorSeverity(currentErrorClasses);
    const severityImproved = currentSeverity < previousSeverity;
    const repeatedFailurePattern =
      params.changedFilesSinceLastVerification.length === 0 &&
      params.currentSnapshot.commandIndex === previousSnapshot.commandIndex &&
      currentSeverity >= previousSeverity &&
      params.currentSnapshot.diagnosticLineCount >= previousSnapshot.diagnosticLineCount;

    if (stageAdvanced) {
      score += 3;
      reasons.push('verification advanced to a later command');
    }

    if (stageRegressed) {
      score -= 3;
      reasons.push('verification regressed to an earlier command');
    }

    if (diagnosticLinesReduced) {
      score += 2;
      reasons.push('diagnostic output shrank');
    }

    if (diagnosticLinesIncreased) {
      score -= 1;
      reasons.push('diagnostic output grew');
    }

    if (resolvedErrorClasses.length > 0) {
      score += 2;
      reasons.push(`resolved error classes: ${resolvedErrorClasses.join(', ')}`);
    }

    if (introducedErrorClasses.length > resolvedErrorClasses.length) {
      score -= 1;
      reasons.push(`introduced error classes: ${introducedErrorClasses.join(', ')}`);
    }

    if (severityImproved) {
      score += 2;
      reasons.push('highest-severity diagnostics decreased');
    }

    if (repeatedFailurePattern) {
      score -= 3;
      reasons.push('same failure pattern repeated without new edits');
    }
  }

  score = Math.max(0, Math.min(10, score));

  const verdict: ImplementProgressVerdict = score >= 5 ? 'continue' : score >= 2 ? 'revisit' : 'regress';

  return {
    score,
    verdict,
    reasons: reasons.length > 0 ? reasons : ['no meaningful convergence signal'],
    nextAction:
      verdict === 'continue'
        ? 'Keep editing the most recently changed files and rerun verification.'
        : verdict === 'revisit'
          ? 'Narrow the next pass to the latest changed files before verifying again.'
          : 'Inspect the latest verification failure before broadening scope.',
  };
};

/**
 * Count non-empty diagnostic lines from stdout and stderr.
 *
 * @param stdout - Verification stdout
 * @param stderr - Verification stderr
 * @returns Count of non-empty diagnostic lines
 */
export const countDiagnosticLines = (stdout?: string, stderr?: string): number => {
  const diagnosticText = [stdout, stderr].filter(Boolean).join('\n');
  if (!diagnosticText.trim()) {
    return 0;
  }

  return diagnosticText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean).length;
};

/**
 * Extract coarse error classes from verification output.
 *
 * @param stdout - Verification stdout
 * @param stderr - Verification stderr
 * @returns Set of detected error classes
 */
export const extractVerificationErrorClasses = (stdout?: string, stderr?: string): Set<string> => {
  const errorClasses = new Set<string>();
  const diagnosticText = [stdout, stderr].filter(Boolean).join('\n').toLowerCase();

  if (/prettier|format|code style/.test(diagnosticText)) {
    errorClasses.add('format');
  }
  if (/eslint|lint|no-[a-z-]+/.test(diagnosticText)) {
    errorClasses.add('lint');
  }
  if (/syntaxerror|parsing error|unexpected token|ts1005/.test(diagnosticText)) {
    errorClasses.add('syntax');
  }
  if (/typeerror|type .* assignable|ts2322|ts2345|ts2741|ts2769/.test(diagnosticText)) {
    errorClasses.add('type');
  }
  if (/referenceerror|cannot find name|not defined|ts2304/.test(diagnosticText)) {
    errorClasses.add('reference');
  }
  if (/cannot find module|module not found|ts2307/.test(diagnosticText)) {
    errorClasses.add('module');
  }
  if (/fail\s|expected:|received:|expect\(|assertion/.test(diagnosticText)) {
    errorClasses.add('test');
  }

  if (errorClasses.size === 0 && diagnosticText.trim()) {
    errorClasses.add('generic');
  }

  return errorClasses;
};

/**
 * Build a progress signal from a streamed SDK event.
 *
 * @param event - A task or tool progress event from an agent SDK
 * @returns A heuristic signal for terminal output and prompt feedback
 */
export const buildStreamProgressSignal = (event: ImplementProgressStreamEvent): ImplementProgressSignal => {
  if (event.kind === 'task_progress') {
    const reasons = [event.summary?.trim() || 'task progress reported'];
    if (event.lastToolName) {
      reasons.push(`last tool: ${event.lastToolName}`);
    }

    return {
      score: 4,
      verdict: 'continue',
      reasons,
      nextAction: 'Keep the current pass focused and continue editing.',
    };
  }

  const reasons = [event.toolName ? `tool progress: ${event.toolName}` : 'tool progress'];
  if (typeof event.elapsedTimeSeconds === 'number') {
    reasons.push(`elapsed: ${event.elapsedTimeSeconds.toFixed(1)}s`);
  }
  if (event.taskId) {
    reasons.push(`task: ${event.taskId}`);
  }

  return {
    score: 3,
    verdict: 'continue',
    reasons,
    nextAction: 'Continue the current pass and verify once the edit settles.',
  };
};

/**
 * Format a progress signal for compact terminal output.
 *
 * @param signal - The progress signal to render
 * @returns A short human-readable summary line
 */
export const formatImplementProgressSignal = (signal: ImplementProgressSignal): string => {
  const reasons = signal.reasons.join('; ');
  return `progress: ${signal.verdict} (score ${signal.score})${reasons ? ` · ${reasons}` : ''}`;
};

const detectVerificationSignal = (command: string, output: string): VerificationSignal => {
  const lowerCommand = command.toLowerCase();
  if (matchesAny(output, SYNTAX_ERROR_PATTERNS)) {
    return {
      category: 'parse',
      rootSignal: 'syntax-error',
      strategy: 'surgical',
      confidence: 'high',
    };
  }

  if (matchesAny(output, LINT_ERROR_PATTERNS) || lowerCommand.includes('lint')) {
    return {
      category: 'lint',
      rootSignal: 'lint-diagnostic',
      strategy: 'surgical',
      confidence: 'high',
    };
  }

  if (matchesAny(output, TYPECHECK_ERROR_PATTERNS) || lowerCommand.includes('typecheck')) {
    return {
      category: 'typecheck',
      rootSignal: 'type-diagnostic',
      strategy: 'paired-files',
      confidence: 'high',
    };
  }

  if (lowerCommand.includes('build')) {
    return {
      category: 'build',
      rootSignal: 'build-command',
      strategy: 'broad-context',
      confidence: 'medium',
    };
  }

  if (matchesAny(output, TEST_RUNTIME_PATTERNS) || lowerCommand.includes('test')) {
    return {
      category: 'test-runtime',
      rootSignal: 'test-diagnostic',
      strategy: 'paired-files',
      confidence: 'medium',
    };
  }

  return {
    category: 'unknown',
    rootSignal: 'unclassified',
    strategy: 'broad-context',
    confidence: 'low',
  };
};

const extractDiagnosticFiles = (output: string): string[] => {
  const matches = output.match(DIAGNOSTIC_FILE_PATTERN);
  if (!matches) {
    return [];
  }

  return [...new Set(matches.map(match => match.replace(/:\d+$/, '')))];
};

const matchesAny = (value: string, patterns: RegExp[]): boolean => patterns.some(pattern => pattern.test(value));

const getHighestErrorSeverity = (errorClasses: Set<string>): number =>
  [...errorClasses].reduce(
    (highestSeverity, errorClass) => Math.max(highestSeverity, ERROR_CLASS_SEVERITY[errorClass] ?? 0),
    0
  );
