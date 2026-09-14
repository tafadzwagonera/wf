import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';
import { type ResolutionPlan, type FileEntry, normalizeFileEntries } from '../../integrations/ai/ai.service';
import { planPhaseSchema } from '../schemas/ai.schema';
import type { ResolutionAction, TicketArtifact } from '../types/agent.types';
import { resolveCustomArtifactDir } from '../../agents/utils';
import type { PlanArtifactManifest, PlanArtifactReference, PlanTokenResolution } from '../types/plan-artifact.types';
import { hashGeneratedTicketSources } from './generated-ticket-artifact';
import { normalizePlanVerification } from './verification-manifest';
import { PlanArtifactNotFoundError, AmbiguousPlanArtifactError, ValidationError, WorkflowParseError } from '../errors/app.error';

export type { PlanArtifactManifest, PlanArtifactReference } from '../types/plan-artifact.types';

export const deriveReviewArtifactPath = (ticketPath: string, repoScope?: string): string => {
  const ext = path.extname(ticketPath);
  const stem = ext ? ticketPath.slice(0, -ext.length) : ticketPath;
  const suffix = repoScope ? `-${repoScope}-review.md` : '-review.md';
  return stem + suffix;
};

const VALID_ACTIONS: Set<string> = new Set(['feature', 'fix', 'investigate']);
const VALID_COMPLEXITIES = ['low', 'medium', 'high'] as const;
const PLAN_ARTIFACT_MANIFEST_EXTENSION = '.sources.json';
const PLAN_ARTIFACT_EXTENSIONS = ['json', 'md', 'yaml', 'yml'] as const;
export const CANONICAL_PLAN_STEM = /^(\d{4}-\d{2}-\d{2})-([a-f0-9]+)-(feature|fix|investigate)-plan$/i;
const SHORT_HASHED_PLAN_STEM = /^([a-f0-9]+)-(feature|fix|investigate)-plan$/i;

export const isPlanToken = (value: string): boolean => CANONICAL_PLAN_STEM.test(value.replace(/\.[^.]+$/, ''));

type PlanComplexity = (typeof VALID_COMPLEXITIES)[number];
type PlanArtifactFormat = 'json' | 'md' | 'yaml' | 'yml';

export type PlanArtifactSourceKind = 'ticket' | 'custom';

export interface BuildPlanArtifactManifestOptions {
  artifactPath: string;
  action: ResolutionAction;
  format: PlanArtifactFormat;
  hash: string;
  sourceName: string;
  sourceKind: PlanArtifactSourceKind;
  createdAt: Date;
  trackerName?: string;
  figmaLinks?: string[];
}

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

export const buildPlanArtifactResolutionNotice = (
  reference: BuildPlanArtifactResolutionNoticeOptions
): string | null => {
  if (reference.isLegacy) {
    return null;
  }

  let sourceLabel = `source ${reference.sourceName ?? path.basename(reference.artifactPath)}`;
  if (reference.ticketKey) sourceLabel = `ticket ${reference.ticketKey}`;
  else if (reference.customArtifactName) sourceLabel = `custom plan ${reference.customArtifactName}`;

  return `Detected plan artifact ${path.basename(reference.artifactPath)} for ${sourceLabel}; using action ${reference.action}.`;
};

export const SUPPORTED_PLAN_EXTENSIONS = ['json', 'md', 'yaml', 'yml'] as const;

const looksLikeTicketKey = (value: string): boolean => /^[A-Z]+-\d+$/i.test(value);

export const hashPlanArtifactSources = (sources: string[]): string => hashGeneratedTicketSources(sources);

export const buildPlanArtifactFilename = (options: BuildPlanArtifactFilenameOptions): string =>
  `${resolveDatePrefix(options.createdAt)}-${options.hash
    .trim()
    .toLowerCase()}-${options.action}-plan.${normalizeFormat(options.format)}`;

export const buildPlanArtifactManifestFilename = (artifactFilename: string): string => {
  const extensionlessArtifact = artifactFilename.replace(/\.[^.]+$/, '');
  return `${extensionlessArtifact}${PLAN_ARTIFACT_MANIFEST_EXTENSION}`;
};

export const buildPlanArtifactManifestPath = (artifactPath: string): string =>
  path.join(path.dirname(artifactPath), buildPlanArtifactManifestFilename(path.basename(artifactPath)));

export const buildPlanArtifactManifest = (options: BuildPlanArtifactManifestOptions): PlanArtifactManifest => ({
  artifactPath: options.artifactPath,
  action: options.action,
  createdAt: options.createdAt.toISOString(),
  format: normalizeFormat(options.format) as PlanArtifactFormat,
  hash: options.hash.trim().toLowerCase(),
  sourceKind: options.sourceKind,
  sourceName: options.sourceName,
  ticketKey: options.sourceKind === 'ticket' ? options.sourceName : undefined,
  customArtifactName: options.sourceKind === 'custom' ? options.sourceName : undefined,
  trackerName: options.trackerName,
  figmaLinks: options.figmaLinks,
});

export const writePlanArtifactManifest = (manifest: PlanArtifactManifest): string => {
  const manifestPath = buildPlanArtifactManifestPath(manifest.artifactPath);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return manifestPath;
};

const hasRequiredManifestStrings = (value: Partial<PlanArtifactManifest>): boolean =>
  typeof value.artifactPath === 'string'
  && typeof value.action === 'string'
  && typeof value.createdAt === 'string'
  && typeof value.format === 'string'
  && typeof value.hash === 'string'
  && typeof value.sourceKind === 'string'
  && typeof value.sourceName === 'string';

const buildOptionalManifestFields = (value: Partial<PlanArtifactManifest>) => ({
  ticketKey: typeof value.ticketKey === 'string' ? value.ticketKey : undefined,
  customArtifactName: typeof value.customArtifactName === 'string' ? value.customArtifactName : undefined,
  trackerName: typeof value.trackerName === 'string' ? value.trackerName : undefined,
  sourceBranch: typeof value.sourceBranch === 'string' ? value.sourceBranch : undefined,
  branchName: typeof value.branchName === 'string' ? value.branchName : undefined,
  figmaLinks: Array.isArray(value.figmaLinks) ? value.figmaLinks : undefined,
});

const buildValidatedManifest = (
  value: Partial<PlanArtifactManifest>, format: PlanArtifactFormat
): PlanArtifactManifest => ({
  artifactPath: value.artifactPath as string,
  action: value.action as ResolutionAction,
  createdAt: value.createdAt as string,
  format,
  hash: value.hash as string,
  sourceKind: value.sourceKind as PlanArtifactSourceKind,
  sourceName: value.sourceName as string,
  ...buildOptionalManifestFields(value),
});

const parseManifestFields = (value: Partial<PlanArtifactManifest>): PlanArtifactManifest | null => {
  if (!hasRequiredManifestStrings(value)) return null;
  if (!VALID_ACTIONS.has(value.action as string)) return null;
  if (value.sourceKind !== 'ticket' && value.sourceKind !== 'custom') return null;
  const format = normalizeFormat(value.format as string) as PlanArtifactFormat;
  if (format !== 'json' && format !== 'md' && format !== 'yaml' && format !== 'yml') return null;
  return buildValidatedManifest(value, format);
};

export const readPlanArtifactManifest = (manifestPath: string): PlanArtifactManifest | null => {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Partial<PlanArtifactManifest>;
    return parseManifestFields(value);
  } catch {
    return null;
  }
};

/**
 * Records the branch a feature branch was actually created from — and the feature branch's
 * own name — onto its plan's manifest, so later stages (e.g. the SonarQube review fallback)
 * can diff against the real base instead of re-guessing it from branch-name heuristics, and
 * can find this manifest by branch name when no ticket key identifies it (custom plans).
 * Each field is write-once independently: an already-recorded value is left untouched, but a
 * manifest missing just one of the two (e.g. an older manifest with `sourceBranch` recorded
 * before `branchName` tracking existed) still gets the other backfilled.
 *
 * @param artifactPath - Path to the plan artifact whose manifest should be updated
 * @param sourceBranch - The branch the feature branch was created from
 * @param branchName - The feature branch's own name
 */
export const updatePlanArtifactManifestSourceBranch = (
  artifactPath: string, sourceBranch: string, branchName?: string
): void => {
  const manifestPath = buildPlanArtifactManifestPath(artifactPath);
  const existing = readPlanArtifactManifest(manifestPath);
  if (!existing) return;
  const nextSourceBranch = existing.sourceBranch ?? sourceBranch;
  const nextBranchName = existing.branchName ?? branchName;
  if (nextSourceBranch === existing.sourceBranch && nextBranchName === existing.branchName) return;
  writePlanArtifactManifest({ ...existing, sourceBranch: nextSourceBranch, branchName: nextBranchName });
};

export const updatePlanArtifactManifestFigmaLinks = (
  artifactPath: string, figmaLinks: string[]
): void => {
  const manifestPath = buildPlanArtifactManifestPath(artifactPath);
  const existing = readPlanArtifactManifest(manifestPath);
  if (!existing || existing.figmaLinks?.length) return;
  writePlanArtifactManifest({ ...existing, figmaLinks });
};

export const readFigmaLinksFromPlanArtifact = (artifactPath: string): string[] | undefined => {
  if (!fs.existsSync(artifactPath)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as Record<string, unknown>;
    const links = value.figmaLinks;
    return Array.isArray(links) && links.length > 0 ? links.map(String) : undefined;
  } catch {
    return undefined;
  }
};

export const readUiDesignScreenshotsFromPlanArtifact = (artifactPath: string): string[] | undefined => {
  if (!fs.existsSync(artifactPath)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as Record<string, unknown>;
    const v = value.uiDesignScreenshots;
    return Array.isArray(v) && v.length > 0 ? v.map(String) : undefined;
  } catch {
    return undefined;
  }
};

const pickMostRecentManifest = (matches: PlanArtifactManifest[]): PlanArtifactManifest | undefined => {
  if (matches.length === 0) return undefined;
  return matches.reduce(
    (latest, candidate) => (candidate.createdAt > latest.createdAt ? candidate : latest),
    matches[0]
  );
};

/**
 * Finds the most recently created plan manifest recorded for `branchName`, across one or more
 * artifact directories. This is the only way to recover a custom plan's manifest during
 * review — custom plans have no ticket key to look them up by, unlike ticket-driven plans.
 *
 * @param branchName - Feature branch name to search for
 * @param artifactDirs - Directories to search (e.g. both the tracker dir and the custom dir)
 * @returns The matching manifest, or undefined if none is recorded
 */
export const findPlanArtifactManifestByBranchName = (
  branchName: string,
  artifactDirs: string[]
): PlanArtifactManifest | undefined => {
  const candidates = artifactDirs.flatMap(dir => readManifestCandidates(dir));
  return pickMostRecentManifest(candidates.filter(manifest => manifest.branchName === branchName));
};

const normalizeFormat = (format: string): string =>
  format.trim().toLowerCase() === 'md' ? 'md' : format.trim().toLowerCase();

const stripArtifactExtension = (fileName: string): string => fileName.replace(/\.[^.]+$/, '');

const parseCanonicalStem = (stem: string): { datePrefix: string; hash: string; action: ResolutionAction } | null => {
  const match = CANONICAL_PLAN_STEM.exec(stem);
  if (!match) {
    return null;
  }

  const [, datePrefix, hash, action] = match;
  if (!hash || !action || !VALID_ACTIONS.has(action as ResolutionAction)) {
    return null;
  }

  return {
    datePrefix,
    hash: hash.toLowerCase(),
    action: action as ResolutionAction,
  };
};

const parseShortHashedStem = (stem: string): { hash: string; action: ResolutionAction } | null => {
  const match = SHORT_HASHED_PLAN_STEM.exec(stem);
  if (!match) {
    return null;
  }

  const [, hash, action] = match;
  if (!hash || !action || !VALID_ACTIONS.has(action as ResolutionAction)) {
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

const collectManifestIdentifierTokens = (manifest: PlanArtifactManifest): string[] => {
  const artifactStem = stripArtifactExtension(path.basename(manifest.artifactPath));
  return [manifest.hash, manifest.ticketKey, manifest.customArtifactName, manifest.sourceName, artifactStem]
    .filter((token): token is string => typeof token === 'string' && token.length > 0);
};

const matchesManifestIdentifier = (
  manifest: PlanArtifactManifest,
  identifierStem: string,
  normalizedIdentifier: string,
  requestedAction?: ResolutionAction
): boolean => {
  if (requestedAction && manifest.action !== requestedAction) return false;

  const sourceTokens = collectManifestIdentifierTokens(manifest);
  if (sourceTokens.some(token => token.trim().toLowerCase() === normalizedIdentifier)) return true;

  const parsedStem = parseCanonicalStem(identifierStem);
  return parsedStem ? manifest.hash.toLowerCase() === parsedStem.hash : false;
};

const isCanonicalArtifactPath = (artifactPath: string): boolean => {
  const extension = path.extname(artifactPath).slice(1).toLowerCase();
  if (!PLAN_ARTIFACT_EXTENSIONS.includes(extension as (typeof PLAN_ARTIFACT_EXTENSIONS)[number])) {
    return false;
  }

  const artifactStem = stripArtifactExtension(path.basename(artifactPath));
  return parseCanonicalStem(artifactStem) !== null;
};

const buildManifestReference = (selected: PlanArtifactManifest): PlanArtifactReference => ({
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
});

const assertUnambiguousCandidates = (candidates: PlanArtifactManifest[], identifierStem: string): void => {
  if (candidates.length <= 1) return;
  throw new AmbiguousPlanArtifactError(
    `Multiple plan artifacts found for '${identifierStem}': ${candidates
      .map(candidate => path.basename(candidate.artifactPath))
      .join(', ')}. Remove or regenerate the stale artifact.`
  );
};

const resolveManifestMatch = (
  artifactDir: string,
  identifierStem: string,
  requestedAction?: ResolutionAction
): PlanArtifactReference | null => {
  const normalizedIdentifier = identifierStem.trim().toLowerCase();
  const candidates = readManifestCandidates(artifactDir).filter(
    manifest =>
      isCanonicalArtifactPath(manifest.artifactPath)
      && matchesManifestIdentifier(manifest, identifierStem, normalizedIdentifier, requestedAction)
  );
  if (candidates.length === 0) return null;
  assertUnambiguousCandidates(candidates, identifierStem);
  return buildManifestReference(candidates[0]);
};

const buildNotFoundCandidateList = (identifierStem: string, requestedAction?: ResolutionAction): string[] =>
  requestedAction && looksLikeTicketKey(identifierStem)
    ? PLAN_ARTIFACT_EXTENSIONS.map(
        extension => `YYYY-MM-DD-${hashPlanArtifactSources([identifierStem])}-${requestedAction}-plan.${extension}`
      )
    : ['YYYY-MM-DD-<hash>-<action>-plan.<ext>'];

const assertCanonicalIdentifier = (identifier: string, identifierStem: string): void => {
  if (!parseShortHashedStem(identifierStem)) return;
  throw new ValidationError(`Non-canonical plan identifier '${identifier}'. Use YYYY-MM-DD-<hash>-<action>-plan.<ext>.`);
};

export const resolvePlanArtifactReference = (
  identifier: string,
  options: ResolvePlanArtifactOptions
): PlanArtifactReference => {
  const identifierStem = stripArtifactExtension(path.basename(identifier.trim()));
  assertCanonicalIdentifier(identifier, identifierStem);
  const requestedAction = resolveActionFromIdentifier(identifierStem, options.action);
  const manifestMatch = resolveManifestMatch(options.artifactDir, identifierStem, requestedAction);
  if (manifestMatch) return manifestMatch;
  const candidateList = buildNotFoundCandidateList(identifierStem, requestedAction);
  throw new PlanArtifactNotFoundError(
    `Plan artifact not found for '${identifier}' in ${options.artifactDir}. Checked: ${candidateList.join(', ')}`
  );
};

const resolveDatePrefix = (createdAt?: Date | string): string => {
  let date = new Date();
  if (createdAt instanceof Date) date = createdAt;
  else if (typeof createdAt === 'string') date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`Invalid createdAt value for plan artifact: ${createdAt}`);
  }
  return date.toISOString().slice(0, 10);
};

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

  throw new WorkflowParseError(`Unsupported plan file format: ${filePath}`);
};

export const getPlanArtifactExtension = (format: PlanArtifactFormat): PlanArtifactFormat => format;

const normalizePlanPhases = (rawPlan: Record<string, unknown>): ResolutionPlan['phases'] => {
  if (!Array.isArray(rawPlan.phases)) return undefined;
  return rawPlan.phases.flatMap((entry: unknown) => {
    const parsed = planPhaseSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
};

const normalizeCorePlanFields = (rawPlan: Record<string, unknown>, filePath: string) => ({
  action: normalizeAction(rawPlan.action, filePath),
  summary: typeof rawPlan.summary === 'string' ? rawPlan.summary : '',
  steps: normalizeStringList(rawPlan.steps),
  estimatedComplexity: normalizeComplexity(rawPlan.estimatedComplexity, filePath),
  affectedFiles: normalizeFileEntryList(rawPlan.affectedFiles ?? rawPlan.filesAffected),
  affectedFilesContext: normalizeFileEntryList(rawPlan.affectedFilesContext ?? rawPlan.filesContext),
});

const normalizeExtraPlanFields = (rawPlan: Record<string, unknown>, filePath: string) => ({
  affectedRepositories: normalizeOptionalStringList(rawPlan.affectedRepositories ?? rawPlan.repositoriesAffected),
  newRepositories: normalizeOptionalStringList(rawPlan.newRepositories),
  risks: normalizeOptionalStringList(rawPlan.risks),
  verification: normalizePlanVerification(rawPlan.verification, filePath),
  provider: typeof rawPlan.provider === 'string' ? rawPlan.provider : undefined,
  source: typeof rawPlan.source === 'string' ? rawPlan.source : undefined,
  timestamp: typeof rawPlan.timestamp === 'string' ? rawPlan.timestamp : undefined,
  phases: normalizePlanPhases(rawPlan),
});

const normalizePlan = (value: unknown, filePath: string): ResolutionPlan => {
  if (!value || typeof value !== 'object') {
    throw new WorkflowParseError(`Plan file is not valid: ${filePath}`);
  }
  const rawPlan = value as Record<string, unknown>;
  return { ...normalizeCorePlanFields(rawPlan, filePath), ...normalizeExtraPlanFields(rawPlan, filePath) };
};

interface ParsedMarkdownPlan {
  sections: Map<string, string[]>;
  metadata: Map<string, string>;
}

const consumeMarkdownPlanLine = (line: string, parsed: ParsedMarkdownPlan, activeSection: string): string => {
  const metadataMatch = /^\*\*([^:]+):\*\*\s*(.+)$/.exec(line);
  if (metadataMatch) {
    parsed.metadata.set(metadataMatch[1].trim().toLowerCase(), metadataMatch[2].trim());
    return activeSection;
  }
  const headingMatch = /^##\s+(.+)$/.exec(line);
  if (headingMatch) {
    const nextSection = headingMatch[1].trim().toLowerCase();
    parsed.sections.set(nextSection, []);
    return nextSection;
  }
  if (activeSection) parsed.sections.get(activeSection)?.push(line);
  return activeSection;
};

const parseMarkdownSections = (content: string): ParsedMarkdownPlan => {
  const parsed: ParsedMarkdownPlan = { sections: new Map(), metadata: new Map() };
  let activeSection = '';
  for (const line of content.split('\n')) {
    activeSection = consumeMarkdownPlanLine(line, parsed, activeSection);
  }
  return parsed;
};

const buildMarkdownPlanFields = (sections: Map<string, string[]>, metadata: Map<string, string>) => ({
  action: metadata.get('action'),
  estimatedComplexity: metadata.get('complexity'),
  summary: collapseSection(sections.get('summary')),
  steps: extractNumberedList(sections.get('steps')),
  affectedFiles: extractBulletedList(sections.get('files affected')),
  affectedRepositories: extractBulletedList(
    sections.get('affected repositories') ?? sections.get('repositories affected')
  ),
  newRepositories: extractBulletedList(sections.get('new repositories')),
  risks: extractBulletedList(sections.get('risks')),
});

const parseMarkdownPlan = (content: string, filePath: string): ResolutionPlan => {
  const { sections, metadata } = parseMarkdownSections(content);
  return normalizePlan(buildMarkdownPlanFields(sections, metadata), filePath);
};

const collapseSection = (lines?: string[]): string => (lines ?? []).join('\n').trim();

const extractNumberedList = (lines?: string[]): string[] =>
  (lines ?? []).map(line => (/^\d+\.\s+(.+)$/.exec(line))?.[1]?.trim() ?? '').filter(Boolean);

const extractBulletedList = (lines?: string[]): string[] =>
  (lines ?? []).map(line => (/^-\s+(.+)$/.exec(line))?.[1]?.trim() ?? '').filter(Boolean);

const normalizeAction = (value: unknown, filePath: string): ResolutionAction => {
  if (typeof value === 'string' && VALID_ACTIONS.has(value as ResolutionAction)) {
    return value as ResolutionAction;
  }

  throw new WorkflowParseError(`Plan file has an invalid action: ${filePath}`);
};

const normalizeComplexity = (value: unknown, filePath: string): PlanComplexity => {
  if (value === undefined || value === null || value === '') {
    return 'medium';
  }

  if (typeof value === 'string' && VALID_COMPLEXITIES.includes(value as PlanComplexity)) {
    return value as PlanComplexity;
  }

  throw new WorkflowParseError(`Plan file has an invalid complexity: ${filePath}`);
};

const normalizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(String);
};

const normalizeOptionalStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map(String);
};

const isFileEntry = (item: unknown): item is FileEntry =>
  typeof item === 'object' && item !== null && 'filePath' in item;

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
 * Resolve a plan token against the tracker and custom artifact directories.
 *
 * An ambiguous match in one directory intentionally aborts before the next
 * directory is checked, rather than falling through to a possibly-unrelated
 * match — genuine ambiguity must surface as an error, not be silently
 * resolved by trying elsewhere.
 */
const planTokenFromReference = (resolved: PlanArtifactReference): PlanTokenResolution | undefined => {
  if (resolved.ticketKey) return { kind: 'ticket', ticketKey: resolved.ticketKey };
  if (resolved.sourceKind === 'custom') {
    return {
      kind: 'custom', artifactPath: resolved.artifactPath, action: resolved.action, sourceName: resolved.sourceName,
    };
  }
  return undefined;
};

const planTokenFromDirectManifest = (dir: string, basename: string): PlanTokenResolution | undefined => {
  const directPath = path.join(dir, basename);
  if (!fs.existsSync(directPath)) return undefined;
  const manifest = readPlanArtifactManifest(buildPlanArtifactManifestPath(directPath));
  if (manifest?.ticketKey) return { kind: 'ticket', ticketKey: manifest.ticketKey };
  if (manifest?.sourceKind === 'custom') {
    return { kind: 'custom', artifactPath: directPath, action: manifest.action, sourceName: manifest.sourceName };
  }
  return undefined;
};

const resolvePlanTokenInDir = (argument: string, dir: string, basename: string): PlanTokenResolution | undefined => {
  try {
    const fromReference = planTokenFromReference(resolvePlanArtifactReference(argument, { artifactDir: dir }));
    if (fromReference) return fromReference;
  } catch (error) {
    if (error instanceof AmbiguousPlanArtifactError) throw error;
    // fall through to the direct-manifest lookup below
  }
  return planTokenFromDirectManifest(dir, basename);
};

export const resolvePlanToken = (
  argument: string,
  trackerDir: string,
  repoBaseDir: string
): PlanTokenResolution | undefined => {
  const basename = path.basename(argument);
  const candidateDirs = [trackerDir, resolveCustomArtifactDir(repoBaseDir)];
  for (const dir of candidateDirs) {
    const found = resolvePlanTokenInDir(argument, dir, basename);
    if (found) return found;
  }
  return undefined;
};

const deriveSyntheticTicketKey = (planPath: string, action: ResolutionAction): string => {
  const artifactName = path.basename(planPath, path.extname(planPath));
  return artifactName.replace(new RegExp(`-${action}$`), '') || artifactName;
};

const buildSyntheticStepsSection = (plan: ResolutionPlan): string[] => [
  '## Steps',
  '',
  ...(plan.steps.length > 0
    ? plan.steps.map((step, index) => `${index + 1}. ${step}`)
    : ['1. Follow the custom implementation plan']),
];

const buildSyntheticFilesSection = (plan: ResolutionPlan): string[] => {
  const affected = normalizeFileEntries(plan.affectedFiles ?? []);
  const context = normalizeFileEntries(plan.affectedFilesContext ?? []);
  return [
    '## Files Affected',
    '',
    ...(affected.length > 0 ? affected.map(e => `- ${e.filePath} (${e.status})`) : ['- (none listed)']),
    '',
    ...(context.length > 0
      ? ['## Files for Context (Read-Only)', '', ...context.map(e => `- ${e.filePath} (${e.status})`), '']
      : []),
  ];
};

const buildSyntheticRisksSection = (plan: ResolutionPlan): string[] => [
  '## Risks',
  '',
  ...((plan.risks ?? []).length > 0
    ? (plan.risks ?? []).map(risk => `- ${risk}`)
    : ['- Synthetic execution context derived from custom plan artifact']),
];

const buildSyntheticHeaderSection = (ticketKey: string, planPath: string, plan: ResolutionPlan): string[] => [
  `# ${ticketKey}: ${plan.summary || 'Custom implementation'}`,
  '',
  `**Plan Artifact:** ${path.basename(planPath)}`,
  `**Action:** ${plan.action}`,
  '',
  '## Summary',
  '',
  plan.summary || 'Custom plan execution context synthesized from artifact.',
];

export const buildSyntheticTicketArtifact = (planPath: string, plan: ResolutionPlan): TicketArtifact => {
  const ticketKey = deriveSyntheticTicketKey(planPath, plan.action);
  const content = [
    ...buildSyntheticHeaderSection(ticketKey, planPath, plan),
    '',
    ...buildSyntheticStepsSection(plan),
    '',
    ...buildSyntheticFilesSection(plan),
    ...buildSyntheticRisksSection(plan),
  ].join('\n');

  return { ticketKey, content, path: planPath };
};
