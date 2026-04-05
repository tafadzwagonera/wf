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

export const parseVerificationManifest = (
  content: string,
  filePath: string,
): VerificationManifest => {
  const parsed = JSON.parse(content) as Record<string, unknown>;

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

export const loadVerificationManifest = (
  filePath: string,
): VerificationManifest => {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Verification manifest not found: ${resolvedPath}`);
  }

  return parseVerificationManifest(
    fs.readFileSync(resolvedPath, 'utf-8'),
    resolvedPath,
  );
};
