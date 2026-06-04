import * as fs from 'fs';
import * as path from 'path';

export type VerificationPolicy = 'enforced' | 'best_effort';

export interface VerificationStep {
  id: string;
  run: string;
  policy: VerificationPolicy;
  reason?: string;
}

export interface VerificationWaiver {
  id: string;
  reason: string;
}

export interface VerificationManifest {
  version: 1;
  baseline: VerificationStep[];
}

export interface PlanVerificationConfig {
  targeted?: VerificationStep[];
  waivers?: VerificationWaiver[];
}

const normalizeStep = (value: unknown, filePath: string): VerificationStep => {
  if (!value || typeof value !== 'object') {
    throw new Error(`Verification step is not valid: ${filePath}`);
  }

  const rawStep = value as Record<string, unknown>;
  const id = typeof rawStep.id === 'string' ? rawStep.id.trim() : '';
  const run = typeof rawStep.run === 'string' ? rawStep.run.trim() : '';
  const policy =
    rawStep.policy === 'best_effort' ? 'best_effort' : rawStep.policy;

  if (!id) {
    throw new Error(`Verification step is missing id: ${filePath}`);
  }

  if (!run) {
    throw new Error(`Verification step is missing run command: ${filePath}`);
  }

  if (policy !== 'enforced' && policy !== 'best_effort') {
    throw new Error(`Verification step has an invalid policy: ${filePath}`);
  }

  return {
    id,
    run,
    policy,
    reason:
      typeof rawStep.reason === 'string' && rawStep.reason.trim()
        ? rawStep.reason.trim()
        : undefined,
  };
};

const normalizeWaiver = (
  value: unknown,
  filePath: string,
): VerificationWaiver => {
  if (!value || typeof value !== 'object') {
    throw new Error(`Verification waiver is not valid: ${filePath}`);
  }

  const rawWaiver = value as Record<string, unknown>;
  const id = typeof rawWaiver.id === 'string' ? rawWaiver.id.trim() : '';
  const reason =
    typeof rawWaiver.reason === 'string' ? rawWaiver.reason.trim() : '';

  if (!id) {
    throw new Error(`Verification waiver is missing id: ${filePath}`);
  }

  if (!reason) {
    throw new Error(`Verification waiver is missing reason: ${filePath}`);
  }

  return { id, reason };
};

export const normalizePlanVerification = (
  value: unknown,
  filePath: string,
): PlanVerificationConfig | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== 'object') {
    throw new Error(`Plan verification is not valid: ${filePath}`);
  }

  const rawVerification = value as Record<string, unknown>;

  return {
    targeted: Array.isArray(rawVerification.targeted)
      ? rawVerification.targeted.map((item) => normalizeStep(item, filePath))
      : undefined,
    waivers: Array.isArray(rawVerification.waivers)
      ? rawVerification.waivers.map((item) => normalizeWaiver(item, filePath))
      : undefined,
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
export const parseVerificationManifest = (
  content: string,
  filePath: string,
  stage?: string,
): VerificationManifest => {
  const parsed = JSON.parse(content) as Record<string, unknown>;

  if (parsed.version === 2) {
    return parseV2Manifest(parsed, filePath, stage ?? 'implement');
  }

  if (parsed.version !== 1) {
    throw new Error(`Unsupported verification manifest version: ${filePath}`);
  }

  if (!Array.isArray(parsed.baseline)) {
    throw new Error(`Verification manifest baseline is not valid: ${filePath}`);
  }

  return {
    version: 1,
    baseline: parsed.baseline.map((item) => normalizeStep(item, filePath)),
  };
};

const parseV2Manifest = (
  parsed: Record<string, unknown>,
  filePath: string,
  stage: string,
): VerificationManifest => {
  const stageBlock = parsed[stage];

  if (stageBlock === undefined) {
    return { version: 1, baseline: [] };
  }

  if (!stageBlock || typeof stageBlock !== 'object') {
    throw new Error(
      `Verification manifest "${stage}" block is not valid: ${filePath}`,
    );
  }

  const stageRecord = stageBlock as Record<string, unknown>;

  if (!Array.isArray(stageRecord.baseline)) {
    throw new Error(
      `Verification manifest "${stage}.baseline" is not valid: ${filePath}`,
    );
  }

  return {
    version: 1,
    baseline: stageRecord.baseline.map((item) => normalizeStep(item, filePath)),
  };
};

/**
 * Load and parse a verification manifest from disk.
 *
 * @param filePath - Absolute or relative path to the manifest file
 * @param stage - Stage to extract from a v2 manifest (ignored for v1)
 * @returns Normalized manifest with `baseline` for the requested stage
 */
export const loadVerificationManifest = (
  filePath: string,
  stage?: string,
): VerificationManifest => {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Verification manifest not found: ${resolvedPath}`);
  }

  return parseVerificationManifest(
    fs.readFileSync(resolvedPath, 'utf-8'),
    resolvedPath,
    stage,
  );
};
