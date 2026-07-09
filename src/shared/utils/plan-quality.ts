import type { ResolutionPlan } from '../types/ai.types';
import type { NodeInfra, TestInfraContext } from '../types/detection.types';
import { ValidationError } from '../errors/app.error';

export interface PlanQualityViolation {
  ruleId:
    | 'rename-target-required'
    | 'verification-allowlist'
    | 'test-file-suffix'
    | 'mock-cleanup-convention'
    | 'mock-factory-prefix';
  message: string;
}

interface ValidatePlanQualityParams {
  plan: Partial<ResolutionPlan>;
  affectedRepositories?: string[];
  testInfra?: TestInfraContext;
}

const PACKAGE_MANAGER_COMMAND_PATTERN = /^(?:yarn|npm run|pnpm|pnpm run|npx|nr)\s+([^\s]+)/;
const RENAME_STEP_PATTERN = /\b(rename|move|refactor)\b/i;
const INLINE_COMMAND_PATTERN = /^(node -e|sh -c|bash -c)\s/;
const PYTHON_COMMAND_PATTERN = /^(pytest|python -m pytest)\b/;
const GO_COMMAND_PATTERN = /^go (test|vet)\b/;
const TERRAFORM_COMMAND_PATTERN = /^terraform (validate|plan|fmt)\b/;
const REPO_LOCAL_CD_PREFIX_PATTERN = /^cd\s+(.+?)\s*&&\s*(.+)$/;
const EXPLICIT_REPLACEMENT_TARGET_PATTERN =
  /\b(?:rename|move|refactor)\b[\s\S]{0,240}\b(?:to|into)\s+(?:`[^`]+`|'[^']+'|"[^"]+"|[A-Za-z0-9_./-]+)/i;
const NAMED_REPLACEMENT_TARGET_PATTERN =
  /\b(?:new name|new path)\b\s*(?::|=|\bis\b)?\s*(?:`[^`]+`|'[^']+'|"[^"]+"|[A-Za-z0-9_./-]+)/i;

const createViolation = (ruleId: PlanQualityViolation['ruleId'], message: string): PlanQualityViolation => ({
  ruleId,
  message,
});

const hasExplicitReplacementTarget = (step: string): boolean => {
  const normalizedStep = step.replace(/\s+/g, ' ').trim();
  return (
    EXPLICIT_REPLACEMENT_TARGET_PATTERN.test(normalizedStep) || NAMED_REPLACEMENT_TARGET_PATTERN.test(normalizedStep)
  );
};

const normalizeRepoLocalVerificationCommand = (command: string, affectedRepositories?: string[]): string => {
  const trimmed = command.trim();
  const cdPrefixMatch = trimmed.match(REPO_LOCAL_CD_PREFIX_PATTERN);
  if (!cdPrefixMatch) {
    return trimmed;
  }

  const [, rawTarget, remainder] = cdPrefixMatch;
  const target = rawTarget.trim().replace(/^['"]|['"]$/g, '');
  const repoNames = affectedRepositories?.map(repo => repo.trim()).filter(Boolean) ?? [];
  const isRepoLocalTarget = repoNames.some(repo => target === repo || target === `./${repo}`);

  if (isRepoLocalTarget) {
    return remainder.trim();
  }

  return trimmed;
};

const detectRenameViolations = (steps: string[]): PlanQualityViolation[] => {
  const violations: PlanQualityViolation[] = [];

  steps.forEach((step, index) => {
    if (!RENAME_STEP_PATTERN.test(step)) {
      return;
    }

    if (hasExplicitReplacementTarget(step)) {
      return;
    }

    violations.push(
      createViolation(
        'rename-target-required',
        `Step ${index + 1} must state the replacement target explicitly: ${step}`
      )
    );
  });

  return violations;
};

const isNodeVerificationAllowed = (command: string, nodeInfra: NodeInfra | undefined): boolean => {
  if (INLINE_COMMAND_PATTERN.test(command)) {
    return true;
  }

  const scriptMatch = command.match(PACKAGE_MANAGER_COMMAND_PATTERN);
  if (!scriptMatch) {
    return false;
  }

  if (!nodeInfra) {
    return false;
  }

  const [, scriptName] = scriptMatch;
  return nodeInfra.allScriptNames.includes(scriptName);
};

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
    testInfra?.ecosystems.some(ecosystem => ecosystem.ecosystem === 'terraform') &&
    TERRAFORM_COMMAND_PATTERN.test(trimmed)
  ) {
    return true;
  }

  if (
    testInfra?.ecosystems.some(ecosystem => ecosystem.ecosystem === 'python') &&
    PYTHON_COMMAND_PATTERN.test(trimmed)
  ) {
    return true;
  }

  if (testInfra?.ecosystems.some(ecosystem => ecosystem.ecosystem === 'go') && GO_COMMAND_PATTERN.test(trimmed)) {
    return true;
  }

  return false;
};

const detectVerificationViolations = (
  verification: ResolutionPlan['verification'] | undefined,
  testInfra?: TestInfraContext,
  affectedRepositories?: string[]
): PlanQualityViolation[] => {
  const checks = verification?.targeted ?? [];
  const violations: PlanQualityViolation[] = [];

  checks.forEach(check => {
    if (!check.run) {
      return;
    }

    if (isVerificationCommandAllowed(check.run, testInfra, affectedRepositories)) {
      return;
    }

    violations.push(
      createViolation('verification-allowlist', `Verification command must match the detected allowlist: ${check.run}`)
    );
  });

  return violations;
};

const detectTestConventionViolations = (steps: string[], testInfra?: TestInfraContext): PlanQualityViolation[] => {
  const nodeInfra = testInfra?.ecosystems.find((ecosystem): ecosystem is NodeInfra => ecosystem.ecosystem === 'node');
  const testPatterns = nodeInfra?.testPatterns;

  if (!testPatterns) {
    return [];
  }

  const stepText = steps.join('\n');
  const violations: PlanQualityViolation[] = [];

  if (testPatterns.fileSuffix === '.spec' && /\.test\.(ts|tsx|js|jsx)\b/.test(stepText)) {
    violations.push(createViolation('test-file-suffix', 'Plan test snippets must use the detected *.spec.* suffix.'));
  }

  if (testPatterns.fileSuffix === '.test' && /\.spec\.(ts|tsx|js|jsx)\b/.test(stepText)) {
    violations.push(createViolation('test-file-suffix', 'Plan test snippets must use the detected *.test.* suffix.'));
  }

  if (testPatterns.mockCleanup) {
    const mismatchedCleanup = ['restoreAllMocks', 'resetAllMocks', 'clearAllMocks'].find(
      cleanupName =>
        cleanupName !== testPatterns.mockCleanup && new RegExp(`jest\\.${cleanupName}\\(\\)`).test(stepText)
    );

    if (mismatchedCleanup) {
      violations.push(
        createViolation(
          'mock-cleanup-convention',
          `Plan test snippets must use jest.${testPatterns.mockCleanup}() instead of jest.${mismatchedCleanup}().`
        )
      );
    }
  }

  if (testPatterns.mockFactoryPrefix) {
    const expectedFactoryPrefix = testPatterns.mockFactoryPrefix;
    const factoryIdentifiers = stepText.match(/\bcreate[A-Za-z0-9_]*(?:Mock|Stub|Fake|Spy)[A-Za-z0-9_]*/g) ?? [];
    const mismatchedFactory = factoryIdentifiers.find(identifier => !identifier.startsWith(expectedFactoryPrefix));

    if (mismatchedFactory) {
      violations.push(
        createViolation(
          'mock-factory-prefix',
          `Plan test snippets must use the detected factory prefix "${expectedFactoryPrefix}" instead of "${mismatchedFactory}".`
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
    ? params.plan.steps.filter((step): step is string => typeof step === 'string')
    : [];

  return uniqueViolations([
    ...detectRenameViolations(steps),
    ...detectVerificationViolations(params.plan.verification, params.testInfra, params.affectedRepositories),
    ...detectTestConventionViolations(steps, params.testInfra),
  ]);
};

const createPlanQualityError = (violations: PlanQualityViolation[]): ValidationError => {
  const details = violations.map(violation => `[${violation.ruleId}] ${violation.message}`).join('\n');
  return new ValidationError(`Generated plan failed quality checks:\n${details}`);
};

export { createPlanQualityError, validatePlanQuality };
