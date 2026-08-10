import * as fs from 'fs';
import * as path from 'path';
import { verificationPolicySchema } from '../schemas/verification.schema';
import type {
  VerificationPolicy,
  VerificationStep,
  VerificationWaiver,
  VerificationManifest,
  PlanVerificationConfig,
} from '../types/verification.types';

export type { VerificationPolicy, VerificationStep, VerificationWaiver, VerificationManifest, PlanVerificationConfig };

const VALID_POLICIES = new Set<string>(verificationPolicySchema.options);

const extractStepFields = (rawStep: Record<string, unknown>) => ({
  id: typeof rawStep.id === 'string' ? rawStep.id.trim() : '',
  run: typeof rawStep.run === 'string' ? rawStep.run.trim() : '',
  policy: rawStep.policy,
  reason: typeof rawStep.reason === 'string' ? rawStep.reason.trim() || undefined : undefined,
});

const normalizeStep = (value: unknown, filePath: string): VerificationStep => {
  if (!value || typeof value !== 'object') {
    throw new Error(`Verification step is not valid: ${filePath}`);
  }
  const { id, run, policy, reason } = extractStepFields(value as Record<string, unknown>);
  if (!id) throw new Error(`Verification step is missing id: ${filePath}`);
  if (!run) throw new Error(`Verification step is missing run command: ${filePath}`);
  if (typeof policy !== 'string' || !VALID_POLICIES.has(policy)) {
    throw new Error(`Verification step has an invalid policy: ${filePath}`);
  }
  return { id, run, policy: policy as VerificationPolicy, reason };
};

const normalizeWaiver = (value: unknown, filePath: string): VerificationWaiver => {
  if (!value || typeof value !== 'object') {
    throw new Error(`Verification waiver is not valid: ${filePath}`);
  }

  const rawWaiver = value as Record<string, unknown>;
  const id = typeof rawWaiver.id === 'string' ? rawWaiver.id.trim() : '';
  const reason = typeof rawWaiver.reason === 'string' ? rawWaiver.reason.trim() : '';

  if (!id) {
    throw new Error(`Verification waiver is missing id: ${filePath}`);
  }

  if (!reason) {
    throw new Error(`Verification waiver is missing reason: ${filePath}`);
  }

  return { id, reason };
};

const KNOWN_SCRIPT_PATTERN = /(npm|yarn|pnpm|bun|deno)\s+(task\s+)?(build|lint|test|typecheck)\b/;

/**
 * Extracts the canonical script name (e.g. "build", "test") from a command
 * that invokes a well-known package-manager script. Returns undefined for
 * commands that don't match the pattern.
 */
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

/**
 * Merge baseline and targeted verification steps by ID and command content.
 * Targeted steps with `policy: 'override'` bypass all deduplication and are
 * always inserted (replacing if IDs match, appending otherwise).
 * Other targeted duplicates are silently dropped (baseline wins).
 * Targeted steps whose command invokes the same well-known script as a
 * baseline entry (e.g. `yarn build` vs `npm build`) are also dropped,
 * since the baseline already covers that check.
 * New targeted IDs are appended in order.
 */
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

const DEPRECATED_FLAG_REWRITES: [RegExp, string][] = [
  [/--testPathPattern(?==|\s)/g, '--testPathPatterns'],
  [/--forceExit(?=\s|$)/g, '--forceExit'],
];

/**
 * Rewrites known deprecated CLI flags in targeted verification commands.
 * Only applied to AI-generated targeted steps, not user-authored baselines.
 *
 * @param command - The raw command string from a targeted step.
 * @returns The command with deprecated flags replaced.
 */
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
    throw new Error(`Plan verification is not valid: ${filePath}`);
  }
  const raw = value as Record<string, unknown>;
  return {
    targeted: Array.isArray(raw.targeted) ? raw.targeted.map(item => normalizeStep(item, filePath)) : undefined,
    waivers: Array.isArray(raw.waivers) ? raw.waivers.map(item => normalizeWaiver(item, filePath)) : undefined,
  };
};

/**
 * Parse a verification manifest (v1 or v2) and return a normalized v1-shaped
 * result scoped to the requested stage.
 *
 * @param content - Raw JSON string
 * @param filePath - Source path for error messages
 * @param stage - Stage to extract from a v2 manifest (ignored for v1)
 * @returns Normalized manifest with `baseline` for the requested stage
 */
export const parseVerificationManifest = (content: string, filePath: string, stage?: string): VerificationManifest => {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version === 2) return parseV2Manifest(parsed, filePath, stage ?? 'implement');
  if (parsed.version !== 1) throw new Error(`Unsupported verification manifest version: ${filePath}`);
  if (!Array.isArray(parsed.baseline)) {
    throw new Error(`Verification manifest baseline is not valid: ${filePath}`);
  }
  return { version: 1, baseline: parsed.baseline.map(item => normalizeStep(item, filePath)) };
};

const parseV2Manifest = (parsed: Record<string, unknown>, filePath: string, stage: string): VerificationManifest => {
  const stageBlock = parsed[stage];
  if (stageBlock === undefined) return { version: 1, baseline: [] };
  if (!stageBlock || typeof stageBlock !== 'object') {
    throw new Error(`Verification manifest "${stage}" block is not valid: ${filePath}`);
  }
  const stageRecord = stageBlock as Record<string, unknown>;
  if (!Array.isArray(stageRecord.baseline)) {
    throw new Error(`Verification manifest "${stage}.baseline" is not valid: ${filePath}`);
  }
  return { version: 1, baseline: stageRecord.baseline.map(item => normalizeStep(item, filePath)) };
};

/**
 * Load and parse a verification manifest from disk.
 *
 * @param filePath - Absolute or relative path to the manifest file
 * @param stage - Stage to extract from a v2 manifest (ignored for v1)
 * @returns Normalized manifest with `baseline` for the requested stage
 */
export const loadVerificationManifest = (filePath: string, stage?: string): VerificationManifest => {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Verification manifest not found: ${resolvedPath}`);
  }

  return parseVerificationManifest(fs.readFileSync(resolvedPath, 'utf-8'), resolvedPath, stage);
};
