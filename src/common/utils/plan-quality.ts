import type { ResolutionPlan } from '../types/ai.types';
import type { NodeInfra, TestInfraContext } from '../types/detection.types';
import { ValidationError } from '../errors/app.error';
import type { SkillQualityRule } from '../../skills/skill.types';
import type { PackageManager } from './detect-repo-conventions';
import { formatRunnerInvocation, parseRunnerInvocation } from './verification-commands';
import { buildPlannedPathSet } from './planned-paths';
import { planStepDescriptions } from './plan-steps';
import { detectDuplicateResolverViolations } from './plan-quality-duplicate-resolver';
import chalk from 'chalk';

export interface PlanQualityViolation {
  ruleId: string;
  message: string;
}

interface ValidatePlanQualityParams {
  plan: Partial<ResolutionPlan>;
  affectedRepositories?: string[];
  testInfra?: TestInfraContext;
  skillRules?: SkillQualityRule[];
  packageManager?: PackageManager;
  repoDir?: string;
}

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

const NEEDLE_RULE_ID = 'needle-search-required';
const NEEDLE_STEP_PATTERN = new RegExp(`${/\b(?:delete|drop|remove|replace)\b/.source}|${RENAME_STEP_PATTERN.source}`, 'i');
const NEGATED_SEARCH_PATTERN = /(?:^|[\s'"(;&|])!\s*(?:git\s+grep|grep|rg)\s/;
const IGNORE_CASE_FLAG_PATTERN = /\s(?:-[a-zA-Z]*i[a-zA-Z]*|--ignore-case)(?=\s)/;
const WORD_BOUNDARY_PATTERN = /\\b/;

const isCaseInsensitiveZeroMatchCommand = (command: string): boolean =>
  NEGATED_SEARCH_PATTERN.test(command)
  && IGNORE_CASE_FLAG_PATTERN.test(command)
  && !WORD_BOUNDARY_PATTERN.test(command);

const needleViolationMessage = (removalSteps: number[]): string =>
  `Step ${removalSteps.join(', ')} removes or replaces a term but verification.targeted has no negated `
  + "case-insensitive zero-match command (for example `bash -c '! git grep -I -i -q -F <term>'`) without \\b patterns. "
  + `Add one, or waive it with a verification.waivers entry with id "${NEEDLE_RULE_ID}".`;

const detectNeedleSearchViolations = (
  steps: string[], verification: ResolutionPlan['verification'] | undefined
): PlanQualityViolation[] => {
  const removalSteps = steps.flatMap((step, index) => NEEDLE_STEP_PATTERN.test(step) ? [index + 1] : []);
  if (removalSteps.length === 0) return [];
  if (verification?.waivers?.some(waiver => waiver.id === NEEDLE_RULE_ID)) return [];
  if (verification?.targeted?.some(entry => isCaseInsensitiveZeroMatchCommand(entry.run))) return [];
  return [createViolation(NEEDLE_RULE_ID, needleViolationMessage(removalSteps))];
};

const CALL_ASSERTION_RULE_ID = 'test-call-assertion-required';
const SPEC_FILE_PATTERN = /\.(?:spec|test)\.[jt]sx?/;
const mockedCollaboratorPatterns = [
  /\bmock(?:s|ed|ing)?\b/i,
  /\bstub(?:s|bed|bing)?\b/i,
  /\bspy(?:ing)? on\b/i,
  /\bjest\.(?:fn|spyOn|mock)\b/,
  /\bmock(?:Resolved|Rejected|Return|Implementation)\w*/,
];
const callAssertionPatterns = [
  /\btoHaveBeenCalled\w*/,
  /\btoBeCalled\w*/,
  /\bmock\.calls\b/,
  /\bcall count\b/i,
  /\bcalled (?:once|twice|exactly|with)\b/i,
  /\b(?:not|never) (?:be )?called\b/i,
];

const callAssertionViolationMessage = (steps: number[]): string =>
  `Step ${steps.join(', ')} writes a spec with a mocked collaborator but never asserts it was called. `
  + 'State that the collaborator is asserted called after the act step, with arguments inspected from `mock.calls`, '
  + 'not asserted inside the mock callback. '
  + `Or waive it with a verification.waivers entry with id "${CALL_ASSERTION_RULE_ID}".`;

const needsCallAssertion = (step: string): boolean =>
  SPEC_FILE_PATTERN.test(step)
  && mockedCollaboratorPatterns.some(pattern => pattern.test(step))
  && !callAssertionPatterns.some(pattern => pattern.test(step));

const detectTestCallAssertionViolations = (
  steps: string[], verification: ResolutionPlan['verification'] | undefined
): PlanQualityViolation[] => {
  const flaggedSteps = steps.flatMap((step, index) => needsCallAssertion(step) ? [index + 1] : []);
  if (flaggedSteps.length === 0) return [];
  if (verification?.waivers?.some(waiver => waiver.id === CALL_ASSERTION_RULE_ID)) return [];
  return [createViolation(CALL_ASSERTION_RULE_ID, callAssertionViolationMessage(flaggedSteps))];
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

  const invocation = parseRunnerInvocation(command);
  if (!invocation) {
    return false;
  }

  if (!nodeInfra) {
    return false;
  }

  return nodeInfra.allScriptNames.includes(invocation.script);
};

const formatVerificationAllowlistGuidance = (
  nodeInfra: NodeInfra | undefined, packageManager?: PackageManager
): string => {
  if (!nodeInfra) return '';

  const scriptNames = Object.keys(nodeInfra.scripts).slice(0, 5);
  if (packageManager) {
    const forms = scriptNames.map(script => formatRunnerInvocation(packageManager, script, '...'));
    return ` Allowed forms: ${[...forms, 'node -e "..."'].join(', ')}.`;
  }

  const scriptList = scriptNames.length > 0 ? ` Allowed scripts: ${scriptNames.join(', ')}.` : '';
  return `${scriptList} Allowed inline form: node -e "...".`;
};

// eslint-disable-next-line max-lines-per-function
const isVerificationCommandAllowed = (
  command: string,
  testInfra?: TestInfraContext,
  affectedRepositories?: string[]
): boolean => {
  const trimmed = normalizeRepoLocalVerificationCommand(command, affectedRepositories);
  const nodeInfra = testInfra?.ecosystems.find((ecosystem): ecosystem is NodeInfra => ecosystem.ecosystem === 'node');

  if (isNodeVerificationAllowed(trimmed, nodeInfra)) return true;

  if (
    testInfra?.ecosystems.some(ecosystem => ecosystem.ecosystem === 'terraform')
    && TERRAFORM_COMMAND_PATTERN.test(trimmed)
  ) return true;

  if (
    testInfra?.ecosystems.some(ecosystem => ecosystem.ecosystem === 'python')
    && PYTHON_COMMAND_PATTERN.test(trimmed)
  ) return true;

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

const stripRepoPrefixFromPath = (path: string, repos: string[]): string =>
  repos.reduce(
    (acc, repo) => acc.startsWith(`${repo}/`) ? acc.slice(repo.length + 1) : acc,
    path,
  );

const normalizePathToken = (t: string): string =>
  t.replaceAll(/^["']|["']$/g, '').replace(/^\.\//, '');

const findTerraformFmtMembershipViolations = (
  normalizedPaths: string[],
  plannedPaths: Set<string>,
  checkId: string | undefined,
  affectedRepositories: string[]
): PlanQualityViolation[] =>
  normalizedPaths
    .filter(p => !plannedPaths.has(stripRepoPrefixFromPath(p, affectedRepositories)))
    .map(p => createViolation(
      'terraform-fmt-scope',
      `Verification "${checkId}" references "${p}" which is not in affectedFiles. `
      + 'Add the file to affectedFiles or remove it from the verification command.'
    ));

const detectTerraformFmtStructuralViolations = (
  flags: string[], normalizedPaths: string[], pathArgs: string[]
): PlanQualityViolation[] => {
  if (flags.some(f => /^--?recursive/.test(f)))
    return [createViolation('terraform-fmt-scope', 'terraform fmt must not use -recursive; list affected files explicitly.')];
  const hasCheck = flags.some(f => f === '-check' || f === '--check' || /^-+check=true/.test(f));
  if (!hasCheck || flags.some(f => /^-+check=false/.test(f)))
    return [createViolation('terraform-fmt-scope', 'terraform fmt must use -check; the mutating form is not a verification command.')];
  if (normalizedPaths.length === 0 || pathArgs.includes('-'))
    return [createViolation('terraform-fmt-scope', 'terraform fmt must list affected files explicitly.')];
  if (normalizedPaths.some(p => !/\.(tf|tfvars)$/.test(p)))
    return [createViolation('terraform-fmt-scope', 'terraform fmt must list explicit .tf files, not directories.')];
  return [];
};

const parseTerraformFmtArgs = (
  segment: string
): { flags: string[]; pathArgs: string[]; normalizedPaths: string[] } => {
  const args = segment.split(/\s+/).slice(2);
  const flags = args.filter(t => t.startsWith('-'));
  const pathArgs = args.filter(t => !t.startsWith('-') && !t.includes('>') && !t.includes('<'));
  return { flags, pathArgs, normalizedPaths: pathArgs.map(normalizePathToken).filter(p => p !== '-') };
};

const analyzeTerraformFmtSegment = (
  segment: string,
  checkId: string | undefined,
  plannedPaths: Set<string> | null,
  affectedRepositories: string[]
): PlanQualityViolation[] => {
  if (!/^terraform fmt\b/.test(segment)) return [];
  const { flags, pathArgs, normalizedPaths } = parseTerraformFmtArgs(segment);
  const structural = detectTerraformFmtStructuralViolations(flags, normalizedPaths, pathArgs);
  if (structural.length > 0) return structural;
  return plannedPaths
    ? findTerraformFmtMembershipViolations(normalizedPaths, plannedPaths, checkId, affectedRepositories)
    : [];
};

const detectTerraformFmtScopeViolations = (
  verification: ResolutionPlan['verification'] | undefined,
  affectedFiles: ResolutionPlan['affectedFiles'] | undefined,
  affectedRepositories?: string[]
): PlanQualityViolation[] => {
  const repos = affectedRepositories ?? [];
  const plannedPaths = affectedFiles?.length ? buildPlannedPathSet(affectedFiles, repos) : null;
  return (verification?.targeted ?? []).flatMap(check => {
    if (!check.run) return [];
    return normalizeRepoLocalVerificationCommand(check.run, affectedRepositories)
      .split(/\s*(?:&&|\|\||;|\|)\s*/)
      .flatMap(s => analyzeTerraformFmtSegment(s.trim(), check.id, plannedPaths, repos));
  });
};

// eslint-disable-next-line max-lines-per-function
const detectVerificationViolations = (
  verification: ResolutionPlan['verification'] | undefined,
  testInfra?: TestInfraContext,
  affectedRepositories?: string[],
  packageManager?: PackageManager
): PlanQualityViolation[] => {
  const checks = verification?.targeted ?? [];
  const violations: PlanQualityViolation[] = [];
  const nodeInfra = testInfra?.ecosystems.find((ecosystem): ecosystem is NodeInfra => ecosystem.ecosystem === 'node');

  for (const check of checks) {
    if (!check.run) {
      continue;
    }

    if (isVerificationCommandAllowed(check.run, testInfra, affectedRepositories)) {
      continue;
    }

    violations.push(
      createViolation(
        'verification-allowlist',
        `Verification command must match the detected allowlist: ${check.run}${formatVerificationAllowlistGuidance(nodeInfra, packageManager)}`
      )
    );
  }

  return violations;
};

const detectFileSuffixViolations = (
  testPatterns: NonNullable<NodeInfra['testPatterns']>,
  stepText: string,
): PlanQualityViolation[] => {
  const violations: PlanQualityViolation[] = [];
  if (testPatterns.fileSuffix === '.spec' && /\.test\.(ts|tsx|js|jsx)\b/.test(stepText))
    violations.push(createViolation('test-file-suffix', 'Snippets must use the detected *.spec.* suffix.'));
  if (testPatterns.fileSuffix === '.test' && /\.spec\.(ts|tsx|js|jsx)\b/.test(stepText))
    violations.push(createViolation('test-file-suffix', 'Snippets must use the detected *.test.* suffix.'));
  return violations;
};

const detectMockCleanupViolations = (
  testPatterns: NonNullable<NodeInfra['testPatterns']>,
  stepText: string,
): PlanQualityViolation[] => {
  const cleanup = testPatterns.mockCleanup;
  if (!cleanup) return [];
  const mismatch = ['restoreAllMocks', 'resetAllMocks', 'clearAllMocks'].find(
    m => m !== cleanup.method && new RegExp(`\\b\\w+\\.${m}\\(\\)`).test(stepText)
  );
  if (!mismatch) return [];
  return [createViolation(
    'mock-cleanup-convention',
    `Snippets must use ${cleanup.namespace}.${cleanup.method}() instead of ${mismatch}().`
  )];
};

const detectMockFactoryViolations = (
  testPatterns: NonNullable<NodeInfra['testPatterns']>,
  stepText: string,
): PlanQualityViolation[] => {
  const expectedFactoryPrefix = testPatterns.mockFactoryPrefix;
  if (!expectedFactoryPrefix) return [];
  const factoryIdentifiers = stepText.match(/\bcreate\w*(?:Mock|Stub|Fake|Spy)\w*/g) ?? [];
  const mismatchedFactory = factoryIdentifiers.find(id => !id.startsWith(expectedFactoryPrefix));
  if (!mismatchedFactory) return [];
  return [createViolation(
    'mock-factory-prefix',
    `Snippets must use the detected factory prefix "${expectedFactoryPrefix}" instead of "${mismatchedFactory}".`
  )];
};

const detectTestConventionViolations = (steps: string[], testInfra?: TestInfraContext): PlanQualityViolation[] => {
  const nodeInfra = testInfra?.ecosystems.find((ecosystem): ecosystem is NodeInfra => ecosystem.ecosystem === 'node');
  const testPatterns = nodeInfra?.testPatterns;
  if (!testPatterns) return [];
  const stepText = steps.join('\n');
  return [
    ...detectFileSuffixViolations(testPatterns, stepText),
    ...detectMockCleanupViolations(testPatterns, stepText),
    ...detectMockFactoryViolations(testPatterns, stepText),
  ];
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

const detectSkillViolations = (params: ValidatePlanQualityParams): PlanQualityViolation[] =>
  (params.skillRules ?? []).flatMap(rule =>
    rule.validate(params.plan).map(message => ({ ruleId: rule.ruleId, message }))
  );

// eslint-disable-next-line max-lines-per-function
const validatePlanQuality = (params: ValidatePlanQualityParams): PlanQualityViolation[] => {
  const steps = planStepDescriptions(params.plan.steps ?? []);

  return uniqueViolations([
    ...detectRenameViolations(steps),
    ...detectNeedleSearchViolations(steps, params.plan.verification),
    ...detectTestCallAssertionViolations(steps, params.plan.verification),
    ...detectVerificationViolations(
      params.plan.verification, params.testInfra, params.affectedRepositories, params.packageManager
    ),
    ...detectInlineAllowlistDrift(
      params.plan.verification, params.plan.affectedFiles, params.affectedRepositories
    ),
    ...detectTerraformFmtScopeViolations(
      params.plan.verification, params.plan.affectedFiles, params.affectedRepositories
    ),
    ...detectTestConventionViolations(steps, params.testInfra),
    ...detectSkillViolations(params),
  ]);
};

const validatePlanQualityWithLookups = async (
  params: ValidatePlanQualityParams
): Promise<PlanQualityViolation[]> => {
  const steps = planStepDescriptions(params.plan.steps ?? []);
  const duplicateResolverViolations = await detectDuplicateResolverViolations({
    steps,
    affectedFiles: params.plan.affectedFiles,
    affectedRepositories: params.affectedRepositories,
    repoDir: params.repoDir,
  });
  return uniqueViolations([...validatePlanQuality(params), ...duplicateResolverViolations]);
};

const createPlanQualityError = (violations: PlanQualityViolation[]): ValidationError => {
  const details = violations.map(violation => `[${violation.ruleId}] ${violation.message}`).join('\n');
  return new ValidationError(`Generated plan failed quality checks:\n${details}`);
};

const TAG_PARSE_PATTERN = /^\[([^\]]+)\]\s*(.*)$/s;

// eslint-disable-next-line max-lines-per-function
const wrapWords = (text: string, width: number, indent: string): string => {
  if (width <= 0 || text.length <= width) return text;
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current + ' ' + word).length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n' + indent);
};

// eslint-disable-next-line max-lines-per-function
const formatPlanQualityViolations = (violations: string[], header: string): string => {
  const width = Math.min((process.stdout.columns ?? 100) - 8, 100);
  const headerLine = chalk.bold.yellow(`⚠ ${header}:`);

  const formattedViolations = violations.map(violation => {
    const match = TAG_PARSE_PATTERN.exec(violation);
    const tag = match ? match[1] : '';
    const body = match ? match[2] : violation;
    const prefix = tag ? `[${tag}] ` : '';
    const indent = ' '.repeat(prefix.length);
    const availableWidth = width - prefix.length;

    const wrappedBody = body
      .split('\n')
      .map(segment => wrapWords(segment, availableWidth, indent))
      .join('\n' + indent);

    const tagPart = tag ? chalk.bold.red(`[${tag}]`) + ' ' : '';
    return tagPart + wrappedBody;
  });

  return headerLine + '\n' + formattedViolations.join('\n\n');
};

export { createPlanQualityError, formatPlanQualityViolations, validatePlanQuality, validatePlanQualityWithLookups };
