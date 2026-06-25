import simpleGit from 'simple-git';
import {
  extractTicketKeywords,
  PriorTicketContext,
} from './detect-prior-tickets';

export interface CommitEvidence {
  hash: string;
  message: string;
  filesChanged: string[];
}

export interface RecurrenceCandidate {
  title: string;
  summary: string;
  ticketKey: string | null;
  overlapScore: number;
  sharedKeywords: string[];
  commits: CommitEvidence[];
}

export interface RecurrenceGapAnalysis {
  isRecurrence: boolean;
  candidates: RecurrenceCandidate[];
  gaps: string[];
  rootCauseHypothesis: string | null;
}

interface AiExecutor {
  execute(request: {
    prompt: string;
    maxTokens?: number;
    stage?: string;
  }): Promise<{ content: string }>;
}

const TICKET_KEY_REGEX = /^([A-Z]+-\d+)/;
const CURRENT_CONTENT_MAX = 1500;
const CANDIDATE_SUMMARY_MAX = 500;
const MAX_CANDIDATES = 3;
const MAX_COMMITS = 5;
const JACCARD_THRESHOLD = 0.2;

/**
 * Filter prior tickets to find recurrence candidates using Jaccard similarity on keywords.
 *
 * @param currentContent - The current ticket content (markdown)
 * @param priorTickets - Context of prior tickets from the same repo
 * @returns Candidates with overlapScore >= 0.2, sorted by score descending
 */
export const filterRecurrenceCandidates = (
  currentContent: string,
  priorTickets: PriorTicketContext,
): RecurrenceCandidate[] => {
  const headingMatch = currentContent.match(/^#\s+(.+)/m);
  const title = headingMatch ? headingMatch[1].trim() : '';
  const body = headingMatch
    ? currentContent.slice(
        currentContent.indexOf(headingMatch[0]) + headingMatch[0].length,
      )
    : currentContent;

  const currentKeywords = extractTicketKeywords(title, body);
  const currentSet = new Set(currentKeywords);

  const candidates: RecurrenceCandidate[] = [];

  for (const ticket of priorTickets.tickets) {
    const priorSet = new Set(ticket.keywords);

    const intersection = [...currentSet].filter((k) => priorSet.has(k));
    const union = new Set([...currentSet, ...priorSet]);

    const overlapScore =
      union.size === 0 ? 0 : intersection.length / union.size;

    if (overlapScore < JACCARD_THRESHOLD) continue;

    const keyMatch = ticket.filename.match(TICKET_KEY_REGEX);
    const ticketKey = keyMatch ? keyMatch[1] : null;

    candidates.push({
      title: ticket.title,
      summary: ticket.summary,
      ticketKey,
      overlapScore,
      sharedKeywords: intersection,
      commits: [],
    });
  }

  candidates.sort((a, b) => b.overlapScore - a.overlapScore);

  return candidates;
};

/**
 * Enrich recurrence candidates with git commit history for each ticket key.
 *
 * @param candidates - Candidates from filterRecurrenceCandidates
 * @param repoDir - Absolute path to the git repository
 * @returns Candidates with commits populated; returns unchanged on git error
 */
export const enrichWithCommitHistory = async (
  candidates: RecurrenceCandidate[],
  repoDir: string,
): Promise<RecurrenceCandidate[]> => {
  try {
    const git = simpleGit(repoDir);

    const enriched: RecurrenceCandidate[] = [];

    for (const candidate of candidates) {
      if (!candidate.ticketKey) {
        enriched.push(candidate);
        continue;
      }

      try {
        const logResult = await git.raw([
          'log',
          '--all',
          `--grep=${candidate.ticketKey}`,
          '--format=%h %s',
        ]);

        const commitLines = logResult
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, MAX_COMMITS);

        const commitEvidences: CommitEvidence[] = [];

        for (const line of commitLines) {
          const spaceIdx = line.indexOf(' ');
          const hash = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
          const message = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);

          try {
            const diffResult = await git.raw([
              'diff-tree',
              '--no-commit-id',
              '-r',
              '--name-only',
              hash,
            ]);

            const filesChanged = diffResult
              .split('\n')
              .map((f) => f.trim())
              .filter(Boolean);

            commitEvidences.push({ hash, message, filesChanged });
          } catch {
            commitEvidences.push({ hash, message, filesChanged: [] });
          }
        }

        enriched.push({ ...candidate, commits: commitEvidences });
      } catch {
        enriched.push(candidate);
      }
    }

    return enriched;
  } catch {
    return candidates;
  }
};

/**
 * Analyze recurrence gaps using AI to identify what prior fixes missed.
 *
 * @param currentContent - The current ticket content
 * @param candidates - Enriched recurrence candidates
 * @param aiExecutor - AI executor with execute method
 * @returns RecurrenceGapAnalysis or null on failure
 */
export const analyzeRecurrenceGaps = async (
  currentContent: string,
  candidates: RecurrenceCandidate[],
  aiExecutor: AiExecutor,
): Promise<RecurrenceGapAnalysis | null> => {
  const topCandidates = candidates.slice(0, MAX_CANDIDATES);

  if (topCandidates.length === 0) return null;

  const truncatedContent = currentContent.slice(0, CURRENT_CONTENT_MAX);

  const candidateLines = topCandidates.map((c) => {
    const summaryTruncated = c.summary.slice(0, CANDIDATE_SUMMARY_MAX);
    const commitLines = c.commits
      .map(
        (commit) =>
          `    ${commit.hash} ${commit.message} (changed: ${commit.filesChanged.join(', ')})`,
      )
      .join('\n');
    const commitSection = commitLines
      ? `\n    Git commits:\n${commitLines}`
      : '';
    return `- ${c.title}: ${summaryTruncated}\n  Shared keywords: ${c.sharedKeywords.join(', ')}${commitSection}`;
  });

  const prompt = `You are analyzing whether a new ticket is a recurrence of previously addressed issues.

Current ticket:
${truncatedContent}

Prior tickets that share keywords:
${candidateLines.join('\n')}

Analyze whether the current ticket represents a recurrence of the prior issues.
If so, identify what the prior fixes missed or left unresolved.

Return ONLY a JSON object:
{
  "isRecurrence": true/false,
  "gaps": ["what prior fix missed 1", ...],
  "rootCauseHypothesis": "why this keeps recurring" or null
}`;

  try {
    const response = await aiExecutor.execute({
      prompt,
      maxTokens: 1024,
      stage: 'plan',
    });

    if (!response.content) return null;

    const raw = response.content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed = JSON.parse(raw) as {
      isRecurrence: boolean;
      gaps: string[];
      rootCauseHypothesis: string | null;
    };

    return {
      isRecurrence: Boolean(parsed.isRecurrence),
      candidates: topCandidates,
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      rootCauseHypothesis: parsed.rootCauseHypothesis ?? null,
    };
  } catch {
    return null;
  }
};

/**
 * Format a RecurrenceGapAnalysis into a prompt section for plan injection.
 *
 * @param analysis - The result of analyzeRecurrenceGaps
 * @returns Formatted string, or empty string when not a recurrence
 */
export const formatRecurrenceGapsPromptSection = (
  analysis: RecurrenceGapAnalysis,
): string => {
  if (!analysis.isRecurrence) return '';

  const lines: string[] = [
    `Recurring issue detected:`,
    `This ticket shares keywords with ${analysis.candidates.length} prior tickets in this repository:`,
  ];

  for (const candidate of analysis.candidates) {
    const sharedStr = candidate.sharedKeywords.join(', ');
    lines.push(`- ${candidate.title} (shared: ${sharedStr})`);

    for (const commit of candidate.commits) {
      const filesStr = commit.filesChanged.join(', ');
      lines.push(
        `  Git commits: ${commit.hash} ${commit.message} (changed: ${filesStr})`,
      );
    }
  }

  if (analysis.gaps.length > 0) {
    lines.push('');
    lines.push('Implementation gaps identified in prior attempts:');
    for (const gap of analysis.gaps) {
      lines.push(`- ${gap}`);
    }
  }

  if (analysis.rootCauseHypothesis) {
    lines.push('');
    lines.push(`Root cause hypothesis: ${analysis.rootCauseHypothesis}`);
  }

  lines.push('');
  lines.push(
    'IMPORTANT: Address the identified gaps in this plan/ticket. The fix must be more durable than prior attempts.',
  );

  return lines.join('\n');
};
