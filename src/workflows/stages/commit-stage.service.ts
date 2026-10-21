import { Injectable } from '@nestjs/common';
import { AiService, requireAiResponseContent } from '../../integrations/ai/ai.service';
import {
  parseDiffFileStats,
  formatDiffStatSummary,
  buildPrioritizedDiffExcerpt,
  isDocsOnlyChangeset,
  declaresDocsOnlyType,
  extractConventionalType,
} from '../../common/utils/commit-diff-stat';

const STANDALONE_DIFF_EXCERPT_MAX_CHARS = 3000;

interface GenerateCommitMessageOptions {
  diff: string;
  ticketKey?: string;
  conventional?: boolean;
  commitHistory?: string[];
  ticketContext?: string;
  scopeSummary?: string; // Consumed only by standalone prompt path; enriched path uses ticketContext
}

@Injectable()
export class CommitStageService {
  constructor(private readonly aiService: AiService) {}

  async generateCommitMessage(options: GenerateCommitMessageOptions): Promise<string> {
    if (options.commitHistory || options.ticketContext) {
      const rawMessage = await this.aiService.generateCommitMessage(
        options.diff,
        options.commitHistory ?? [],
        'auto',
        options.ticketContext
      );
      return this.normalizeCommitMessage(rawMessage, options.ticketKey);
    }
    const message = await this.generateStandaloneMessage(options);
    return this.normalizeCommitMessage(message, options.ticketKey, false);
  }

  private async generateStandaloneMessage(options: {
    diff: string;
    ticketKey?: string;
    conventional?: boolean;
    scopeSummary?: string;
  }): Promise<string> {
    const first = await this.executeStandalonePrompt(options);
    const stats = parseDiffFileStats(options.diff);
    if (isDocsOnlyChangeset(stats) || !declaresDocsOnlyType(first)) return first;
    const correction = buildStandaloneDocsCorrection(first);
    return this.executeStandalonePrompt({ ...options, correction });
  }

  private async executeStandalonePrompt(options: {
    diff: string;
    ticketKey?: string;
    conventional?: boolean;
    scopeSummary?: string;
    correction?: string;
  }): Promise<string> {
    const prompt = this.buildCommitPrompt(options);
    const response = await this.aiService.execute({ prompt, maxTokens: 500, temperature: 0.7, stage: 'commit' });
    return requireAiResponseContent(response, 'AI provider returned an empty commit message response');
  }

  private normalizeCommitMessage(
    rawMessage: string,
    ticketKey?: string,
    stripConventionalPrefix: boolean = true
  ): string {
    let message = stripCodeFences(rawMessage);
    if (stripConventionalPrefix) {
      message = message.replace(/^[a-z]+(\([^)]+\))?:\s*/, '').replace(/^[A-Z][A-Z0-9]+-\d+:\s*/, '');
    }
    return ticketKey && !message.includes(ticketKey) ? `${ticketKey}: ${message}` : message;
  }

  private buildCommitPrompt(options: {
    diff: string;
    ticketKey?: string;
    conventional?: boolean;
    scopeSummary?: string;
    correction?: string;
  }): string {
    let prompt = 'Generate a concise, informative git commit message for the following changes.\n\n';
    if (options.conventional) prompt += 'Use conventional commits format: <type>(<scope>): <description>\nTypes: feat, fix, docs, style, refactor, test, chore\n\n';
    if (options.ticketKey) prompt += `Related ticket: ${options.ticketKey}\n\n`;
    if (options.scopeSummary) prompt += `Known scope of this change (from prior review/plan): ${options.scopeSummary}\n\n`;
    return prompt + this.buildStandaloneGuidelines(options.diff, options.conventional, options.correction);
  }

  private buildStandaloneGuidelines(diff: string, conventional?: boolean, correction?: string): string {
    const stats = parseDiffFileStats(diff);
    const statSummary = stats.length > 0 ? `${formatDiffStatSummary(stats)}\n\n` : '';
    const diffExcerpt = buildPrioritizedDiffExcerpt(diff, stats, STANDALONE_DIFF_EXCERPT_MAX_CHARS);
    const bullets = buildGuidelineBullets(conventional, correction);
    return `${bullets}\n\n${statSummary}Git diff:\n\`\`\`diff\n${diffExcerpt}\n\`\`\`\n\n`
      + 'Return only the commit message, no explanations.';
  }
}

const stripCodeFences = (message: string): string =>
  message.trim().replaceAll(/```[a-z]*\n?/g, '').replaceAll('```', '').trim();

const buildConciseExampleBullet = (conventional?: boolean): string =>
  conventional
    ? 'Be concise and to the point regardless of type — e.g. "feat(auth): JWT token validation", '
    + '"fix(auth): token refresh race condition", "style(warnings): consistent symbols", '
    + '"docs(review): skip-verification flag"'
    : 'Be concise and to the point — e.g. "JWT token validation", "Token refresh race condition", '
      + '"Consistent symbols" — just the unscoped description, no type prefix';

const buildGuidelineBullets = (conventional?: boolean, correction?: string): string => {
  const bullets = [
    'First line: concise summary (50 chars or less)',
    'Focus on WHY and WHAT, not HOW',
    buildConciseExampleBullet(conventional),
    'Be specific and clear',
    'Do not include the ticket key (will be added automatically)',
    ...(conventional ? ['The type/scope must reflect the full file list below, not just the first files in the diff'] : []),
  ];
  const correctionLine = correction ? `\n${correction}` : '';
  return `Guidelines:\n${bullets.map(b => `- ${b}`).join('\n')}${correctionLine}`;
};

/**
 * Build a corrective instruction for a standalone-prompt retry after the
 * model declared a docs/style/chore type on a changeset that isn't docs-only.
 * @param previousMessage The mismatched commit message from the first attempt
 * @returns Corrective instruction text to append to the retry prompt
 */
const buildStandaloneDocsCorrection = (previousMessage: string): string => {
  const type = extractConventionalType(previousMessage) ?? 'docs';
  return `Correction: your previous type ("${type}") implied a docs-only change, but the file list below includes `
    + 'substantive source changes outside docs/tests. Re-classify the type (e.g. feat, fix, refactor).';
};
