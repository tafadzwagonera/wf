import * as fs from 'fs';
import * as path from 'path';
import type {
  PriorPlanContext,
  PriorPlanSummary,
  PriorTicketContext,
  PriorTicketSummary,
} from '../types/detection.types';
import type { FileEntry, ResolutionPlan } from '../types/ai.types';
import {
  CANONICAL_PLAN_STEM,
  parsePlanArtifact,
  readPlanArtifactManifest,
  buildPlanArtifactManifestPath,
} from './plan-artifact';
import { COMPONENT_NAME_REGEX, ERROR_PATTERN_REGEX, FILE_PATH_REGEX } from './detect-prior-tickets';
import { getWfHomeDir } from './wf-paths';

export type { PriorPlanContext, PriorPlanSummary };

const DEFAULT_LIMIT = 10;
const EXTRACT_MAX_CHARS = 5000;
const FORMAT_MAX_PLANS = 5;
const FORMAT_MAX_CHARS = 3000;

const isFileEntry = (value: string | FileEntry): value is FileEntry =>
  typeof value === 'object' && value !== null && 'filePath' in value && typeof value.filePath === 'string';

const extractAffectedFilePaths = (affectedFiles?: (string | FileEntry)[]): string[] =>
  (affectedFiles ?? []).map(entry => (isFileEntry(entry) ? entry.filePath : entry));

/**
 * Extract keywords from a persisted plan artifact.
 *
 * `ticketKey === null` is intentional for plans without manifests: they still
 * appear in plan prompts, but merged recurrence candidates remain keyless so
 * downstream commit enrichment skips commit lookup for them.
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
 * Detect prior plan artifacts from `~/.wf/<repoName>/` tracker subdirectories.
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

  const planFiles: Array<{ filePath: string; mtime: number }> = [];

  try {
    const trackerEntries = fs.readdirSync(repoDir, { withFileTypes: true });

    for (const trackerEntry of trackerEntries) {
      if (!trackerEntry.isDirectory()) continue;

      const trackerDir = path.join(repoDir, trackerEntry.name);

      try {
        const fileEntries = fs.readdirSync(trackerDir);

        for (const fileName of fileEntries) {
          const stem = fileName.replace(/\.[^.]+$/, '');
          if (!CANONICAL_PLAN_STEM.test(stem)) {
            continue;
          }

          const filePath = path.join(trackerDir, fileName);

          try {
            const stat = fs.statSync(filePath);
            planFiles.push({ filePath, mtime: stat.mtimeMs });
          } catch {
            // skip unreadable stat
          }
        }
      } catch {
        // skip unreadable tracker dir
      }
    }
  } catch {
    return { plans: [], repoName };
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

const createSyntheticPriorTicketSummary = (plan: PriorPlanSummary): PriorTicketSummary => ({
  title: plan.summary,
  summary: plan.summary,
  filename: plan.filename,
  keywords: plan.keywords,
  ticketKey: plan.ticketKey,
});

/**
 * Merge plan-derived summaries into the prior-ticket recurrence context.
 *
 * When a plan has no manifest-derived `ticketKey`, it cannot be deduplicated
 * against ticket descriptions and remains as a keyless recurrence candidate.
 *
 * @param tickets - Existing prior ticket context
 * @param plans - Prior plan context
 * @returns Ticket context enriched with plan summaries
 */
export const mergePriorContexts = (tickets: PriorTicketContext, plans: PriorPlanContext): PriorTicketContext => {
  if (plans.plans.length === 0) {
    return tickets;
  }

  const ticketKeyToSummary = new Map<string, PriorTicketSummary>();
  const existingFilenames = new Set(tickets.tickets.map(ticket => ticket.filename));
  const mergedTickets = [...tickets.tickets];

  for (const ticket of tickets.tickets) {
    const ticketKeyMatch = ticket.filename.match(/^([A-Z]+-\d+)/);
    if (!ticketKeyMatch?.[1]) continue;
    ticketKeyToSummary.set(ticketKeyMatch[1], ticket);
  }

  for (const plan of plans.plans) {
    if (existingFilenames.has(plan.filename)) {
      continue;
    }
    if (plan.ticketKey && ticketKeyToSummary.has(plan.ticketKey)) {
      continue;
    }

    const syntheticTicket = createSyntheticPriorTicketSummary(plan);
    mergedTickets.push(syntheticTicket);
    existingFilenames.add(plan.filename);

    if (plan.ticketKey) {
      ticketKeyToSummary.set(plan.ticketKey, syntheticTicket);
    }
  }

  return {
    tickets: mergedTickets,
    repoName: tickets.repoName,
  };
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
