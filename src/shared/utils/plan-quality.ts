import type { ResolutionPlan } from '../types/ai.types';
import type { NodeInfra, TestInfraContext } from '../types/detection.types';
import { ValidationError } from '../errors/app.error';
import type { SkillQualityRule } from '../../skills/skill.types';

export interface PlanQualityViolation {
  ruleId: string;
  message: string;
}

interface ValidatePlanQualityParams {
  plan: Partial<ResolutionPlan>;
  affectedRepositories?: string[];
  testInfra?: TestInfraContext;
  skillRules?: SkillQualityRule[];
}

const PACKAGE_MANAGER_COMMAND_PATTERN = /^(?:yarn|npm run|pnpm|pnpm run|npx|nr)\s+([^\s]+)/;
const RENAME_STEP_PATTERN = /\b(rename|move|refactor)\b/i;
const INLINE_COMMAND_PATTERN = /^(node -e|sh -c|bash -c)\s/;
const PYTHON_COMMAND_PATTERN = /^(pytest|python -m pytest)\b/;
const GO_COMMAND_PATTERN = /^go (test|vet)\b/;
const TERRAFORM_COMMAND_PATTERN = /^terraform (validate|plan|fmt)\b/;
const REPO_LOCAL_CD_PREFIX_PATTERN = /^cd\s+(.+?)\s*&&\s*(.+)$/;
const QUOTED_OR_BARE_VALUE = /(?:`[^`]+`|'[^']+'|"[^"]+"|[\w./-]+)/;
const EXPLICIT_REPLACEMENT_TARGET_PATTERN
  = new RegExp(`\\b(?:rename|move|refactor)\\b[\\s\\S]{0,240}\\b(?:to|into)\\s+${QUOTED_OR_BARE_VALUE.source}`, 'i');
const NAMED_REPLACEMENT_TARGET_PATTERN
  = new RegExp(`\\b(?:new name|new path)\\b\\s*(?::|=|\\bis\\b)?\\s*${QUOTED_OR_BARE_VALUE.source}`, 'i');

const createViolation = (ruleId: PlanQualityViolation['ruleId'], message: string): PlanQualityViolation => ({
  ruleId,
  message,
});

const hasExplicitReplacementTarget = (step: string): boolean => {
  const normalizedStep = step.replaceAll(/\s+/g, ' ').trim();
  return (
    EXPLICIT_REPLACEMENT_TARGET_PATTERN.test(normalizedStep) || NAMED_REPLACEMENT_TARGET_PATTERN.test(normalizedStep)
  );
};

const normalizeRepoLocalVerificationCommand = (command: string, affectedRepositories?: string[]): string => {
  const trimmed = command.trim();
  const cdPrefixMatch = REPO_LOCAL_CD_PREFIX_PATTERN.exec(trimmed);
  if (!cdPrefixMatch) {
    return trimmed;
  }

  const [, rawTarget, remainder] = cdPrefixMatch;
  const target = rawTarget.trim().replaceAll(/(^['"])|(['"]$)/g, '');
  const repoNames = affectedRepositories?.map(repo => repo.trim()).filter(Boolean) ?? [];
  const isRepoLocalTarget = repoNames.some(repo => target === repo || target === `./${repo}`);

  if (isRepoLocalTarget) {
    return remainder.trim();
  }

  return trimmed;
};

// eslint-disable-next-line max-lines-per-function
const detectRenameViolations = (steps: string[]): PlanQualityViolation[] => {
  const violations: PlanQualityViolation[] = [];

  for (const [index, step] of steps.entries()) {
    if (!RENAME_STEP_PATTERN.test(step)) {
      continue;
    }

    if (hasExplicitReplacementTarget(step)) {
      continue;
    }

    violations.push(
      createViolation(
        'rename-target-required',
        `Step ${index + 1} must state the replacement target explicitly: ${step}`
      )
    );
  }

  return violations;
};

const isNodeVerificationAllowed = (command: string, nodeInfra: NodeInfra | undefined): boolean => {
  if (INLINE_COMMAND_PATTERN.test(command)) {
    return true;
  }

  const scriptMatch = PACKAGE_MANAGER_COMMAND_PATTERN.exec(command);
  if (!scriptMatch) {
    return false;
  }

  if (!nodeInfra) {
    return false;
  }

  const [, scriptName] = scriptMatch;
  return nodeInfra.allScriptNames.includes(scriptName);
};

// eslint-disable-next-line max-lines-per-function
const isVerificationCommandAllowed = (
  command: string,
  testInfra?: TestInfraContext,
  affectedRepositories?: string[]
): boolean => {
  const trimmed = normalizeRepoLocalVerificationCommand(command, affectedRepositories);
  const nodeInfra = testInfra?.ecosystems.find((ecosystem): ecosystem is NodeInfra => ecosystem.ecosystem === 'node');

  if (isNodeVerificationAllowed(trimmed, nodeInfra)) {
    return true;
  }

  if (
    testInfra?.ecosystems.some(ecosystem => ecosystem.ecosystem === 'terraform')
    && TERRAFORM_COMMAND_PATTERN.test(trimmed)
  ) {
    return true;
  }

  if (
    testInfra?.ecosystems.some(ecosystem => ecosystem.ecosystem === 'python')
    && PYTHON_COMMAND_PATTERN.test(trimmed)
  ) {
    return true;
  }

  return !!(testInfra?.ecosystems.some(ecosystem => ecosystem.ecosystem === 'go') && GO_COMMAND_PATTERN.test(trimmed));
};

/**
 * Extracts file paths embedded inside a `node -e` inline script.
 *
 * Looks for string-literal arrays whose variable name contains "allowed" or "files",
 * then pulls out values that look like relative file paths (contain a `/` and end
 * with an extension).
 *
 * @param command - The full verification command string
 * @returns Array of file-path-like strings found inside the script, empty when none match
 */
const extractInlineAllowedPaths = (command: string): string[] => {
  if (!INLINE_COMMAND_PATTERN.test(command.trim())) return [];
  const arrayPattern = /(?:allowed|files)\s*=\s*\[([^\]]+)]/gi;
  const paths: string[] = [];
  let arrayMatch: RegExpExecArray | null;
  while ((arrayMatch = arrayPattern.exec(command)) !== null) {
    const elements = arrayMatch[1].matchAll(/['"]([^'"]+)['"]/g);
    for (const element of elements) {
      if (element[1].includes('/') && /\.\w+$/.test(element[1])) {
        paths.push(element[1]);
      }
    }
  }
  return paths;
};

/**
 * Normalizes an affectedFiles entry to a plain file path string.
 *
 * @param entry - Either a string path or a FileEntry object
 * @returns The file path string
 */
const toFilePath = (entry: string | { filePath: string }): string =>
  typeof entry === 'string' ? entry : entry.filePath;

/**
 * Builds a set of planned file paths with repo prefixes stripped.
 *
 * @param affectedFiles - The plan's declared affected files
 * @param repos - Repository names used to strip path prefixes
 * @returns Set of repo-relative file paths
 */
const buildPlannedPathSet = (
  affectedFiles: NonNullable<ResolutionPlan['affectedFiles']>,
  repos: string[]
): Set<string> => {
  const strip = (p: string): string => {
    const match = repos.find(repo => p.startsWith(`${repo}/`));
    return match ? p.slice(match.length + 1) : p;
  };
  return new Set(affectedFiles.map(entry => strip(toFilePath(entry))));
};

/**
 * Returns drift violations for a single verification check against planned paths.
 *
 * @param check - A single targeted verification step
 * @param plannedPaths - Set of repo-relative planned file paths
 * @returns Violations for each orphaned path
 */
const findOrphanedPathViolations = (
  check: { id?: string; run?: string },
  plannedPaths: Set<string>
): PlanQualityViolation[] => {
  if (!check.run) return [];
  return extractInlineAllowedPaths(check.run)
    .filter(p => !plannedPaths.has(p))
    .map(orphaned => createViolation(
      'verification-inline-allowlist-drift',
      `Verification "${check.id}" references "${orphaned}" which is not in affectedFiles. `
      + 'Add the file to affectedFiles or remove it from the inline allowlist.'
    ));
};

/**
 * Detects inline verification commands whose embedded file-path allowlists
 * reference files not declared in the plan's affectedFiles.
 *
 * @param verification - The plan's verification config
 * @param affectedFiles - The plan's declared affected files
 * @param affectedRepositories - Repository names used to strip path prefixes
 * @returns Violations for each orphaned path found in an inline allowlist
 */
const detectInlineAllowlistDrift = (
  verification: ResolutionPlan['verification'] | undefined,
  affectedFiles: ResolutionPlan['affectedFiles'] | undefined,
  affectedRepositories?: string[]
): PlanQualityViolation[] => {
  if (!affectedFiles || affectedFiles.length === 0) return [];
  const plannedPaths = buildPlannedPathSet(affectedFiles, affectedRepositories ?? []);
  return (verification?.targeted ?? []).flatMap(check => findOrphanedPathViolations(check, plannedPaths));
};

// eslint-disable-next-line max-lines-per-function
const detectVerificationViolations = (
  verification: ResolutionPlan['verification'] | undefined,
  testInfra?: TestInfraContext,
  affectedRepositories?: string[]
): PlanQualityViolation[] => {
  const checks = verification?.targeted ?? [];
  const violations: PlanQualityViolation[] = [];

  for (const check of checks) {
    if (!check.run) {
      continue;
    }

    if (isVerificationCommandAllowed(check.run, testInfra, affectedRepositories)) {
      continue;
    }

    violations.push(
      createViolation('verification-allowlist', `Verification command must match the detected allowlist: ${check.run}`)
    );
  }

  return violations;
};

// eslint-disable-next-line max-lines-per-function
const detectTestConventionViolations = (steps: string[], testInfra?: TestInfraContext): PlanQualityViolation[] => {
  const nodeInfra = testInfra?.ecosystems.find((ecosystem): ecosystem is NodeInfra => ecosystem.ecosystem === 'node');
  const testPatterns = nodeInfra?.testPatterns;

  if (!testPatterns) {
    return [];
  }

  const stepText = steps.join('\n');
  const violations: PlanQualityViolation[] = [];

  if (testPatterns.fileSuffix === '.spec' && /\.test\.(ts|tsx|js|jsx)\b/.test(stepText)) {
    violations.push(createViolation('test-file-suffix', 'Snippets must use the detected *.spec.* suffix.'));
  }

  if (testPatterns.fileSuffix === '.test' && /\.spec\.(ts|tsx|js|jsx)\b/.test(stepText)) {
    violations.push(createViolation('test-file-suffix', 'Snippets must use the detected *.test.* suffix.'));
  }

  if (testPatterns.mockCleanup) {
    const { namespace, method } = testPatterns.mockCleanup;
    const mismatchedCleanup = ['restoreAllMocks', 'resetAllMocks', 'clearAllMocks'].find(
      candidateMethod =>
        candidateMethod !== method
        && new RegExp(`\\b\\w+\\.${candidateMethod}\\(\\)`).test(stepText)
    );

    if (mismatchedCleanup) {
      violations.push(
        createViolation(
          'mock-cleanup-convention',
          `Snippets must use ${namespace}.${method}() instead of ${mismatchedCleanup}().`
        )
      );
    }
  }

  if (testPatterns.mockFactoryPrefix) {
    const expectedFactoryPrefix = testPatterns.mockFactoryPrefix;
    const factoryIdentifiers = stepText.match(/\bcreate\w*(?:Mock|Stub|Fake|Spy)\w*/g) ?? [];
    const mismatchedFactory = factoryIdentifiers.find(identifier => !identifier.startsWith(expectedFactoryPrefix));

    if (mismatchedFactory) {
      violations.push(
        createViolation(
          'mock-factory-prefix',
          `Snippets must use the detected factory prefix "${expectedFactoryPrefix}" instead of "${mismatchedFactory}".`
        )
      );
    }
  }

  return violations;
};

const uniqueViolations = (violations: PlanQualityViolation[]): PlanQualityViolation[] => {
  const seen = new Set<string>();
  return violations.filter(violation => {
    const key = `${violation.ruleId}:${violation.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const validatePlanQuality = (params: ValidatePlanQualityParams): PlanQualityViolation[] => {
  const steps = Array.isArray(params.plan.steps)
    ? params.plan.steps.filter((step): step is string => true)
    : [];

  const skillViolations: PlanQualityViolation[] = (params.skillRules ?? []).flatMap(rule =>
    rule.validate(params.plan).map(message => ({ ruleId: rule.ruleId, message }))
  );

  return uniqueViolations([
    ...detectRenameViolations(steps),
    ...detectVerificationViolations(params.plan.verification, params.testInfra, params.affectedRepositories),
    ...detectInlineAllowlistDrift(params.plan.verification, params.plan.affectedFiles, params.affectedRepositories),
    ...detectTestConventionViolations(steps, params.testInfra),
    ...skillViolations,
  ]);
};

const createPlanQualityError = (violations: PlanQualityViolation[]): ValidationError => {
  const details = violations.map(violation => `[${violation.ruleId}] ${violation.message}`).join('\n');
  return new ValidationError(`Generated plan failed quality checks:\n${details}`);
};

export { createPlanQualityError, validatePlanQuality };
