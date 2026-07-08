import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { type ResolutionPlan, type FileEntry, normalizeFileEntries } from '../../integrations/ai/ai.service';
import type { ResolutionAction, TicketArtifact } from '../../agents/interfaces';
import { resolveCustomArtifactDir } from '../../agents/utils';
import type { PlanArtifactManifest, PlanArtifactReference, PlanTokenResolution } from '../types/plan-artifact.types';
import { hashGeneratedTicketSources, matchesGeneratedTicketToken } from './generated-ticket-artifact';
import { normalizePlanVerification } from './verification-manifest';

export type { PlanArtifactManifest, PlanArtifactReference };

/**
 * Derive the review artifact path from a ticket artifact path.
 * Works for both real ticket paths (.md) and synthetic paths (.json, .yaml).
 *
 * @param ticketPath - Path to the ticket artifact
 * @returns Path for the review artifact
 */
export const deriveReviewArtifactPath = (ticketPath: string): string => {
  const ext = path.extname(ticketPath);
  if (!ext) return ticketPath + '-review.md';
  return ticketPath.slice(0, -ext.length) + '-review.md';
};

const VALID_ACTIONS: ResolutionAction[] = ['feature', 'fix', 'investigate'];
const VALID_COMPLEXITIES = ['low', 'medium', 'high'] as const;
const PLAN_ARTIFACT_MANIFEST_EXTENSION = '.sources.json';
const PLAN_ARTIFACT_EXTENSIONS = ['json', 'md', 'yaml', 'yml'] as const;
export const CANONICAL_PLAN_STEM = /^(\d{4}-\d{2}-\d{2})-([a-f0-9]+)-(feature|fix|investigate)-plan$/i;
const SHORT_HASHED_PLAN_STEM = /^([a-f0-9]+)-(feature|fix|investigate)-plan$/i;

/**
 * Check whether a CLI positional argument is a canonical plan-token reference.
 *
 * @param value - Raw command argument
 * @returns True when the value matches the canonical plan artifact naming convention
 */
export const isPlanToken = (value: string): boolean => CANONICAL_PLAN_STEM.test(value.replace(/\.[^.]+$/, ''));

type PlanComplexity = (typeof VALID_COMPLEXITIES)[number];
type PlanArtifactFormat = 'json' | 'md' | 'yaml' | 'yml';

type PlanArtifactSourceKind = 'ticket' | 'custom';

export interface ResolvePlanArtifactOptions {
  artifactDir: string;
  action?: ResolutionAction;
}

export interface BuildPlanArtifactFilenameOptions {
  createdAt?: Date | string;
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
  reference: BuildPlanArtifactResolutionNoticeOptions
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
const looksLikeTicketKey = (value: string): boolean => /^[A-Z]+-\d+$/i.test(value);

/**
 * Build the deterministic source hash used in plan filenames.
 *
 * @param sources - Ordered source tokens identifying the plan artifact
 * @returns Short lowercase SHA-256 token
 */
export const hashPlanArtifactSources = (sources: string[]): string => hashGeneratedTicketSources(sources);

/**
 * Build the filename for a hashed plan artifact.
 *
 * @param options - Filename components
 * @returns Hashed plan filename including extension
 */
export const buildPlanArtifactFilename = (options: BuildPlanArtifactFilenameOptions): string =>
  `${resolveDatePrefix(options.createdAt)}-${options.hash
    .trim()
    .toLowerCase()}-${options.action}-plan.${normalizeFormat(options.format)}`;

/**
 * Build the sidecar manifest filename for a hashed plan artifact.
 *
 * @param artifactFilename - Hashed plan artifact filename
 * @returns Manifest filename alongside the artifact
 */
export const buildPlanArtifactManifestFilename = (artifactFilename: string): string => {
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
  path.join(path.dirname(artifactPath), buildPlanArtifactManifestFilename(path.basename(artifactPath)));

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
 * @param trackerName - Optional platform namespace for traceability
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
  trackerName?: string
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
  trackerName,
});

/**
 * Persist a plan artifact manifest alongside the artifact.
 *
 * @param manifest - Manifest payload to write
 * @returns Absolute manifest path
 */
export const writePlanArtifactManifest = (manifest: PlanArtifactManifest): string => {
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
export const readPlanArtifactManifest = (manifestPath: string): PlanArtifactManifest | null => {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Partial<PlanArtifactManifest>;
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
    if (format !== 'json' && format !== 'md' && format !== 'yaml' && format !== 'yml') {
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
      ticketKey: typeof value.ticketKey === 'string' ? value.ticketKey : undefined,
      customArtifactName: typeof value.customArtifactName === 'string' ? value.customArtifactName : undefined,
      trackerName: typeof value.trackerName === 'string' ? value.trackerName : undefined,
    };
  } catch {
    return null;
  }
};

const normalizeFormat = (format: string): string =>
  format.trim().toLowerCase() === 'md' ? 'md' : format.trim().toLowerCase();

const stripArtifactExtension = (fileName: string): string => fileName.replace(/\.[^.]+$/, '');

const parseCanonicalStem = (stem: string): { datePrefix: string; hash: string; action: ResolutionAction } | null => {
  const match = stem.match(CANONICAL_PLAN_STEM);
  if (!match) {
    return null;
  }

  const [, datePrefix, hash, action] = match;
  if (!hash || !action || !VALID_ACTIONS.includes(action as ResolutionAction)) {
    return null;
  }

  return {
    datePrefix,
    hash: hash.toLowerCase(),
    action: action as ResolutionAction,
  };
};

const parseShortHashedStem = (stem: string): { hash: string; action: ResolutionAction } | null => {
  const match = stem.match(SHORT_HASHED_PLAN_STEM);
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
        .filter(name => name.endsWith(PLAN_ARTIFACT_MANIFEST_EXTENSION))
        .map(name => path.join(artifactDir, name))
    : [];

const resolveActionFromIdentifier = (
  identifierStem: string,
  action?: ResolutionAction
): ResolutionAction | undefined => {
  if (action) {
    return action;
  }

  return parseCanonicalStem(identifierStem)?.action;
};

const readManifestCandidates = (artifactDir: string): PlanArtifactManifest[] =>
  listManifestPaths(artifactDir)
    .map(manifestPath => readPlanArtifactManifest(manifestPath))
    .filter((manifest): manifest is PlanArtifactManifest => manifest !== null);

const matchesManifestIdentifier = (
  manifest: PlanArtifactManifest,
  identifierStem: string,
  normalizedIdentifier: string,
  requestedAction?: ResolutionAction
): boolean => {
  if (requestedAction && manifest.action !== requestedAction) {
    return false;
  }

  const artifactStem = stripArtifactExtension(path.basename(manifest.artifactPath));
  const sourceTokens = [
    manifest.hash,
    manifest.ticketKey,
    manifest.customArtifactName,
    manifest.sourceName,
    artifactStem,
  ].filter((token): token is string => typeof token === 'string' && token.length > 0);

  if (
    sourceTokens.some(token => {
      const candidate = token.trim().toLowerCase();
      return (
        candidate === normalizedIdentifier ||
        candidate === identifierStem.toLowerCase() ||
        matchesGeneratedTicketToken(normalizedIdentifier, candidate) ||
        matchesGeneratedTicketToken(identifierStem, candidate)
      );
    })
  ) {
    return true;
  }

  const parsedStem = parseCanonicalStem(identifierStem);
  if (parsedStem) {
    return manifest.hash.toLowerCase() === parsedStem.hash;
  }

  return false;
};

const isCanonicalArtifactPath = (artifactPath: string): boolean => {
  const extension = path.extname(artifactPath).slice(1).toLowerCase();
  if (!PLAN_ARTIFACT_EXTENSIONS.includes(extension as (typeof PLAN_ARTIFACT_EXTENSIONS)[number])) {
    return false;
  }

  const artifactStem = stripArtifactExtension(path.basename(artifactPath));
  return parseCanonicalStem(artifactStem) !== null;
};

const resolveManifestMatch = (
  artifactDir: string,
  identifierStem: string,
  requestedAction?: ResolutionAction
): PlanArtifactReference | null => {
  const normalizedIdentifier = identifierStem.trim().toLowerCase();
  const candidates = readManifestCandidates(artifactDir).filter(
    manifest =>
      isCanonicalArtifactPath(manifest.artifactPath) &&
      matchesManifestIdentifier(manifest, identifierStem, normalizedIdentifier, requestedAction)
  );

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length > 1) {
    throw new Error(
      `Multiple plan artifacts found for '${identifierStem}': ${candidates
        .map(candidate => path.basename(candidate.artifactPath))
        .join(', ')}. Use the explicit hashed filename or remove stale artifacts.`
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

/**
 * Resolve a plan artifact from a ticket key, hash token, or hashed filename stem.
 *
 * @param identifier - Raw CLI token, ticket key, or filename stem
 * @param options - Artifact directory and optional action hint
 * @returns Resolved plan artifact reference
 */
export const resolvePlanArtifactReference = (
  identifier: string,
  options: ResolvePlanArtifactOptions
): PlanArtifactReference => {
  const artifactDir = options.artifactDir;
  const identifierStem = stripArtifactExtension(path.basename(identifier.trim()));
  const requestedAction = resolveActionFromIdentifier(identifierStem, options.action);
  if (parseShortHashedStem(identifierStem)) {
    throw new Error(`Non-canonical plan identifier '${identifier}'. Use YYYY-MM-DD-<hash>-<action>-plan.<ext>.`);
  }

  const manifestMatch = resolveManifestMatch(artifactDir, identifierStem, requestedAction);
  if (manifestMatch) {
    return manifestMatch;
  }

  const candidateList =
    requestedAction && looksLikeTicketKey(identifierStem)
      ? PLAN_ARTIFACT_EXTENSIONS.map(
          extension => `YYYY-MM-DD-${hashPlanArtifactSources([identifierStem])}-${requestedAction}-plan.${extension}`
        )
      : ['YYYY-MM-DD-<hash>-<action>-plan.<ext>'];
  throw new Error(
    `Plan artifact not found for '${identifier}' in ${artifactDir}. Checked: ${candidateList.join(', ')}`
  );
};

const resolveDatePrefix = (createdAt?: Date | string): string => {
  const date = createdAt instanceof Date ? createdAt : typeof createdAt === 'string' ? new Date(createdAt) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid createdAt value for plan artifact: ${createdAt}`);
  }
  return date.toISOString().slice(0, 10);
};

/**
 * Parse a persisted plan artifact into the canonical `ResolutionPlan` shape.
 *
 * @param content - Raw artifact content
 * @param filePath - Artifact path used for extension detection and errors
 * @returns Normalized resolution plan
 */
export const parsePlanArtifact = (content: string, filePath: string): ResolutionPlan => {
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
export const getPlanArtifactExtension = (format: PlanArtifactFormat): PlanArtifactFormat => format;

const normalizePlan = (value: unknown, filePath: string): ResolutionPlan => {
  if (!value || typeof value !== 'object') {
    throw new Error(`Plan file is not valid: ${filePath}`);
  }

  const rawPlan = value as Record<string, unknown>;
  const action = normalizeAction(rawPlan.action, filePath);
  const estimatedComplexity = normalizeComplexity(rawPlan.estimatedComplexity, filePath);

  return {
    action,
    summary: typeof rawPlan.summary === 'string' ? rawPlan.summary : '',
    steps: normalizeStringList(rawPlan.steps),
    estimatedComplexity,
    affectedFiles: normalizeFileEntryList(rawPlan.affectedFiles ?? rawPlan.filesAffected),
    affectedFilesContext: normalizeFileEntryList(rawPlan.affectedFilesContext ?? rawPlan.filesContext),
    affectedRepositories: normalizeOptionalStringList(rawPlan.affectedRepositories ?? rawPlan.repositoriesAffected),
    risks: normalizeOptionalStringList(rawPlan.risks),
    verification: normalizePlanVerification(rawPlan.verification, filePath),
    provider: typeof rawPlan.provider === 'string' ? rawPlan.provider : undefined,
    source: typeof rawPlan.source === 'string' ? rawPlan.source : undefined,
    timestamp: typeof rawPlan.timestamp === 'string' ? rawPlan.timestamp : undefined,
  };
};

const parseMarkdownPlan = (content: string, filePath: string): ResolutionPlan => {
  const sections = new Map<string, string[]>();
  let activeSection = '';
  const metadata = new Map<string, string>();

  for (const line of content.split('\n')) {
    const metadataMatch = line.match(/^\*\*([^:]+):\*\*\s*(.+)$/);
    if (metadataMatch) {
      metadata.set(metadataMatch[1].trim().toLowerCase(), metadataMatch[2].trim());
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
      affectedFiles: extractBulletedList(sections.get('files affected')),
      affectedRepositories: extractBulletedList(
        sections.get('affected repositories') ?? sections.get('repositories affected')
      ),
      risks: extractBulletedList(sections.get('risks')),
    },
    filePath
  );
};

const collapseSection = (lines?: string[]): string => (lines ?? []).join('\n').trim();

const extractNumberedList = (lines?: string[]): string[] =>
  (lines ?? []).map(line => line.match(/^\d+\.\s+(.+)$/)?.[1]?.trim() ?? '').filter(Boolean);

const extractBulletedList = (lines?: string[]): string[] =>
  (lines ?? []).map(line => line.match(/^-\s+(.+)$/)?.[1]?.trim() ?? '').filter(Boolean);

const normalizeAction = (value: unknown, filePath: string): ResolutionAction => {
  if (typeof value === 'string' && VALID_ACTIONS.includes(value as ResolutionAction)) {
    return value as ResolutionAction;
  }

  throw new Error(`Plan file has an invalid action: ${filePath}`);
};

const normalizeComplexity = (value: unknown, filePath: string): PlanComplexity => {
  if (value === undefined || value === null || value === '') {
    return 'medium';
  }

  if (typeof value === 'string' && VALID_COMPLEXITIES.includes(value as PlanComplexity)) {
    return value as PlanComplexity;
  }

  throw new Error(`Plan file has an invalid complexity: ${filePath}`);
};

const normalizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(item => String(item));
};

const normalizeOptionalStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map(item => String(item));
};

const isFileEntry = (item: unknown): item is FileEntry =>
  typeof item === 'object' && item !== null && 'filePath' in item && typeof (item as FileEntry).filePath === 'string';

const normalizeFileEntryList = (value: unknown): (string | FileEntry)[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map(item => {
    if (isFileEntry(item)) return item;
    return String(item);
  });
};

/**
 * Resolve a CLI argument as a plan artifact by searching the tracker
 * directory (`~/.wf/<app>/<tracker>/`) then the custom artifact directory
 * (`~/.wf/<app>/`).
 *
 * @param argument - Raw CLI positional argument (ticket key or plan filename)
 * @param trackerDir - Tracker artifact directory
 * @param repoBaseDir - Repository base path used to derive the custom artifact directory
 * @returns Resolution result, or undefined when the argument is not a plan artifact
 */
export const resolvePlanToken = (
  argument: string,
  trackerDir: string,
  repoBaseDir: string
): PlanTokenResolution | undefined => {
  const basename = path.basename(argument);
  const customDir = resolveCustomArtifactDir(repoBaseDir);
  const candidateDirs = [trackerDir, customDir];

  for (const dir of candidateDirs) {
    try {
      const resolved = resolvePlanArtifactReference(argument, { artifactDir: dir });
      if (resolved.ticketKey) return { kind: 'ticket', ticketKey: resolved.ticketKey };
      if (resolved.sourceKind === 'custom') {
        return {
          kind: 'custom',
          artifactPath: resolved.artifactPath,
          action: resolved.action,
          sourceName: resolved.sourceName,
        };
      }
    } catch {
      // fall through
    }

    const directPath = path.join(dir, basename);
    if (!fs.existsSync(directPath)) continue;

    const manifestPath = buildPlanArtifactManifestPath(directPath);
    const manifest = readPlanArtifactManifest(manifestPath);
    if (manifest?.ticketKey) return { kind: 'ticket', ticketKey: manifest.ticketKey };
    if (manifest?.sourceKind === 'custom') {
      return {
        kind: 'custom',
        artifactPath: directPath,
        action: manifest.action,
        sourceName: manifest.sourceName,
      };
    }
  }

  return undefined;
};

/**
 * Build a synthetic ticket artifact from a custom plan so downstream
 * stages (implement, review, commit) have a uniform `TicketArtifact` shape.
 *
 * @param planPath - Absolute path to the custom plan file
 * @param plan - Parsed plan content
 * @returns A ticket artifact synthesized from the plan metadata
 */
export const buildSyntheticTicketArtifact = (planPath: string, plan: ResolutionPlan): TicketArtifact => {
  const artifactName = path.basename(planPath, path.extname(planPath));
  const ticketKey = artifactName.replace(new RegExp(`-${plan.action}$`), '') || artifactName;

  const affected = normalizeFileEntries(plan.affectedFiles ?? []);
  const context = normalizeFileEntries(plan.affectedFilesContext ?? []);

  const content = [
    `# ${ticketKey}: ${plan.summary || 'Custom implementation'}`,
    '',
    `**Plan Artifact:** ${path.basename(planPath)}`,
    `**Action:** ${plan.action}`,
    '',
    '## Summary',
    '',
    plan.summary || 'Custom plan execution context synthesized from artifact.',
    '',
    '## Steps',
    '',
    ...(plan.steps.length > 0
      ? plan.steps.map((step, index) => `${index + 1}. ${step}`)
      : ['1. Follow the custom implementation plan']),
    '',
    '## Files Affected',
    '',
    ...(affected.length > 0 ? affected.map(e => `- ${e.filePath} (${e.status})`) : ['- (none listed)']),
    '',
    ...(context.length > 0
      ? ['## Files for Context (Read-Only)', '', ...context.map(e => `- ${e.filePath} (${e.status})`), '']
      : []),
    '## Risks',
    '',
    ...((plan.risks ?? []).length > 0
      ? (plan.risks ?? []).map(risk => `- ${risk}`)
      : ['- Synthetic execution context derived from custom plan artifact']),
  ].join('\n');

  return { ticketKey, content, path: planPath };
};
