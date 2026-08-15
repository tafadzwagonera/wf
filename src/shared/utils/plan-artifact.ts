import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { type ResolutionPlan, type FileEntry, normalizeFileEntries } from '../../integrations/ai/ai.service';
import { planPhaseSchema } from '../schemas/ai.schema';
import type { ResolutionAction, TicketArtifact } from '../../agents/interfaces';
import { resolveCustomArtifactDir } from '../../agents/utils';
import type { PlanArtifactManifest, PlanArtifactReference, PlanTokenResolution } from '../types/plan-artifact.types';
import { hashGeneratedTicketSources, matchesGeneratedTicketToken } from './generated-ticket-artifact';
import { normalizePlanVerification } from './verification-manifest';
import { PlanArtifactNotFoundError, ValidationError, WorkflowParseError } from '../errors/app.error';

export type { PlanArtifactManifest, PlanArtifactReference };

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

/* eslint-disable max-params */
// eslint-disable-next-line max-lines-per-function
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
/* eslint-enable max-params */

export const writePlanArtifactManifest = (manifest: PlanArtifactManifest): string => {
  const manifestPath = buildPlanArtifactManifestPath(manifest.artifactPath);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return manifestPath;
};

// eslint-disable-next-line max-lines-per-function
export const readPlanArtifactManifest = (manifestPath: string): PlanArtifactManifest | null => {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Partial<PlanArtifactManifest>;
    if (
      typeof value.artifactPath !== 'string'
      || typeof value.action !== 'string'
      || typeof value.createdAt !== 'string'
      || typeof value.format !== 'string'
      || typeof value.hash !== 'string'
      || typeof value.sourceKind !== 'string'
      || typeof value.sourceName !== 'string'
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
  const match = CANONICAL_PLAN_STEM.exec(stem);
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
  const match = SHORT_HASHED_PLAN_STEM.exec(stem);
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

// eslint-disable-next-line max-lines-per-function
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
        candidate === normalizedIdentifier
        || candidate === identifierStem.toLowerCase()
        || matchesGeneratedTicketToken(normalizedIdentifier, candidate)
        || matchesGeneratedTicketToken(identifierStem, candidate)
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

// eslint-disable-next-line max-lines-per-function
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

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length > 1) {
    throw new ValidationError(
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

// eslint-disable-next-line max-lines-per-function
export const resolvePlanArtifactReference = (
  identifier: string,
  options: ResolvePlanArtifactOptions
): PlanArtifactReference => {
  const artifactDir = options.artifactDir;
  const identifierStem = stripArtifactExtension(path.basename(identifier.trim()));
  const requestedAction = resolveActionFromIdentifier(identifierStem, options.action);
  if (parseShortHashedStem(identifierStem)) {
    throw new ValidationError(`Non-canonical plan identifier '${identifier}'. Use YYYY-MM-DD-<hash>-<action>-plan.<ext>.`);
  }

  const manifestMatch = resolveManifestMatch(artifactDir, identifierStem, requestedAction);
  if (manifestMatch) {
    return manifestMatch;
  }

  const candidateList
    = requestedAction && looksLikeTicketKey(identifierStem)
      ? PLAN_ARTIFACT_EXTENSIONS.map(
          extension => `YYYY-MM-DD-${hashPlanArtifactSources([identifierStem])}-${requestedAction}-plan.${extension}`
        )
      : ['YYYY-MM-DD-<hash>-<action>-plan.<ext>'];
  throw new PlanArtifactNotFoundError(
    `Plan artifact not found for '${identifier}' in ${artifactDir}. Checked: ${candidateList.join(', ')}`
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

// eslint-disable-next-line max-lines-per-function
const normalizePlan = (value: unknown, filePath: string): ResolutionPlan => {
  if (!value || typeof value !== 'object') {
    throw new WorkflowParseError(`Plan file is not valid: ${filePath}`);
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
    newRepositories: normalizeOptionalStringList(rawPlan.newRepositories),
    risks: normalizeOptionalStringList(rawPlan.risks),
    verification: normalizePlanVerification(rawPlan.verification, filePath),
    provider: typeof rawPlan.provider === 'string' ? rawPlan.provider : undefined,
    source: typeof rawPlan.source === 'string' ? rawPlan.source : undefined,
    timestamp: typeof rawPlan.timestamp === 'string' ? rawPlan.timestamp : undefined,
    phases: Array.isArray(rawPlan.phases)
      ? rawPlan.phases.flatMap((entry: unknown) => {
          const parsed = planPhaseSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
      : undefined,
  };
};

// eslint-disable-next-line max-lines-per-function
const parseMarkdownPlan = (content: string, filePath: string): ResolutionPlan => {
  const sections = new Map<string, string[]>();
  let activeSection = '';
  const metadata = new Map<string, string>();

  for (const line of content.split('\n')) {
    const metadataMatch = /^\*\*([^:]+):\*\*\s*(.+)$/.exec(line);
    if (metadataMatch) {
      metadata.set(metadataMatch[1].trim().toLowerCase(), metadataMatch[2].trim());
      continue;
    }

    const headingMatch = /^##\s+(.+)$/.exec(line);
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
      newRepositories: extractBulletedList(sections.get('new repositories')),
      risks: extractBulletedList(sections.get('risks')),
    },
    filePath
  );
};

const collapseSection = (lines?: string[]): string => (lines ?? []).join('\n').trim();

const extractNumberedList = (lines?: string[]): string[] =>
  (lines ?? []).map(line => (/^\d+\.\s+(.+)$/.exec(line))?.[1]?.trim() ?? '').filter(Boolean);

const extractBulletedList = (lines?: string[]): string[] =>
  (lines ?? []).map(line => (/^-\s+(.+)$/.exec(line))?.[1]?.trim() ?? '').filter(Boolean);

const normalizeAction = (value: unknown, filePath: string): ResolutionAction => {
  if (typeof value === 'string' && VALID_ACTIONS.includes(value as ResolutionAction)) {
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

// eslint-disable-next-line max-lines-per-function
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

// eslint-disable-next-line max-lines-per-function
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
