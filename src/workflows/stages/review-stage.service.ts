import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AiService,
  CodeReview,
  REVIEW_VERDICT_APPROVED,
  REVIEW_VERDICT_CHANGES_REQUESTED,
  requireAiResponseContent,
} from '../../integrations/ai/ai.service';
import { formatReviewCallStack, formatReviewStateTransition } from '../../integrations/ai/review-trace';
import { ReviewArtifact, TicketArtifact } from '../../agents/interfaces';
import { StageAgentService } from '../../integrations/ai/stage-agent.service';
import { buildCodeReviewPresentation } from '../../review/code-review-post-processing';
import { formatIssueFileLocation } from '../../shared/schemas/review.schema';
import { splitDiffByFile, summariseDiff, MAX_REVIEW_DIFF_LENGTH } from '../../review/summarise-diff';
import { resolveDefaultStageBackend } from '../../config/stage-backend-defaults';
import { deriveReviewArtifactPath } from '../../shared/utils/plan-artifact';
import { StageProgressCallback } from '../../shared/types/agent.types';
import { resolveSkills } from '../../skills';
import { isAIErrorLike } from '../../shared/utils/errors';

const DEFAULT_REVIEW_GUIDELINES = [
  'Boundaries: Verify logic is placed in the correct module, layer, or service and cross-module dependencies are justified.',
  'Clarity: Verify every changed line is immediately understandable without author context.',
  'Contracts: Flag changes to function signatures, return types, event payloads, or public APIs that break existing callers or tests.',
  'Conventions: Confirm naming, formatting, import order, and file placement match established codebase patterns.',
  'Documentation: Ensure changed public APIs, config options, and behaviour have matching doc, JSDoc, or comment updates.',
  'Failure handling: Identify how each new code path fails and whether the failure is surfaced, retried, or silently swallowed.',
  'Necessity: Flag added code, parameters, or abstractions that are unused, speculative, or unreachable.',
  'Ripple effects: Identify subtle breakage across module boundaries, in downstream consumers, or that compounds over time.',
  'Scope: Reject unrelated refactors, unnecessary abstractions, and changes beyond the stated objective.',
  'Security: Check for exposed secrets, injection vectors, missing auth/authz guards, and unsafe deserialization.',
  'Testing: Require test coverage for new code paths, edge cases, and failure scenarios.',
];

interface ReviewDiffOptions {
  context: string;
  extraCriteria?: string[];
  replaceCriteria?: boolean;
  repoDir?: string;
  priorStageSummary?: string;
  resumeProviderSessionId?: string;
  forkSession?: boolean;
  onProgress?: StageProgressCallback;
  skillNames?: string[];
  sonarOutput?: string;
}

@Injectable()
export class ReviewStageService {
  constructor(
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly stageAgentService: StageAgentService
  ) {}

  async reviewDiff(diff: string, options: ReviewDiffOptions): Promise<{ review: CodeReview; sessionId?: string }> {
    const guidelines = this.buildReviewGuidelines(options);
    const segments = splitDiffByFile(diff);
    const summariseCallback = this.createSummariseCallback(options);
    const processedDiff = await summariseDiff(segments, MAX_REVIEW_DIFF_LENGTH, summariseCallback);
    return this.executeReview(processedDiff, guidelines, options);
  }

  private buildReviewGuidelines(options: ReviewDiffOptions): string[] {
    return options.replaceCriteria
      ? [...(options.extraCriteria ?? [])]
      : [
          ...DEFAULT_REVIEW_GUIDELINES,
          `Relevancy: Does the feature or fix work? (This is very important — context: ${options.context})`,
          ...(options.extraCriteria ?? []),
        ];
  }

  private createSummariseCallback(
    options: ReviewDiffOptions
  ): (patch: string, file: string) => Promise<string> {
    return async (patch: string, file: string) => {
      options.onProgress?.(`Summarising changes in ${file}...`);
      const prompt = this.buildSummarisationPrompt(file, patch);
      const response = await this.aiService.execute({
        prompt,
        maxTokens: 2048,
        stage: 'review',
      });
      return requireAiResponseContent(response, 'AI provider returned an empty review summary response');
    };
  }

  private buildSummarisationPrompt(file: string, patch: string): string {
    return `Summarise the following diff for ${file} into concise bullet points that capture every `
      + `changed function, added/removed import, modified signature, and behavioural change. `
      + `Do not omit technical details (identifiers, types, values). `
      + `Return ONLY a Markdown bullet list (- item).\n\n`
      + `\`\`\`diff\n${patch}\n\`\`\``;
  }

  private async executeReview(
    diff: string,
    guidelines: string[],
    options: ReviewDiffOptions
  ): Promise<{ review: CodeReview; sessionId?: string }> {
    const { review, sessionId } = await this.performReview(diff, guidelines, options);
    return { review: this.ensureExecutionModeSet(review), sessionId };
  }

  private async resolveReviewSkillNames(): Promise<string[] | undefined> {
    const ids = this.configService.get<string[]>('stages.review.skills') ?? [];
    if (!ids.length) return undefined;
    const skills = await resolveSkills(ids, { interactive: this.isInteractiveSession(), stage: 'review' });
    return skills.map(s => s.id);
  }

  private async performReview(
    diff: string,
    guidelines: string[],
    options: ReviewDiffOptions
  ): Promise<{ review: CodeReview; sessionId?: string }> {
    if (!this.stageAgentService.isEnabledForStage('review')) {
      return { review: await this.aiService.reviewCode(diff, guidelines, options.onProgress, options.sonarOutput) };
    }
    const skillNames = await this.resolveReviewSkillNames();
    return this.reviewViaAgent(diff, guidelines, { ...options, skillNames });
  }

  private async reviewViaAgent(diff: string, guidelines: string[], options: ReviewDiffOptions
  ): Promise<{ review: CodeReview; sessionId?: string }> {
    try {
      const result = await this.stageAgentService.reviewCode(
        diff, guidelines, options.repoDir, options.priorStageSummary,
        options.resumeProviderSessionId, options.onProgress,
        { skillNames: options.skillNames, forkSession: options.forkSession, sonarOutput: options.sonarOutput }
      );
      return { review: result.review, sessionId: result.sessionId };
    } catch (error) {
      const sessionId = isAIErrorLike(error) ? error.details?.sessionId : undefined;
      const review = await this.recoverReviewFromValidation(error, diff);
      return { review, sessionId };
    }
  }

  private async recoverReviewFromValidation(error: unknown, diff: string): Promise<CodeReview> {
    if (!isAIErrorLike(error) || error.category !== 'parse' || !error.details?.response) throw error;
    const review = await this.aiService.validateReviewJson(error.details.response as string, diff);
    const backend = this.configService.get<string>('stages.review.backend', resolveDefaultStageBackend('review'));
    return { ...review, executionMode: backend === 'cli' ? 'cli' : 'agent' };
  }

  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  private ensureExecutionModeSet(review: CodeReview): CodeReview {
    if (review.executionMode) {
      return review;
    }

    const backend = this.configService.get<string>('stages.review.backend', resolveDefaultStageBackend('review'));
    return {
      ...review,
      executionMode: backend === 'agent' ? 'agent' : 'standard',
    };
  }

  buildReviewArtifact(
    ticket: TicketArtifact, review: CodeReview, sessionId?: string
  ): ReviewArtifact {
    return {
      review,
      path: deriveReviewArtifactPath(ticket.path),
      approved: review.approved,
      sessionId,
    };
  }

  persistReviewArtifact(artifact: ReviewArtifact, ticketKey: string, sonarOutput?: string): void {
    fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
    fs.writeFileSync(artifact.path, this.formatReviewMarkdown(ticketKey, artifact.review, sonarOutput));
  }

  createReviewArtifact(
    ticket: TicketArtifact, review: CodeReview, sessionId?: string, sonarOutput?: string
  ): ReviewArtifact {
    const artifact = this.buildReviewArtifact(ticket, review, sessionId);
    this.persistReviewArtifact(artifact, ticket.ticketKey, sonarOutput);
    return artifact;
  }

  private formatReviewMarkdown(ticketKey: string, review: CodeReview, sonarOutput?: string): string {
    const presentation = buildCodeReviewPresentation(review);
    const sections = this.collectReviewSections(review, presentation, sonarOutput);
    return this.buildReviewMarkdownString(ticketKey, review, sections);
  }

  private collectReviewSections(
    review: CodeReview,
    presentation: ReturnType<typeof buildCodeReviewPresentation>,
    sonarOutput?: string
  ): Record<string, string> {
    return {
      callStack: this.formatCallStackMarkdown(review.callStack),
      stateTransition: this.formatStateTransitionMarkdown(review.stateTransition),
      provenance: this.formatTraceProvenance(review),
      issues: this.formatIssuesSection(presentation),
      suggestions: this.formatTrailingSuggestionsSection(presentation),
      staticAnalysis: sonarOutput ? '```\n' + sonarOutput + '\n```' : '',
    };
  }

  private buildReviewMarkdownString(
    ticketKey: string,
    review: CodeReview,
    sections: Record<string, string>
  ): string {
    const parts = [
      `# Code Review: ${ticketKey}\n\n## Summary\n${review.summary}\n`,
      ...(sections.staticAnalysis ? [`## Static Analysis (SonarScanner)\n${sections.staticAnalysis}\n`] : []),
      `## Issues\n${sections.issues}\n`,
      `## Call Stack\n${sections.provenance}\n${sections.callStack}\n`,
      `## State Transition\n${sections.provenance}\n${sections.stateTransition}\n${sections.suggestions}\n`,
      this.buildApprovalStatusLine(review),
    ];
    return parts.join('\n');
  }

  private buildApprovalStatusLine(review: CodeReview): string {
    const status = review.approved ? `✔ ${REVIEW_VERDICT_APPROVED}` : `✗ ${REVIEW_VERDICT_CHANGES_REQUESTED}`;
    return `## Approval Status\n${status}`;
  }

  private formatIssuesSection(presentation: ReturnType<typeof buildCodeReviewPresentation>): string {
    return presentation.issueRows.length > 0
      ? presentation.issueRows
          .map(({ issue, suggestion }) =>
            [
              `- [${issue.severity}] ${issue.message}${issue.file ? ` (${formatIssueFileLocation(issue)})` : ''}`,
              suggestion ? `  - Suggestion: ${suggestion}` : null,
            ]
              .filter((line): line is string => line != null)
              .join('\n')
          )
          .join('\n')
      : '- None';
  }

  private formatTrailingSuggestionsSection(presentation: ReturnType<typeof buildCodeReviewPresentation>): string {
    return presentation.unmatchedSuggestions.length > 0
      ? `\n## Suggestions\n${presentation.unmatchedSuggestions.map(suggestion => `- ${suggestion}`).join('\n')}\n`
      : '\n';
  }

  private resolveTraceProvenance(review: CodeReview): string {
    const hasStructuredTrace
      = Boolean(review.callStack?.length) || Object.keys(review.stateTransition ?? {}).length > 0;
    if (!hasStructuredTrace || review.traceProvenance === 'unavailable') {
      return 'unavailable';
    }

    if (review.executionMode === 'agent' || review.executionMode === 'cli') return 'evidence-based';

    if (review.traceProvenance) {
      return review.traceProvenance;
    }

    return 'best-effort';
  }

  private formatTraceProvenance(review: CodeReview): string {
    const provenance = this.resolveTraceProvenance(review);
    const executionMode = review.executionMode ?? 'standard';

    if (provenance === 'evidence-based') {
      return this.formatEvidenceBasedTrace(executionMode);
    }

    return provenance === 'best-effort'
      ? this.formatBestEffortTrace(executionMode)
      : this.formatUnavailableTrace(executionMode);
  }

  private formatEvidenceBasedTrace(executionMode: string): string {
    return [
      `> Execution mode: ${executionMode}.`,
      '> Provenance: evidence-based (code-path trace backed by the execution backend).',
      '> Evidence: the trace is grounded in the changed code path.',
    ].join('\n');
  }

  private formatBestEffortTrace(executionMode: string): string {
    return [
      `> Execution mode: ${executionMode}.`,
      '> Provenance: best-effort (code-path trace inferred from the diff and AI output).',
      '> Hindrance: there is no runtime execution trace backend in this path.',
    ].join('\n');
  }

  private formatUnavailableTrace(executionMode: string): string {
    return [
      `> Execution mode: ${executionMode}.`,
      '> Provenance: unavailable (no concrete code-path trace could be inferred from the diff).',
      '> Hindrance: the review pipeline did not return a code-path trace payload.',
    ].join('\n');
  }

  private formatCallStackMarkdown(callStack?: CodeReview['callStack']): string {
    const lines = formatReviewCallStack(callStack);
    return lines.length > 0 ? lines.join('\n') : '- (no structured call stack was returned)';
  }

  private formatStateTransitionMarkdown(stateTransition?: CodeReview['stateTransition']): string {
    const lines = formatReviewStateTransition(stateTransition);
    if (lines.length === 0) {
      return '```text\n(no structured state transition was returned)\n```';
    }

    return lines.join('\n');
  }
}
