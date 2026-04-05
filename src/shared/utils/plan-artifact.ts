import { ResolutionPlan } from '../../integrations/ai/ai.service';
import type { ResolutionAction } from '../../agents/interfaces';
import * as YAML from 'yaml';
import * as path from 'path';

const VALID_ACTIONS: ResolutionAction[] = ['feature', 'fix', 'investigate'];
const VALID_COMPLEXITIES = ['low', 'medium', 'high'] as const;

type PlanComplexity = (typeof VALID_COMPLEXITIES)[number];

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
  format: 'json' | 'md' | 'yaml',
): 'json' | 'md' | 'yaml' => format;

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
