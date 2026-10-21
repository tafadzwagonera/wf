import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { ValidationError } from '../errors/app.error';
import { getWfStateDir } from './wf-paths';
import type {
  ImplementBackendSelection,
  ImplementRunArtifact,
  PlanProblem,
  VerificationAttemptArtifact,
  VerificationFailureClassification,
} from '../types/agent.types';
import type { DesignConformanceFinding } from '../types/design-conformance.types';
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
} from '../types/implement-verification.types';

const syntaxErrorPatterns: Array<RegExp> = [
  /SyntaxError/i,
  /unterminated template literal/i,
  /['"`}] expected/i,
  /unexpected token/i,
];

const lintErrorPatterns: Array<RegExp> = [/eslint/i, /no-unused-vars/i, /prettier/i, /code style/i, /lint/i];

const typecheckErrorPatterns: Array<RegExp> = [
  /\bTS\d{4}\b/i,
  /cannot find name/i,
  /property .* does not exist on type/i,
  /type .* is not assignable to type/i,
];

const testRuntimePatterns: Array<RegExp> = [
  /\bexpect\(/i,
  /\breceived\b/i,
  /\bexpected\b/i,
  /\bassert(ion)? failed\b/i,
];

const DIAGNOSTIC_FILE_PATTERN
  = /(?:[A-Za-z]:)?(?:\.{0,2}\/)?[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|txt)/g;
const errorClassSeverity: Record<string, number> = {
  syntax: 6,
  module: 5,
  reference: 5,
  type: 4,
  test: 3,
  generic: 3,
  lint: 2,
  format: 1,
};

interface ClassifyVerificationFailureParams {
  command: string;
  stdout: string;
  stderr: string;
}

export const classifyVerificationFailure = (
  params: ClassifyVerificationFailureParams
): VerificationFailureClassification => {
  const output = `${params.stdout}\n${params.stderr}`.trim();
  const signal = detectVerificationSignal(params.command, output);
  return {
    category: signal.category,
    implicatedFiles: extractDiagnosticFiles(output),
    companionFiles: [],
    rootSignal: signal.rootSignal,
    strategy: signal.strategy,
    confidence: signal.confidence,
  };
};

export const formatBackendSelection = (selection: ImplementBackendSelection): string =>
  `Implement backend: ${selection.selected} (provider: ${selection.provider})`;

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

export const appendPlanProblemsToRunFile = (
  filePath: string,
  planProblems: PlanProblem[]
): ImplementVerificationRunFile => {
  const existing = readImplementVerificationRunFile(filePath);
  const updated: ImplementVerificationRunFile = {
    ...existing,
    run: planProblems.length > 0 ? { ...existing.run, planProblems } : existing.run,
  };

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
};

export const appendDesignConformanceToRunFile = (
  filePath: string,
  designConformance: DesignConformanceFinding[]
): ImplementVerificationRunFile => {
  const existing = readImplementVerificationRunFile(filePath);
  const updated: ImplementVerificationRunFile = {
    ...existing,
    run: designConformance.length > 0 ? { ...existing.run, designConformance } : existing.run,
  };

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
};

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

export const readImplementVerificationRunFile = (filePath: string): ImplementVerificationRunFile => {
  if (!fs.existsSync(filePath)) {
    throw new ValidationError(`Verification run file not found: ${filePath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<ImplementVerificationRunFile>;
  if (!parsed.run || !Array.isArray(parsed.attempts)) {
    throw new ValidationError(`Verification run file is invalid: ${filePath}`);
  }

  return {
    run: parsed.run,
    attempts: parsed.attempts,
  };
};

export const buildVerificationCommandOrder = (verificationScripts: Array<{ command: string }>): Map<string, number> =>
  new Map(verificationScripts.map((script, index) => [script.command.trim(), index]));

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

interface ProgressSignalParams {
  currentSnapshot: ImplementProgressVerificationSnapshot;
  previousSnapshot?: ImplementProgressVerificationSnapshot;
  changedFilesSinceLastVerification: string[];
}

const verificationCompleteSignal: ImplementProgressSignal = {
  score: 10,
  verdict: 'complete',
  reasons: ['verification passed'],
  nextAction: 'Stop and summarize the finished changes.',
};

interface SnapshotFlag {
  active: boolean;
  delta: number;
  reason: string;
}

const buildCommandStageFlags = (
  current: ImplementProgressVerificationSnapshot,
  previous: ImplementProgressVerificationSnapshot
): SnapshotFlag[] => [
  { active: current.commandIndex > previous.commandIndex, delta: 3, reason: 'verification advanced to a later command' },
  { active: current.commandIndex < previous.commandIndex, delta: -3, reason: 'verification regressed to an earlier command' },
  { active: current.diagnosticLineCount < previous.diagnosticLineCount, delta: 2, reason: 'diagnostic output shrank' },
  { active: current.diagnosticLineCount > previous.diagnosticLineCount, delta: -1, reason: 'diagnostic output grew' },
];

const buildErrorClassFlags = (
  current: ImplementProgressVerificationSnapshot,
  previous: ImplementProgressVerificationSnapshot
): SnapshotFlag[] => {
  const resolved = [...previous.errorClasses].filter(c => !current.errorClasses.has(c));
  const introduced = [...current.errorClasses].filter(c => !previous.errorClasses.has(c));
  const previousSeverity = getHighestErrorSeverity(previous.errorClasses);
  const currentSeverity = getHighestErrorSeverity(current.errorClasses);
  return [
    { active: resolved.length > 0, delta: 2, reason: `resolved error classes: ${resolved.join(', ')}` },
    { active: introduced.length > resolved.length, delta: -1, reason: `introduced error classes: ${introduced.join(', ')}` },
    { active: currentSeverity < previousSeverity, delta: 2, reason: 'highest-severity diagnostics decreased' },
  ];
};

const isRepeatedFailure = (
  current: ImplementProgressVerificationSnapshot,
  previous: ImplementProgressVerificationSnapshot,
  changedFileCount: number
): boolean =>
  changedFileCount === 0
  && current.commandIndex === previous.commandIndex
  && getHighestErrorSeverity(current.errorClasses) >= getHighestErrorSeverity(previous.errorClasses)
  && current.diagnosticLineCount >= previous.diagnosticLineCount;

const buildSnapshotFlags = (
  current: ImplementProgressVerificationSnapshot,
  previous: ImplementProgressVerificationSnapshot,
  changedFileCount: number
): SnapshotFlag[] => [
  ...buildCommandStageFlags(current, previous),
  ...buildErrorClassFlags(current, previous),
  { active: isRepeatedFailure(current, previous, changedFileCount), delta: -3, reason: 'same failure pattern repeated without new edits' },
];

const compareSnapshots = (
  current: ImplementProgressVerificationSnapshot,
  previous: ImplementProgressVerificationSnapshot,
  changedFileCount: number
): { scoreDelta: number; reasons: string[] } => {
  const flags = buildSnapshotFlags(current, previous, changedFileCount).filter(flag => flag.active);
  return { scoreDelta: flags.reduce((sum, flag) => sum + flag.delta, 0), reasons: flags.map(flag => flag.reason) };
};

const computeProgressScore = (params: ProgressSignalParams): { score: number; reasons: string[] } => {
  const changedFileCount = params.changedFilesSinceLastVerification.length;
  const filesReason = changedFileCount > 0 ? `recent file changes: ${params.changedFilesSinceLastVerification.join(', ')}` : '';
  const filesDelta = changedFileCount > 0 ? Math.min(5, 3 + changedFileCount) : 0;

  const snapshotResult = params.previousSnapshot
    ? compareSnapshots(params.currentSnapshot, params.previousSnapshot, changedFileCount)
    : { scoreDelta: 1, reasons: ['first failed verification snapshot'] };

  const reasons = [filesReason, ...snapshotResult.reasons].filter(Boolean);
  return { score: Math.max(0, Math.min(10, filesDelta + snapshotResult.scoreDelta)), reasons };
};

const resolveProgressVerdict = (score: number): ImplementProgressVerdict => {
  if (score >= 5) return 'continue';
  if (score >= 2) return 'revisit';
  return 'regress';
};

const progressNextActions: Record<ImplementProgressVerdict, string> = {
  complete: 'Stop and summarize the finished changes.',
  continue: 'Keep editing the most recently changed files and rerun verification.',
  revisit: 'Narrow the next pass to the latest changed files before verifying again.',
  regress: 'Inspect the latest verification failure before broadening scope.',
};

export const buildVerificationProgressSignal = (params: ProgressSignalParams): ImplementProgressSignal => {
  if (params.currentSnapshot.exitCode === 0) return verificationCompleteSignal;

  const { score, reasons } = computeProgressScore(params);
  const verdict = resolveProgressVerdict(score);

  return {
    score,
    verdict,
    reasons: reasons.length > 0 ? reasons : ['no meaningful convergence signal'],
    nextAction: progressNextActions[verdict],
  };
};

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

const errorClassPatterns: Array<[string, RegExp]> = [
  ['format', /prettier|format|code style/],
  ['lint', /eslint|lint|no-[a-z-]+/],
  ['syntax', /syntaxerror|parsing error|unexpected token|ts1005/],
  ['type', /typeerror|type .* assignable|ts2322|ts2345|ts2741|ts2769/],
  ['reference', /referenceerror|cannot find name|not defined|ts2304/],
  ['module', /cannot find module|module not found|ts2307/],
  ['test', /fail\s|expected:|received:|expect\(|assertion/],
];

export const extractVerificationErrorClasses = (stdout?: string, stderr?: string): Set<string> => {
  const diagnosticText = [stdout, stderr].filter(Boolean).join('\n').toLowerCase();
  const errorClasses = new Set(
    errorClassPatterns.filter(([, pattern]) => pattern.test(diagnosticText)).map(([errorClass]) => errorClass)
  );

  if (errorClasses.size === 0 && diagnosticText.trim()) {
    errorClasses.add('generic');
  }

  return errorClasses;
};

const buildTaskProgressSignal = (event: ImplementProgressStreamEvent): ImplementProgressSignal => {
  const reasons = [event.summary?.trim() || 'task progress reported'];
  if (event.lastToolName) reasons.push(`last tool: ${event.lastToolName}`);
  return { score: 4, verdict: 'continue', reasons, nextAction: 'Keep the current pass focused and continue editing.' };
};

const buildToolProgressSignal = (event: ImplementProgressStreamEvent): ImplementProgressSignal => {
  const reasons = [event.toolName ? `tool progress: ${event.toolName}` : 'tool progress'];
  if (typeof event.elapsedTimeSeconds === 'number') reasons.push(`elapsed: ${event.elapsedTimeSeconds.toFixed(1)}s`);
  if (event.taskId) reasons.push(`task: ${event.taskId}`);
  return { score: 3, verdict: 'continue', reasons, nextAction: 'Continue the current pass and verify once the edit settles.' };
};

export const buildStreamProgressSignal = (event: ImplementProgressStreamEvent): ImplementProgressSignal => {
  if (event.kind === 'task_progress') return buildTaskProgressSignal(event);
  return buildToolProgressSignal(event);
};

export const formatImplementProgressSignal = (signal: ImplementProgressSignal): string => {
  const reasons = signal.reasons.join('; ');
  const suffix = reasons ? ` · ${reasons}` : '';
  return `progress: ${signal.verdict} (score ${signal.score})${suffix}`;
};

const verificationSignalRules: Array<{
  matches: (lowerCommand: string, output: string) => boolean;
  signal: VerificationSignal;
}> = [
  {
    matches: (_lowerCommand, output) => matchesAny(output, syntaxErrorPatterns),
    signal: { category: 'parse', rootSignal: 'syntax-error', strategy: 'surgical', confidence: 'high' },
  },
  {
    matches: (lowerCommand, output) => matchesAny(output, lintErrorPatterns) || lowerCommand.includes('lint'),
    signal: { category: 'lint', rootSignal: 'lint-diagnostic', strategy: 'surgical', confidence: 'high' },
  },
  {
    matches: (lowerCommand, output) => matchesAny(output, typecheckErrorPatterns) || lowerCommand.includes('typecheck'),
    signal: { category: 'typecheck', rootSignal: 'type-diagnostic', strategy: 'paired-files', confidence: 'high' },
  },
  {
    matches: lowerCommand => lowerCommand.includes('build'),
    signal: { category: 'build', rootSignal: 'build-command', strategy: 'broad-context', confidence: 'medium' },
  },
  {
    matches: (lowerCommand, output) => matchesAny(output, testRuntimePatterns) || lowerCommand.includes('test'),
    signal: { category: 'test-runtime', rootSignal: 'test-diagnostic', strategy: 'paired-files', confidence: 'medium' },
  },
];

const unknownVerificationSignal: VerificationSignal = {
  category: 'unknown',
  rootSignal: 'unclassified',
  strategy: 'broad-context',
  confidence: 'low',
};

const detectVerificationSignal = (command: string, output: string): VerificationSignal => {
  const lowerCommand = command.toLowerCase();
  const rule = verificationSignalRules.find(candidate => candidate.matches(lowerCommand, output));
  return rule?.signal ?? unknownVerificationSignal;
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
    (highestSeverity, errorClass) => Math.max(highestSeverity, errorClassSeverity[errorClass] ?? 0),
    0
  );

const findLatestCachedVerificationFile = (repoDir: string, ticketKey: string): string | null => {
  const dir = path.join(getWfStateDir(), 'implement-verification', path.basename(repoDir));
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter((f): f is string => f.startsWith(`${ticketKey}-`) && f.endsWith('.json'))
    .map(f => ({ filePath: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0].filePath : null;
};

const PLAN_PROBLEM_HEADER
  = 'Implementer plan-problem reports (the plan step was reported as wrong; judge whether the alternative is sound):';

const formatPlanProblemLines = (planProblems: PlanProblem[] | undefined): string => {
  if (!planProblems?.length) return '';
  const lines = planProblems.map(problem => `- step ${problem.step}: ${problem.reason} | instead: ${problem.instead}`);
  return `\n${PLAN_PROBLEM_HEADER}\n${lines.join('\n')}`;
};

const formatAttemptsSummary = (file: ImplementVerificationRunFile): string => {
  const { run, attempts } = file;
  const prefix = `Prior implement run (ticket ${run.ticketKey}):`;
  if (attempts.length === 0) return `${prefix} no verification attempts recorded.`;

  const [last] = attempts.slice(-1);
  const status = last.failed ? `failed (exit ${last.exitCode})` : `passed (exit ${last.exitCode})`;
  return `${prefix} ${attempts.length} attempt(s). Last attempt [${last.command}]: ${status}.`;
};

const formatCachedVerificationSummary = (file: ImplementVerificationRunFile): string =>
  `${formatAttemptsSummary(file)}${formatPlanProblemLines(file.run.planProblems)}`;

const generateFallbackVerificationSummary = (repoDir: string): string => {
  try {
    const stat = execSync('git diff --stat HEAD', {
      cwd: repoDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stat.trim() ? `Current diff stat:\n${stat.trim()}` : '';
  } catch {
    return '';
  }
};

/**
 * Resolves prior-implement-run context for the review prompt.
 *
 * Reads the newest cached implement verification run for the ticket, falling back to a live
 * `git diff --stat HEAD` when no cache is available. Never throws — returns '' when neither
 * a cached run nor a diff is available.
 */
export const resolveVerificationSummary = (repoDir: string, ticketKey: string): string => {
  const cachedPath = findLatestCachedVerificationFile(repoDir, ticketKey);
  if (cachedPath) {
    try {
      return formatCachedVerificationSummary(readImplementVerificationRunFile(cachedPath));
    } catch {
      // fall through to the git diff fallback
    }
  }
  return generateFallbackVerificationSummary(repoDir);
};
