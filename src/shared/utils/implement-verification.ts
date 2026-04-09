import * as fs from 'fs';
import type {
  ImplementBackendSelection,
  ImplementRunArtifact,
  RetryScopeStrategy,
  VerificationAttemptArtifact,
  VerificationFailureCategory,
  VerificationFailureClassification,
} from '../../agents/interfaces';

export interface ImplementVerificationRunFile {
  run: ImplementRunArtifact;
  attempts: VerificationAttemptArtifact[];
}

interface VerificationSignal {
  category: VerificationFailureCategory;
  rootSignal: string;
  strategy: RetryScopeStrategy;
  confidence: 'high' | 'medium' | 'low';
}

const SYNTAX_ERROR_PATTERNS: Array<RegExp> = [
  /SyntaxError/i,
  /unterminated template literal/i,
  /['"`}] expected/i,
  /unexpected token/i,
];

const LINT_ERROR_PATTERNS: Array<RegExp> = [
  /eslint/i,
  /no-unused-vars/i,
  /prettier/i,
  /code style/i,
  /lint/i,
];

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
export const formatBackendSelection = (
  selection: ImplementBackendSelection,
): string => {
  const fallbackSuffix = selection.fallbackReason
    ? `, reason: ${selection.fallbackReason}`
    : '';

  return `Implement backend: ${selection.selected} (configured: ${selection.configured}, provider: ${selection.provider}${fallbackSuffix})`;
};

/**
 * Append a verification attempt to the persisted run file.
 *
 * @param filePath - Absolute path of the persisted run file
 * @param attempt - Structured attempt summary to append
 * @returns The updated run file contents
 */
export const appendImplementVerificationAttempt = (
  filePath: string,
  attempt: VerificationAttemptArtifact,
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
  run: ImplementRunArtifact,
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
export const readImplementVerificationRunFile = (
  filePath: string,
): ImplementVerificationRunFile => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Verification run file not found: ${filePath}`);
  }

  const parsed = JSON.parse(
    fs.readFileSync(filePath, 'utf-8'),
  ) as Partial<ImplementVerificationRunFile>;
  if (!parsed.run || !Array.isArray(parsed.attempts)) {
    throw new Error(`Verification run file is invalid: ${filePath}`);
  }

  return {
    run: parsed.run,
    attempts: parsed.attempts,
  };
};

const detectVerificationSignal = (
  command: string,
  output: string,
): VerificationSignal => {
  const lowerCommand = command.toLowerCase();
  if (matchesAny(output, SYNTAX_ERROR_PATTERNS)) {
    return {
      category: 'parse',
      rootSignal: 'syntax-error',
      strategy: 'surgical',
      confidence: 'high',
    };
  }

  if (
    matchesAny(output, LINT_ERROR_PATTERNS) ||
    lowerCommand.includes('lint')
  ) {
    return {
      category: 'lint',
      rootSignal: 'lint-diagnostic',
      strategy: 'surgical',
      confidence: 'high',
    };
  }

  if (
    matchesAny(output, TYPECHECK_ERROR_PATTERNS) ||
    lowerCommand.includes('typecheck')
  ) {
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

  if (
    matchesAny(output, TEST_RUNTIME_PATTERNS) ||
    lowerCommand.includes('test')
  ) {
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

  return [...new Set(matches.map((match) => match.replace(/:\d+$/, '')))];
};

const matchesAny = (value: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(value));
