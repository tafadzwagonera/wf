import * as fs from 'node:fs';
import * as path from 'node:path';
import { isValidRegexPattern, verificationPolicySchema } from '../schemas/verification.schema';
import { ValidationError } from '../errors/app.error';
import type {
  VerificationPolicy,
  VerificationStep,
  VerificationWaiver,
  VerificationManifest,
  PlanVerificationConfig,
} from '../types/verification.types';

export type {
  VerificationPolicy,
  VerificationStep,
  VerificationWaiver,
  VerificationManifest,
  PlanVerificationConfig,
} from '../types/verification.types';

const VALID_POLICIES = new Set<string>(verificationPolicySchema.options);

const extractStepFields = (rawStep: Record<string, unknown>) => ({
  id: typeof rawStep.id === 'string' ? rawStep.id.trim() : '',
  run: typeof rawStep.run === 'string' ? rawStep.run.trim() : '',
  policy: rawStep.policy,
  reason: typeof rawStep.reason === 'string' ? rawStep.reason.trim() || undefined : undefined,
  earlyExitPattern: typeof rawStep.earlyExitPattern === 'string' ? rawStep.earlyExitPattern.trim() || undefined : undefined,
  repo: typeof rawStep.repo === 'string' ? rawStep.repo.trim() || undefined : undefined,
});

const requireStepField = (value: string, label: string, filePath: string): void => {
  if (value) return;
  throw new ValidationError(`Verification step is missing ${label}: ${filePath}`);
};

const validateStepPolicy = (policy: unknown, filePath: string): void => {
  if (typeof policy === 'string' && VALID_POLICIES.has(policy)) return;
  throw new ValidationError(`Verification step has an invalid policy: ${filePath}`);
};

const validateEarlyExitPattern = (pattern: string | undefined, filePath: string): void => {
  if (!pattern || isValidRegexPattern(pattern)) return;
  throw new ValidationError(`Verification step has an invalid early-exit pattern: ${filePath}`);
};

const warnTerraformFmtRecursive = (run: string, id: string, filePath: string): void => {
  if (!run.includes('terraform fmt') || !/\s--?recursive\b/.test(run)) return;
  console.warn(
    `[wf] ${path.basename(filePath)} step "${id}": `
    + '"terraform fmt -recursive" checks the entire repository. '
    + 'Use "terraform fmt -check <file.tf ...>" scoped to affected files.'
  );
};

const normalizeStep = (value: unknown, filePath: string): VerificationStep => {
  if (!value || typeof value !== 'object') {
    throw new ValidationError(`Verification step is not valid: ${filePath}`);
  }
  const { id, run, policy, reason, earlyExitPattern, repo } = extractStepFields(value as Record<string, unknown>);
  requireStepField(id, 'id', filePath);
  requireStepField(run, 'run command', filePath);
  validateStepPolicy(policy, filePath);
  validateEarlyExitPattern(earlyExitPattern, filePath);
  warnTerraformFmtRecursive(run, id, filePath);
  return { id, run, policy: policy as VerificationPolicy, reason, earlyExitPattern, repo };
};

const normalizeWaiver = (value: unknown, filePath: string): VerificationWaiver => {
  if (!value || typeof value !== 'object') {
    throw new ValidationError(`Verification waiver is not valid: ${filePath}`);
  }

  const rawWaiver = value as Record<string, unknown>;
  const id = typeof rawWaiver.id === 'string' ? rawWaiver.id.trim() : '';
  const reason = typeof rawWaiver.reason === 'string' ? rawWaiver.reason.trim() : '';

  if (!id) {
    throw new ValidationError(`Verification waiver is missing id: ${filePath}`);
  }

  if (!reason) {
    throw new ValidationError(`Verification waiver is missing reason: ${filePath}`);
  }

  return { id, reason };
};

const KNOWN_SCRIPT_PATTERN = /(npm|yarn|pnpm|bun|deno)\s+(task\s+)?(build|lint|test|typecheck)\b/;

const extractCanonicalScript = (command: string): string | undefined =>
  KNOWN_SCRIPT_PATTERN.exec(command)?.[3];

const isRedundantTargetedStep = (
  step: VerificationStep,
  mergedById: Map<string, VerificationStep>,
  baselineScripts: Set<string>,
): boolean => {
  if (mergedById.has(step.id)) return true;
  const script = extractCanonicalScript(step.run);
  return !!script && baselineScripts.has(script);
};

export const mergeVerificationSteps = (
  baseline: VerificationStep[],
  targeted: VerificationStep[],
): VerificationStep[] => {
  const mergedById = new Map(baseline.map(s => [s.id, s]));
  const baselineScripts = new Set(baseline.map(s => extractCanonicalScript(s.run)).filter((s): s is string => !!s));
  for (const step of targeted) {
    const dominated = step.policy !== 'override' && isRedundantTargetedStep(step, mergedById, baselineScripts);
    if (!dominated) mergedById.set(step.id, step);
  }
  return [...mergedById.values()];
};

export const filterVerificationStepsForRepo = (
  steps: VerificationStep[],
  repoName: string | undefined,
  affectedRepositories: string[],
): { kept: VerificationStep[]; dropped: VerificationStep[] } => {
  if (affectedRepositories.length <= 1) return { kept: steps, dropped: [] };
  if (steps.every(s => s.repo === undefined)) return { kept: steps, dropped: [] };
  const kept = steps.filter(s => s.repo === repoName);
  const dropped = steps.filter(s => s.repo !== repoName);
  return { kept, dropped };
};

const DEPRECATED_FLAG_REWRITES: [RegExp, string][] = [
  [/--testPathPattern(?==|\s)/g, '--testPathPatterns'],
  [/--forceExit(?=\s|$)/g, '--forceExit'],
];

export const normalizeTargetedStepCommand = (command: string): string => {
  let result = command;
  for (const [pattern, replacement] of DEPRECATED_FLAG_REWRITES) {
    result = result.replace(pattern, replacement);
  }
  // --testPathPatterns is a yargs array-type flag: a preceding `-- `
  // separator alters argument forwarding and causes yargs to consume
  // subsequent flags (e.g. --verbose) as extra pattern elements.
  result = result.replaceAll(/\s--\s+(--testPathPatterns\b)/g, ' $1');
  return result;
};

export const normalizePlanVerification = (value: unknown, filePath: string): PlanVerificationConfig | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    throw new ValidationError(`Plan verification is not valid: ${filePath}`);
  }
  const raw = value as Record<string, unknown>;
  return {
    targeted: Array.isArray(raw.targeted) ? raw.targeted.map(item => normalizeStep(item, filePath)) : undefined,
    waivers: Array.isArray(raw.waivers) ? raw.waivers.map(item => normalizeWaiver(item, filePath)) : undefined,
  };
};

export const parseVerificationManifest = (content: string, filePath: string, stage?: string): VerificationManifest => {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version === 2) return parseV2Manifest(parsed, filePath, stage ?? 'implement');
  if (parsed.version !== 1) throw new ValidationError(`Unsupported verification manifest version: ${filePath}`);
  if (!Array.isArray(parsed.baseline)) {
    throw new ValidationError(`Verification manifest baseline is not valid: ${filePath}`);
  }
  return { version: 1, baseline: parsed.baseline.map(item => normalizeStep(item, filePath)) };
};

const parseV2Manifest = (parsed: Record<string, unknown>, filePath: string, stage: string): VerificationManifest => {
  const stageBlock = parsed[stage];
  if (stageBlock === undefined) return { version: 1, baseline: [] };
  if (!stageBlock || typeof stageBlock !== 'object') {
    throw new ValidationError(`Verification manifest "${stage}" block is not valid: ${filePath}`);
  }
  const stageRecord = stageBlock as Record<string, unknown>;
  if (!Array.isArray(stageRecord.baseline)) {
    throw new ValidationError(`Verification manifest "${stage}.baseline" is not valid: ${filePath}`);
  }
  return { version: 1, baseline: stageRecord.baseline.map(item => normalizeStep(item, filePath)) };
};

export const loadVerificationManifest = (filePath: string, stage?: string): VerificationManifest => {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new ValidationError(`Verification manifest not found: ${resolvedPath}`);
  }

  return parseVerificationManifest(fs.readFileSync(resolvedPath, 'utf-8'), resolvedPath, stage);
};
