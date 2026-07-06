import * as fs from 'fs';
import * as path from 'path';
import type {
  PlanCorrelationMatch,
  PlanCorrelationResult,
  PriorPlanContext,
  PriorPlanSummary,
  SourceSnippet,
} from '../types/detection.types';
import type { FileEntry, ResolutionPlan } from '../types/ai.types';
import {
  CANONICAL_PLAN_STEM,
  parsePlanArtifact,
  readPlanArtifactManifest,
  buildPlanArtifactManifestPath,
} from './plan-artifact';
import { getWfHomeDir } from './wf-paths';
import { collectWfArtifactFiles } from './collect-wf-artifact-files';

export type { PriorPlanContext, PriorPlanSummary, PlanCorrelationMatch, PlanCorrelationResult };

export const FILE_PATH_REGEX = /[\w-/]+(?:\.[\w-]+)+/g;
export const COMPONENT_NAME_REGEX = /\b[A-Z][a-zA-Z]+(?:Service|Controller|Module|Agent|Command|Guard|Interceptor)\b/g;
export const ERROR_PATTERN_REGEX = /\b(?:Error|Exception|ENOENT|ECONNREFUSED|timeout|deadlock|race condition)\b/gi;

const DEFAULT_LIMIT = 10;
const EXTRACT_MAX_CHARS = 5000;
const FORMAT_MAX_PLANS = 5;
const FORMAT_MAX_CHARS = 3000;
const FORMAT_CORRELATION_MAX_MATCHES = 5;
const FORMAT_CORRELATION_MAX_CHARS = 5000;

export interface CorrelateOptions {
  jaccardThreshold?: number;
  maxMatches?: number;
  maxFiles?: number;
  maxLinesPerFile?: number;
  maxTotalChars?: number;
}

const isFileEntry = (value: string | FileEntry): value is FileEntry =>
  typeof value === 'object' && value !== null && 'filePath' in value && typeof value.filePath === 'string';

const extractAffectedFilePaths = (affectedFiles?: (string | FileEntry)[]): string[] =>
  (affectedFiles ?? []).map(entry => (isFileEntry(entry) ? entry.filePath : entry));

/**
 * Extract keywords from arbitrary text content.
 *
 * @param text - Raw text to extract keywords from
 * @returns Deduplicated file paths, component names, and error patterns
 */
export const extractContentKeywords = (text: string): string[] => {
  const bounded = text.slice(0, EXTRACT_MAX_CHARS);
  const filePaths = bounded.match(FILE_PATH_REGEX) ?? [];
  const componentNames = bounded.match(COMPONENT_NAME_REGEX) ?? [];
  const errorPatterns = bounded.match(ERROR_PATTERN_REGEX) ?? [];
  return [...new Set([...filePaths, ...componentNames, ...errorPatterns])];
};

/**
 * Extract keywords from a persisted plan artifact.
 *
 * @param plan - Parsed plan artifact
 * @returns Deduplicated file, component, and error keywords
 */
export const extractPlanKeywords = (plan: ResolutionPlan): string[] => {
  const affectedFilePaths = extractAffectedFilePaths(plan.affectedFiles);
  const combined = [plan.summary, ...(plan.steps ?? []), ...affectedFilePaths, ...(plan.risks ?? [])]
    .join(' ')
    .slice(0, EXTRACT_MAX_CHARS);

  const filePaths = combined.match(FILE_PATH_REGEX) ?? [];
  const componentNames = combined.match(COMPONENT_NAME_REGEX) ?? [];
  const errorPatterns = combined.match(ERROR_PATTERN_REGEX) ?? [];

  return [...new Set([...affectedFilePaths, ...filePaths, ...componentNames, ...errorPatterns])];
};

/**
 * Detect prior plan artifacts from anywhere under `~/.wf/<repoName>/`.
 *
 * @param repoName - Repository name under the wf home directory
 * @param opts - Optional detection settings
 * @param opts.limit - Maximum number of plans to return
 * @returns Prior plan context; never throws
 */
export const detectPriorPlans = (repoName: string, opts?: { limit?: number }): PriorPlanContext => {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const repoDir = path.join(getWfHomeDir(), repoName);

  if (!fs.existsSync(repoDir)) {
    return { plans: [], repoName };
  }

  const planPaths = collectWfArtifactFiles(repoDir, (_filePath, fileName) => {
    const stem = fileName.replace(/\.[^.]+$/, '');
    return CANONICAL_PLAN_STEM.test(stem);
  });
  const planFiles: Array<{ filePath: string; mtime: number }> = [];

  for (const filePath of planPaths) {
    try {
      const stat = fs.statSync(filePath);
      planFiles.push({ filePath, mtime: stat.mtimeMs });
    } catch {
      // skip unreadable stat
    }
  }

  planFiles.sort((a, b) => b.mtime - a.mtime);

  const plans: PriorPlanSummary[] = [];

  for (const { filePath } of planFiles.slice(0, limit)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const plan = parsePlanArtifact(raw, filePath);
      const manifest = readPlanArtifactManifest(buildPlanArtifactManifestPath(filePath));
      const keywords = extractPlanKeywords(plan);

      plans.push({
        title: plan.summary,
        summary: plan.summary,
        filename: path.basename(filePath),
        artifactPath: filePath,
        keywords,
        steps: plan.steps,
        action: plan.action,
        estimatedComplexity: plan.estimatedComplexity,
        ticketKey: manifest?.ticketKey ?? null,
      });
    } catch {
      // skip unreadable or invalid plan artifact
    }
  }

  return { plans, repoName };
};

/**
 * Format prior plans into an AI prompt section.
 *
 * @param ctx - Prior plan context
 * @returns Prompt section or an empty string when no plans were found
 */
export const formatPriorPlansPromptSection = (ctx: PriorPlanContext): string => {
  if (ctx.plans.length === 0) {
    return '';
  }

  const lines: string[] = [`Related prior plans (${ctx.repoName}):`];

  for (const plan of ctx.plans.slice(0, FORMAT_MAX_PLANS)) {
    const metadata: string[] = [];
    if (plan.estimatedComplexity) {
      metadata.push(`complexity: ${plan.estimatedComplexity}`);
    }
    if (plan.keywords.length > 0) {
      metadata.push(`keywords: ${plan.keywords.join(', ')}`);
    }

    const suffix = metadata.length > 0 ? ` (${metadata.join(', ')})` : '';
    lines.push(`- [${plan.action}] ${plan.summary}${suffix}`);

    if (plan.steps?.length) {
      lines.push(`  Steps: ${plan.steps.map((step, index) => `${index + 1}. ${step}`).join('; ')}`);
    }
  }

  return lines.join('\n').slice(0, FORMAT_MAX_CHARS);
};

/**
 * Load detail from a plan artifact for a matched prior plan.
 */
const loadPlanDetails = (
  plan: PriorPlanSummary,
  repoDir: string,
  opts: { maxFiles: number; maxLinesPerFile: number; maxTotalChars: number; currentTotalChars: number }
): {
  affectedFiles?: string[];
  affectedFilesContext?: string[];
  risks?: string[];
  verification?: PlanCorrelationMatch['verification'];
  sourceSnippets: SourceSnippet[];
  totalChars: number;
} => {
  const snippets: SourceSnippet[] = [];
  let totalChars = opts.currentTotalChars;

  try {
    const raw = fs.readFileSync(plan.artifactPath, 'utf-8');
    const parsed = parsePlanArtifact(raw, plan.artifactPath);
    const affectedFiles = extractAffectedFilePaths(parsed.affectedFiles);
    const affectedFilesContext = parsed.affectedFilesContext as string[] | undefined;
    const risks = parsed.risks;
    const verification = parsed.verification;

    for (const filePath of affectedFiles.slice(0, opts.maxFiles)) {
      if (totalChars >= opts.maxTotalChars) break;

      const resolved = path.resolve(repoDir, filePath);
      if (!resolved.startsWith(path.resolve(repoDir))) continue;

      try {
        if (!fs.existsSync(resolved)) continue;

        const content = fs.readFileSync(resolved, 'utf-8');

        // Skip binary files (null byte in first 512 chars)
        if (content.slice(0, 512).includes('\0')) continue;

        const lines = content.split('\n').slice(0, opts.maxLinesPerFile).join('\n');
        const remaining = opts.maxTotalChars - totalChars;
        const capped = lines.slice(0, remaining);
        snippets.push({ filePath, content: capped });
        totalChars += capped.length;
      } catch {
        // skip unreadable source file
      }
    }

    return { affectedFiles, affectedFilesContext, risks, verification, sourceSnippets: snippets, totalChars };
  } catch {
    return { sourceSnippets: snippets, totalChars };
  }
};

/**
 * Correlate current content against prior plans using Jaccard keyword similarity.
 * For matches, loads full plan details and reads source files.
 *
 * @param currentContent - The current ticket/issue content
 * @param priorPlans - Prior plan context from detectPriorPlans
 * @param repoDir - Absolute path to the repository root
 * @param opts - Optional correlation settings
 * @returns Correlation result with matches; never throws
 */
export const correlatePlans = (
  currentContent: string,
  priorPlans: PriorPlanContext,
  repoDir: string,
  opts?: CorrelateOptions
): PlanCorrelationResult => {
  const jaccardThreshold = opts?.jaccardThreshold ?? 0.2;
  const maxMatches = opts?.maxMatches ?? 3;
  const maxFiles = opts?.maxFiles ?? 5;
  const maxLinesPerFile = opts?.maxLinesPerFile ?? 500;
  const maxTotalChars = opts?.maxTotalChars ?? 8000;

  const currentKeywords = extractContentKeywords(currentContent);
  const currentSet = new Set(currentKeywords);

  const scored: Array<{ plan: PriorPlanSummary; overlapScore: number; sharedKeywords: string[] }> = [];

  for (const plan of priorPlans.plans) {
    const priorSet = new Set(plan.keywords);
    const intersection = [...currentSet].filter(k => priorSet.has(k));
    const union = new Set([...currentSet, ...priorSet]);
    const overlapScore = union.size === 0 ? 0 : intersection.length / union.size;

    if (overlapScore >= jaccardThreshold) {
      scored.push({ plan, overlapScore, sharedKeywords: intersection });
    }
  }

  scored.sort((a, b) => b.overlapScore - a.overlapScore);

  const matches: PlanCorrelationMatch[] = [];
  let cumulativeChars = 0;

  for (const { plan, overlapScore, sharedKeywords } of scored.slice(0, maxMatches)) {
    const details = loadPlanDetails(plan, repoDir, {
      maxFiles,
      maxLinesPerFile,
      maxTotalChars,
      currentTotalChars: cumulativeChars,
    });
    cumulativeChars = details.totalChars;

    matches.push({
      summary: plan.summary,
      filename: plan.filename,
      action: plan.action,
      estimatedComplexity: plan.estimatedComplexity,
      overlapScore,
      sharedKeywords,
      matchSource: 'keyword',
      affectedFiles: details.affectedFiles,
      affectedFilesContext: details.affectedFilesContext,
      risks: details.risks,
      verification: details.verification,
      sourceSnippets: details.sourceSnippets,
    });
  }

  return { matches, repoName: priorPlans.repoName };
};

/**
 * Format plan correlation matches for AI prompt injection.
 *
 * @param result - Plan correlation result
 * @returns Formatted prompt section, or empty string when no matches
 */
export const formatPlanCorrelationPromptSection = (result: PlanCorrelationResult): string => {
  if (result.matches.length === 0) return '';

  const lines: string[] = [`Prior plan correlation (${result.repoName}):`];
  let totalChars = lines[0].length;

  for (const match of result.matches.slice(0, FORMAT_CORRELATION_MAX_MATCHES)) {
    if (totalChars >= FORMAT_CORRELATION_MAX_CHARS) break;

    const matchInfo = `(overlap: ${match.overlapScore.toFixed(2)}, shared: ${match.sharedKeywords.join(', ')})`;
    lines.push(`- [${match.action}] ${match.summary} ${matchInfo}`);

    if (match.affectedFiles?.length) {
      lines.push(`  Affected: ${match.affectedFiles.join(', ')}`);
    }

    if (match.risks?.length) {
      lines.push(`  Risks: ${match.risks.join('; ')}`);
    }

    for (const snippet of match.sourceSnippets) {
      const ext = path.extname(snippet.filePath).slice(1) || 'text';
      lines.push(`  Source (${snippet.filePath}):`);
      lines.push(`  \`\`\`${ext}`);
      lines.push(`  ${snippet.content}`);
      lines.push(`  \`\`\``);
    }

    totalChars = lines.join('\n').length;
  }

  return lines.join('\n').slice(0, FORMAT_CORRELATION_MAX_CHARS);
};
