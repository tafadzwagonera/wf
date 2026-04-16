import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { ResolutionPlan } from '../../integrations/ai/ai.service';
import type { ResolutionAction } from '../../agents/interfaces';
import {
  hashGeneratedTicketSources,
  matchesGeneratedTicketToken,
} from './generated-ticket-artifact';
import { normalizePlanVerification } from './verification-manifest';

const VALID_ACTIONS: ResolutionAction[] = ['feature', 'fix', 'investigate'];
const VALID_COMPLEXITIES = ['low', 'medium', 'high'] as const;
const PLAN_ARTIFACT_MANIFEST_EXTENSION = '.sources.json';
const LEGACY_PLAN_EXTENSIONS = ['json', 'md', 'yaml', 'yml'] as const;
const HASHED_PLAN_STEM = /^([a-f0-9]+)-(feature|fix|investigate)-plan$/i;

type PlanComplexity = (typeof VALID_COMPLEXITIES)[number];
type PlanArtifactFormat = 'json' | 'md' | 'yaml' | 'yml';

type PlanArtifactSourceKind = 'ticket' | 'custom';

export interface PlanArtifactManifest {
  artifactPath: string;
  action: ResolutionAction;
  createdAt: string;
  format: PlanArtifactFormat;
  hash: string;
  sourceKind: PlanArtifactSourceKind;
  sourceName: string;
  ticketKey?: string;
  customArtifactName?: string;
  platformName?: string;
}

export interface PlanArtifactReference {
  action: ResolutionAction;
  artifactPath: string;
  format: PlanArtifactFormat;
  hash: string;
  manifestPath?: string;
  sourceKind: PlanArtifactSourceKind;
  sourceName: string;
  ticketKey?: string;
  customArtifactName?: string;
  isLegacy: boolean;
}

export interface ResolvePlanArtifactOptions {
  artifactDir: string;
  action?: ResolutionAction;
}

export interface BuildPlanArtifactFilenameOptions {
  hash: string;
  action: ResolutionAction;
  format: PlanArtifactFormat;
}

export interface BuildPlanArtifactResolutionNoticeOptions {
  artifactPath: string;
  action: ResolutionAction;
  isLegacy: boolean;
  sourceName?: string;
  ticketKey?: string;
  customArtifactName?: string;
}

/**
 * Describe a resolved plan artifact for user-facing warnings.
 *
 * @param reference - Resolved artifact reference
 * @returns Human-readable notice or null for legacy artifacts
 */
export const buildPlanArtifactResolutionNotice = (
  reference: BuildPlanArtifactResolutionNoticeOptions,
): string | null => {
  if (reference.isLegacy) {
    return null;
  }

  const sourceLabel = reference.ticketKey
    ? `ticket ${reference.ticketKey}`
    : reference.customArtifactName
      ? `custom plan ${reference.customArtifactName}`
      : `source ${reference.sourceName ?? path.basename(reference.artifactPath)}`;

  return `Detected plan artifact ${path.basename(reference.artifactPath)} for ${sourceLabel}; using action ${reference.action}.`;
};

/**
 * Supported persisted plan artifact extensions.
 *
 * `yml` is accepted on read for resilience, even though current writers emit
 * `yaml`.
 */
export const SUPPORTED_PLAN_EXTENSIONS = ['json', 'md', 'yaml', 'yml'] as const;

/**
 * Check whether an identifier looks like a ticket key.
 *
 * @param value - Raw command argument
 * @returns True when the value matches `ABC-123`
 */
export const isTicketKey = (value: string): boolean =>
  /^[A-Z]+-\d+$/i.test(value);

/**
 * Build the deterministic source hash used in plan filenames.
 *
 * @param sources - Ordered source tokens identifying the plan artifact
 * @returns Short lowercase SHA-256 token
 */
export const hashPlanArtifactSources = (sources: string[]): string =>
  hashGeneratedTicketSources(sources);

/**
 * Build the filename for a hashed plan artifact.
 *
 * @param options - Filename components
 * @returns Hashed plan filename including extension
 */
export const buildPlanArtifactFilename = (
  options: BuildPlanArtifactFilenameOptions,
): string =>
  `${options.hash.trim().toLowerCase()}-${options.action}-plan.${normalizeFormat(options.format)}`;

/**
 * Build the sidecar manifest filename for a hashed plan artifact.
 *
 * @param artifactFilename - Hashed plan artifact filename
 * @returns Manifest filename alongside the artifact
 */
export const buildPlanArtifactManifestFilename = (
  artifactFilename: string,
): string => {
  const extensionlessArtifact = artifactFilename.replace(/\.[^.]+$/, '');
  return `${extensionlessArtifact}${PLAN_ARTIFACT_MANIFEST_EXTENSION}`;
};

/**
 * Build the sidecar manifest path for a hashed plan artifact.
 *
 * @param artifactPath - Absolute hashed plan artifact path
 * @returns Manifest path alongside the artifact
 */
export const buildPlanArtifactManifestPath = (artifactPath: string): string =>
  path.join(
    path.dirname(artifactPath),
    buildPlanArtifactManifestFilename(path.basename(artifactPath)),
  );

/**
 * Build a manifest payload for a hashed plan artifact.
 *
 * @param artifactPath - Absolute artifact path
 * @param action - Resolution action embedded in the filename
 * @param format - Serialized artifact format
 * @param hash - Hash token used in the filename
 * @param sourceName - Original source token for reversible lookup
 * @param sourceKind - Whether the source came from a ticket or custom artifact
 * @param createdAt - Creation timestamp
 * @param platformName - Optional platform namespace for traceability
 * @returns Manifest payload used for lookup and migration
 */
export const buildPlanArtifactManifest = (
  artifactPath: string,
  action: ResolutionAction,
  format: PlanArtifactFormat,
  hash: string,
  sourceName: string,
  sourceKind: PlanArtifactSourceKind,
  createdAt: Date,
  platformName?: string,
): PlanArtifactManifest => ({
  artifactPath,
  action,
  createdAt: createdAt.toISOString(),
  format: normalizeFormat(format) as PlanArtifactFormat,
  hash: hash.trim().toLowerCase(),
  sourceKind,
  sourceName,
  ticketKey: sourceKind === 'ticket' ? sourceName : undefined,
  customArtifactName: sourceKind === 'custom' ? sourceName : undefined,
  platformName,
});

/**
 * Persist a plan artifact manifest alongside the artifact.
 *
 * @param manifest - Manifest payload to write
 * @returns Absolute manifest path
 */
export const writePlanArtifactManifest = (
  manifest: PlanArtifactManifest,
): string => {
  const manifestPath = buildPlanArtifactManifestPath(manifest.artifactPath);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return manifestPath;
};

/**
 * Load a plan artifact manifest from disk.
 *
 * @param manifestPath - Absolute manifest path
 * @returns Parsed manifest or null when the file is missing or invalid
 */
export const readPlanArtifactManifest = (
  manifestPath: string,
): PlanArtifactManifest | null => {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const value = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    ) as Partial<PlanArtifactManifest>;
    if (
      typeof value.artifactPath !== 'string' ||
      typeof value.action !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof value.format !== 'string' ||
      typeof value.hash !== 'string' ||
      typeof value.sourceKind !== 'string' ||
      typeof value.sourceName !== 'string'
    ) {
      return null;
    }

    const action = value.action;
    if (!VALID_ACTIONS.includes(action)) {
      return null;
    }

    const sourceKind = value.sourceKind;
    if (sourceKind !== 'ticket' && sourceKind !== 'custom') {
      return null;
    }

    const format = normalizeFormat(value.format) as PlanArtifactFormat;
    if (
      format !== 'json' &&
      format !== 'md' &&
      format !== 'yaml' &&
      format !== 'yml'
    ) {
      return null;
    }

    return {
      artifactPath: value.artifactPath,
      action,
      createdAt: value.createdAt,
      format,
      hash: value.hash,
      sourceKind,
      sourceName: value.sourceName,
      ticketKey:
        typeof value.ticketKey === 'string' ? value.ticketKey : undefined,
      customArtifactName:
        typeof value.customArtifactName === 'string'
          ? value.customArtifactName
          : undefined,
      platformName:
        typeof value.platformName === 'string' ? value.platformName : undefined,
    };
  } catch {
    return null;
  }
};

const normalizeFormat = (format: string): string =>
  format.trim().toLowerCase() === 'md' ? 'md' : format.trim().toLowerCase();

const stripArtifactExtension = (fileName: string): string =>
  fileName.replace(/\.[^.]+$/, '');

const parseHashedStem = (
  stem: string,
): { hash: string; action: ResolutionAction } | null => {
  const match = stem.match(HASHED_PLAN_STEM);
  if (!match) {
    return null;
  }

  const [, hash, action] = match;
  if (!hash || !action || !VALID_ACTIONS.includes(action as ResolutionAction)) {
    return null;
  }

  return {
    hash: hash.toLowerCase(),
    action: action as ResolutionAction,
  };
};

const listManifestPaths = (artifactDir: string): string[] =>
  fs.existsSync(artifactDir)
    ? fs
        .readdirSync(artifactDir)
        .filter((name) => name.endsWith(PLAN_ARTIFACT_MANIFEST_EXTENSION))
        .map((name) => path.join(artifactDir, name))
    : [];

const resolveActionFromIdentifier = (
  identifierStem: string,
  action?: ResolutionAction,
): ResolutionAction | undefined => {
  if (action) {
    return action;
  }

  return parseHashedStem(identifierStem)?.action;
};

const readManifestCandidates = (artifactDir: string): PlanArtifactManifest[] =>
  listManifestPaths(artifactDir)
    .map((manifestPath) => readPlanArtifactManifest(manifestPath))
    .filter((manifest): manifest is PlanArtifactManifest => manifest !== null);

const matchesManifestIdentifier = (
  manifest: PlanArtifactManifest,
  identifierStem: string,
  normalizedIdentifier: string,
  requestedAction?: ResolutionAction,
): boolean => {
  if (requestedAction && manifest.action !== requestedAction) {
    return false;
  }

  const artifactStem = stripArtifactExtension(
    path.basename(manifest.artifactPath),
  );
  const sourceTokens = [
    manifest.hash,
    manifest.ticketKey,
    manifest.customArtifactName,
    manifest.sourceName,
    artifactStem,
  ].filter(
    (token): token is string => typeof token === 'string' && token.length > 0,
  );

  if (
    sourceTokens.some((token) => {
      const candidate = token.trim().toLowerCase();
      return (
        candidate === normalizedIdentifier ||
        candidate === identifierStem.toLowerCase() ||
        candidate.startsWith(normalizedIdentifier) ||
        candidate.startsWith(identifierStem.toLowerCase()) ||
        matchesGeneratedTicketToken(normalizedIdentifier, candidate) ||
        matchesGeneratedTicketToken(identifierStem, candidate)
      );
    })
  ) {
    return true;
  }

  const parsedStem = parseHashedStem(identifierStem);
  if (parsedStem) {
    return manifest.hash.toLowerCase() === parsedStem.hash;
  }

  return false;
};

const buildLegacyCandidates = (
  artifactDir: string,
  identifierStem: string,
  requestedAction?: ResolutionAction,
): string[] => {
  const actions = requestedAction ? [requestedAction] : VALID_ACTIONS;
  const legacyCandidateBases = [identifierStem];

  return legacyCandidateBases.flatMap((base) =>
    actions.flatMap((action) =>
      LEGACY_PLAN_EXTENSIONS.flatMap((extension) => [
        path.join(artifactDir, `${base}-plan-${action}.${extension}`),
        path.join(artifactDir, `${base}-${action}.${extension}`),
      ]),
    ),
  );
};

const buildHashedCandidates = (
  artifactDir: string,
  hash: string,
  action: ResolutionAction,
): string[] =>
  LEGACY_PLAN_EXTENSIONS.map((extension) =>
    path.join(
      artifactDir,
      buildPlanArtifactFilename({ hash, action, format: extension }),
    ),
  );

const identifySourceKind = (identifierStem: string): PlanArtifactSourceKind =>
  isTicketKey(identifierStem) ? 'ticket' : 'custom';

const resolveManifestMatch = (
  artifactDir: string,
  identifierStem: string,
  requestedAction?: ResolutionAction,
): PlanArtifactReference | null => {
  const normalizedIdentifier = identifierStem.trim().toLowerCase();
  const candidates = readManifestCandidates(artifactDir).filter((manifest) =>
    matchesManifestIdentifier(
      manifest,
      identifierStem,
      normalizedIdentifier,
      requestedAction,
    ),
  );

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length > 1) {
    throw new Error(
      `Multiple plan artifacts found for '${identifierStem}': ${candidates
        .map((candidate) => path.basename(candidate.artifactPath))
        .join(
          ', ',
        )}. Use the explicit hashed filename or remove stale artifacts.`,
    );
  }

  const selected = candidates[0];
  return {
    action: selected.action,
    artifactPath: selected.artifactPath,
    format: selected.format,
    hash: selected.hash,
    manifestPath: buildPlanArtifactManifestPath(selected.artifactPath),
    sourceKind: selected.sourceKind,
    sourceName: selected.sourceName,
    ticketKey: selected.ticketKey,
    customArtifactName: selected.customArtifactName,
    isLegacy: false,
  };
};

const resolveLegacyMatch = (
  artifactDir: string,
  identifierStem: string,
  requestedAction?: ResolutionAction,
): PlanArtifactReference | null => {
  const normalizedStem = identifierStem.trim();
  const sourceKind = identifySourceKind(normalizedStem);
  const actions = requestedAction ? [requestedAction] : VALID_ACTIONS;
  const candidatePaths =
    sourceKind === 'ticket'
      ? actions.flatMap((action) =>
          LEGACY_PLAN_EXTENSIONS.map((extension) =>
            path.join(
              artifactDir,
              `${normalizedStem}-plan-${action}.${extension}`,
            ),
          ),
        )
      : actions.flatMap((action) =>
          LEGACY_PLAN_EXTENSIONS.map((extension) =>
            path.join(artifactDir, `${normalizedStem}-${action}.${extension}`),
          ),
        );

  const existing = candidatePaths.filter((candidatePath) =>
    fs.existsSync(candidatePath),
  );
  if (existing.length === 0) {
    return null;
  }

  if (existing.length > 1) {
    throw new Error(
      `Multiple legacy plan artifacts found for '${identifierStem}': ${existing
        .map((candidatePath) => path.basename(candidatePath))
        .join(
          ', ',
        )}. Use the explicit hashed filename or remove stale artifacts.`,
    );
  }

  const artifactPath = existing[0];
  const matchedStem = stripArtifactExtension(path.basename(artifactPath));
  const parsedHashedStem = parseHashedStem(matchedStem);
  const action =
    requestedAction ??
    parsedHashedStem?.action ??
    extractLegacyAction(matchedStem);

  if (!action) {
    throw new Error(
      `Unable to resolve action for legacy plan artifact '${path.basename(artifactPath)}'.`,
    );
  }

  return {
    action,
    artifactPath,
    format: path
      .extname(artifactPath)
      .slice(1)
      .toLowerCase() as PlanArtifactFormat,
    hash: parsedHashedStem?.hash ?? hashPlanArtifactSources([normalizedStem]),
    manifestPath: undefined,
    sourceKind,
    sourceName: normalizedStem,
    ticketKey: sourceKind === 'ticket' ? normalizedStem : undefined,
    customArtifactName: sourceKind === 'custom' ? normalizedStem : undefined,
    isLegacy: true,
  };
};

const extractLegacyAction = (
  artifactStem: string,
): ResolutionAction | undefined => {
  const match = artifactStem.match(/-(feature|fix|investigate)$/i);
  if (!match) {
    return undefined;
  }

  const [, action] = match;
  return VALID_ACTIONS.includes(action as ResolutionAction)
    ? (action as ResolutionAction)
    : undefined;
};

const resolveHashedMatch = (
  artifactDir: string,
  identifierStem: string,
  requestedAction?: ResolutionAction,
): PlanArtifactReference | null => {
  const parsedStem = parseHashedStem(identifierStem);
  const hashToken = parsedStem?.hash ?? identifierStem.trim().toLowerCase();
  const action = requestedAction ?? parsedStem?.action;
  if (!action) {
    return null;
  }

  const candidatePaths = buildHashedCandidates(artifactDir, hashToken, action);
  const existing = candidatePaths.filter((candidatePath) =>
    fs.existsSync(candidatePath),
  );
  if (existing.length === 0) {
    return null;
  }

  if (existing.length > 1) {
    throw new Error(
      `Multiple hashed plan artifacts found for '${identifierStem}' and action '${action}': ${existing
        .map((candidatePath) => path.basename(candidatePath))
        .join(', ')}. Use the explicit filename including extension.`,
    );
  }

  const artifactPath = existing[0];
  return {
    action,
    artifactPath,
    format: path
      .extname(artifactPath)
      .slice(1)
      .toLowerCase() as PlanArtifactFormat,
    hash: hashToken,
    manifestPath: buildPlanArtifactManifestPath(artifactPath),
    sourceKind: 'ticket',
    sourceName: parsedStem?.hash ?? hashToken,
    isLegacy: false,
  };
};

/**
 * Resolve a plan artifact from a ticket key, hash token, or hashed filename stem.
 *
 * @param identifier - Raw CLI token, ticket key, or filename stem
 * @param options - Artifact directory and optional action hint
 * @returns Resolved plan artifact reference
 */
export const resolvePlanArtifactReference = (
  identifier: string,
  options: ResolvePlanArtifactOptions,
): PlanArtifactReference => {
  const artifactDir = options.artifactDir;
  const identifierStem = stripArtifactExtension(
    path.basename(identifier.trim()),
  );
  const requestedAction = resolveActionFromIdentifier(
    identifierStem,
    options.action,
  );

  const manifestMatch = resolveManifestMatch(
    artifactDir,
    identifierStem,
    requestedAction,
  );
  if (manifestMatch) {
    return manifestMatch;
  }

  const hashedMatch = resolveHashedMatch(
    artifactDir,
    identifierStem,
    requestedAction,
  );
  if (hashedMatch) {
    return hashedMatch;
  }

  const legacyMatch = resolveLegacyMatch(
    artifactDir,
    identifierStem,
    requestedAction,
  );
  if (legacyMatch) {
    return legacyMatch;
  }

  const candidateList = [
    ...buildHashedCandidates(
      artifactDir,
      identifierStem,
      requestedAction ?? 'fix',
    ),
    ...buildLegacyCandidates(artifactDir, identifierStem, requestedAction),
  ];
  throw new Error(
    `Plan artifact not found for '${identifier}'. Checked: ${candidateList.join(', ')}`,
  );
};

/**
 * Parse a persisted plan artifact into the canonical `ResolutionPlan` shape.
 *
 * @param content - Raw artifact content
 * @param filePath - Artifact path used for extension detection and errors
 * @returns Normalized resolution plan
 */
export const parsePlanArtifact = (
  content: string,
  filePath: string,
): ResolutionPlan => {
  const extension = path.extname(filePath).slice(1).toLowerCase();

  if (extension === 'json') {
    return normalizePlan(JSON.parse(content), filePath);
  }

  if (extension === 'yaml' || extension === 'yml') {
    return normalizePlan(YAML.parse(content), filePath);
  }

  if (extension === 'md') {
    return parseMarkdownPlan(content, filePath);
  }

  throw new Error(`Unsupported plan file format: ${filePath}`);
};

/**
 * Build the artifact extension used when writing plans for a given CLI format.
 *
 * @param format - User-facing output format
 * @returns File extension without a leading dot
 */
export const getPlanArtifactExtension = (
  format: PlanArtifactFormat,
): PlanArtifactFormat => format;

const normalizePlan = (value: unknown, filePath: string): ResolutionPlan => {
  if (!value || typeof value !== 'object') {
    throw new Error(`Plan file is not valid: ${filePath}`);
  }

  const rawPlan = value as Record<string, unknown>;
  const action = normalizeAction(rawPlan.action, filePath);
  const estimatedComplexity = normalizeComplexity(
    rawPlan.estimatedComplexity,
    filePath,
  );

  return {
    action,
    summary: typeof rawPlan.summary === 'string' ? rawPlan.summary : '',
    steps: normalizeStringList(rawPlan.steps),
    estimatedComplexity,
    filesAffected: normalizeOptionalStringList(rawPlan.filesAffected),
    repositoriesAffected: normalizeOptionalStringList(
      rawPlan.repositoriesAffected,
    ),
    risks: normalizeOptionalStringList(rawPlan.risks),
    verification: normalizePlanVerification(rawPlan.verification, filePath),
    provider:
      typeof rawPlan.provider === 'string' ? rawPlan.provider : undefined,
    source: typeof rawPlan.source === 'string' ? rawPlan.source : undefined,
    timestamp:
      typeof rawPlan.timestamp === 'string' ? rawPlan.timestamp : undefined,
  };
};

const parseMarkdownPlan = (
  content: string,
  filePath: string,
): ResolutionPlan => {
  const sections = new Map<string, string[]>();
  let activeSection = '';
  const metadata = new Map<string, string>();

  for (const line of content.split('\n')) {
    const metadataMatch = line.match(/^\*\*([^:]+):\*\*\s*(.+)$/);
    if (metadataMatch) {
      metadata.set(
        metadataMatch[1].trim().toLowerCase(),
        metadataMatch[2].trim(),
      );
      continue;
    }

    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      activeSection = headingMatch[1].trim().toLowerCase();
      sections.set(activeSection, []);
      continue;
    }

    if (!activeSection) {
      continue;
    }

    sections.get(activeSection)?.push(line);
  }

  return normalizePlan(
    {
      action: metadata.get('action'),
      estimatedComplexity: metadata.get('complexity'),
      summary: collapseSection(sections.get('summary')),
      steps: extractNumberedList(sections.get('steps')),
      filesAffected: extractBulletedList(sections.get('files affected')),
      repositoriesAffected: extractBulletedList(
        sections.get('repositories affected'),
      ),
      risks: extractBulletedList(sections.get('risks')),
    },
    filePath,
  );
};

const collapseSection = (lines?: string[]): string =>
  (lines ?? []).join('\n').trim();

const extractNumberedList = (lines?: string[]): string[] =>
  (lines ?? [])
    .map((line) => line.match(/^\d+\.\s+(.+)$/)?.[1]?.trim() ?? '')
    .filter(Boolean);

const extractBulletedList = (lines?: string[]): string[] =>
  (lines ?? [])
    .map((line) => line.match(/^-\s+(.+)$/)?.[1]?.trim() ?? '')
    .filter(Boolean);

const normalizeAction = (
  value: unknown,
  filePath: string,
): ResolutionAction => {
  if (
    typeof value === 'string' &&
    VALID_ACTIONS.includes(value as ResolutionAction)
  ) {
    return value as ResolutionAction;
  }

  throw new Error(`Plan file has an invalid action: ${filePath}`);
};

const normalizeComplexity = (
  value: unknown,
  filePath: string,
): PlanComplexity => {
  if (value === undefined || value === null || value === '') {
    return 'medium';
  }

  if (
    typeof value === 'string' &&
    VALID_COMPLEXITIES.includes(value as PlanComplexity)
  ) {
    return value as PlanComplexity;
  }

  throw new Error(`Plan file has an invalid complexity: ${filePath}`);
};

const normalizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item));
};

const normalizeOptionalStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((item) => String(item));
};
