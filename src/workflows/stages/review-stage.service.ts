import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  AiService,
  CodeReview,
  REVIEW_VERDICT_APPROVED,
  REVIEW_VERDICT_CHANGES_REQUESTED,
  requireAiResponseContent,
} from '../../integrations/ai/ai.service';
import { formatReviewCallStack, formatReviewStateTransition } from '../../integrations/ai/review-trace';
import { ReviewArtifact, TicketArtifact } from '../../agents/interfaces';
import { StageAgentService, buildSanitisedJsonSchema } from '../../integrations/ai/stage-agent.service';
import { buildCodeReviewPresentation } from '../../review/code-review-post-processing';
import { batchSummarySchema } from '../../common/schemas/batch-summary.schema';
import { formatIssueFileLocation } from '../../common/schemas/review.schema';
import { formatIssueSeverityLabel } from '../../review/risk-adjusted-severity';
import {
  splitDiffByFile,
  summariseDiff,
  summariseDiffBatched,
  MAX_REVIEW_DIFF_LENGTH,
  BatchSummariseFn,
  SummariseDiffOptions,
  DiffSegment,
} from '../../review/summarise-diff';
import { resolveDefaultStageBackend } from '../../config/stage-backend-defaults';
import { deriveReviewArtifactPath } from '../../common/utils/plan-artifact';
import { ProviderSessionIdCallback, StageProgressCallback } from '../../common/types/agent.types';
import { isAiProviderErrorLike } from '../../common/utils/errors';
import { appendToLogFile } from '../../common/logger/log-file-writer';
import type { UiDesignScreenshot } from '../../common/types/ui-design-screenshot';

const batchSummarisationSystemPrompt
  = "Summarize each file's diff from the user message as concise Markdown bullets. "
    + 'When a structured output schema is enforced, return JSON matching it with one summaries entry per file, using each file path exactly as given. '
    + 'Otherwise precede each file\'s summary with a line containing exactly `=== FILE: <path> ===`. '
    + 'Summarise every file. Output nothing else and perform no other task.';

const batchSummarisationUserInstruction
  = 'Summarize the diff for each file below as concise Markdown bullets, following the output format from your instructions. '
    + 'Cover every file listed. Do not review, plan, or investigate — summarise only.';

const batchSummaryJsonSchema = buildSanitisedJsonSchema(z.toJSONSchema(batchSummarySchema));

const defaultReviewGuidelines = [
  "Accessibility: Verify interactive elements have correct roles, labels, and focus states; check that keyboard and screen-reader operability isn't regressed (e.g. aria-hidden on a focusable element, missing alt text, a removed native affordance); flag contrast or motion-reduction regressions in visual changes.",
  'Boundaries: Verify logic is placed in the correct module, layer, or service and cross-module dependencies are justified.',
  'Clarity: Verify every changed line is immediately understandable without author context.',
  "Comments: Flag any newly added comment in the diff as a [warning]. New comments need human approval except JSDoc where a symbol's complexity genuinely warrants it. Preexisting comments may stay.",
  'Contracts: Flag changes to function signatures, return types, event payloads, or public APIs that break existing callers or tests.',
  'Conventions: Confirm naming, formatting, import order, and file placement match established codebase patterns.',
  'Documentation: Ensure changed public APIs, config options, and behaviour have matching doc, JSDoc, or comment updates.',
  'Failure handling: Identify how each new code path fails and whether the failure is surfaced, retried, or silently swallowed.',
  'Naming fit: Flag a file/component/class/method/utility name that describes a narrower scope than its actual call sites (e.g. a page-scoped component reused on an unrelated page, or a single-purpose helper generalized to a second caller without renaming). This is a name-to-scope mismatch, not a style deviation — raise it even with no existing pattern to compare against; the "Pattern grounding" guideline below does not gate this one.',
  "Pattern grounding: Before flagging a naming, structural, or convention issue, check whether the pattern you're recommending actually exists in the codebase by reading the relevant files listed in the repository conventions. Do not assert that something diverges from an established pattern if you have only read the diff.",
  'Ripple effects: Identify subtle breakage across module boundaries, in downstream consumers, or that compounds over time.',
  'Scope & necessity: Reject unrelated refactors, unnecessary abstractions, and changes beyond the stated objective; flag added code, parameters, or abstractions that are unused, speculative, or unreachable.',
  'Security: Check for exposed secrets, injection vectors, missing auth/authz guards, and unsafe deserialization.',
  'Testing: Require test coverage for new code paths, edge cases, and failure scenarios.',
];

interface ReviewDiffOptions {
  additionalContextSections?: string[];
  context: string;
  extraCriteria?: string[];
  replaceCriteria?: boolean;
  repoDir?: string;
  priorStageSummary?: string;
  resumeProviderSessionId?: string;
  forkSession?: boolean;
  onProgress?: StageProgressCallback;
  onProviderSessionId?: ProviderSessionIdCallback;
  figmaContextSection?: string;
  screenshots?: UiDesignScreenshot[];
  commentPolicyEnabled?: boolean;
}

@Injectable()
export class ReviewStageService {
  constructor(
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly stageAgentService: StageAgentService
  ) {}

  async reviewDiff(
    diff: string, options: ReviewDiffOptions
  ): Promise<{ review: CodeReview; sessionId?: string; modelUsed?: string }> {
    const threshold = this.resolveReviewDiffThreshold();
    const guidelines = this.buildReviewGuidelines(options);
    const segments = splitDiffByFile(diff);
    const processedDiff = await this.summariseReviewDiff(segments, threshold, options);
    this.signalOversizedSummarisedDiff(processedDiff, options.onProgress, threshold);
    return this.executeReview(processedDiff, guidelines, options);
  }

  private async summariseReviewDiff(
    segments: DiffSegment[],
    threshold: number,
    options: ReviewDiffOptions
  ): Promise<string> {
    const onError: SummariseDiffOptions['onError'] = failure =>
      this.handleSummariseFailure(failure, options.onProgress);
    if (this.shouldUseCliSummarisation()) {
      return summariseDiffBatched(segments, threshold, this.createBatchSummariseCallback(options), { onError });
    }
    return summariseDiff(segments, threshold, this.createSummariseCallback(options), { onError });
  }

  private createBatchSummariseCallback(options: ReviewDiffOptions): BatchSummariseFn {
    return async (segments: DiffSegment[]) => {
      const files = segments.map(s => s.file).join(', ');
      options.onProgress?.(`Summarising changes in ${segments.length} file(s): ${files}...`);
      const prompt = this.buildBatchSummarisationPrompt(segments);
      const content = await this.runCliSummarisation(
        prompt, options.repoDir, batchSummarisationSystemPrompt, batchSummaryJsonSchema, {
          label: 'batch summary',
          parse: value => batchSummarySchema.parse(value),
        },
      );
      return this.parseBatchSummaryResponse(content);
    };
  }

  private buildBatchSummarisationPrompt(segments: DiffSegment[]): string {
    const body = segments.map(s => `File: ${s.file}\n\`\`\`diff\n${s.patch}\n\`\`\``).join('\n\n');
    return `${batchSummarisationUserInstruction}\n\n${body}`;
  }

  private parseBatchSummaryResponse(content: string): Map<string, string> {
    const structured = this.parseStructuredBatchSummary(content);
    if (structured !== undefined) return structured;
    const result = new Map<string, string>();
    const parts = content.split(/^===\s*FILE:\s*(.+?)\s*===\s*$/m);
    for (let i = 1; i < parts.length; i += 2) {
      const file = path.normalize(parts[i].trim());
      const body = parts[i + 1]?.trim() ?? '';
      if (file && body) result.set(file, body);
    }
    if (result.size === 0) this.logBatchSummaryParseMiss(content);
    return result;
  }

  private parseStructuredBatchSummary(content: string): Map<string, string> | undefined {
    const validated = batchSummarySchema.safeParse(this.tryParseJson(content));
    if (!validated.success) return undefined;
    return new Map(validated.data.summaries.map(s => [path.normalize(s.file.trim()), s.summary]));
  }

  private tryParseJson(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  private logBatchSummaryParseMiss(content: string): void {
    appendToLogFile('DEBUG', `review-stage.batch_summary_parse_miss contentChars=${content.length}`, 'review-stage');
    appendToLogFile('DEBUG', `head=${content.slice(0, 2048)}`, 'review-stage');
  }

  private buildReviewGuidelines(options: ReviewDiffOptions): string[] {
    const contextSections = [options.context, ...(options.additionalContextSections ?? [])].filter(Boolean);
    if (options.replaceCriteria) {
      return [...contextSections, ...(options.extraCriteria ?? [])];
    }
    const guidelines = options.commentPolicyEnabled
      ? defaultReviewGuidelines.filter(g => !g.startsWith('Comments:'))
      : defaultReviewGuidelines;
    return [
      ...guidelines,
      `Relevancy: Does the feature or fix work? (This is very important — context: ${contextSections.join('\n\n')})`,
      ...(options.extraCriteria ?? []),
    ];
  }

  private createSummariseCallback(
    options: ReviewDiffOptions
  ): (patch: string, file: string) => Promise<string> {
    return async (patch: string, file: string) => {
      options.onProgress?.(`Summarising changes in ${file}...`);
      const prompt = this.buildSummarisationPrompt(file, patch);
      return this.executeSummarisePrompt(prompt, options);
    };
  }

  private async executeSummarisePrompt(prompt: string, options: ReviewDiffOptions): Promise<string> {
    if (this.shouldUseCliSummarisation()) {
      return this.runCliSummarisation(
        prompt,
        options.repoDir,
        'Summarize diffs as concise Markdown bullets. Do not return JSON or commentary.'
      );
    }
    const response = await this.aiService.execute({
      prompt,
      maxTokens: 2048,
      stage: 'review',
    });
    return requireAiResponseContent(response, 'AI provider returned an empty review summary response');
  }

  private shouldUseCliSummarisation(): boolean {
    const backend = this.configService.get<string>('stages.review.backend', resolveDefaultStageBackend('review'));
    return backend !== 'standard' && this.stageAgentService.isEnabledForStage('review');
  }

  private async runCliSummarisation(
    prompt: string,
    repoDir: string | undefined,
    systemPrompt: string, jsonSchema?: string,
    responseValidator?: { label: string; parse: (value: unknown) => unknown }
  ): Promise<string> {
    const result = await this.stageAgentService.chatTurn({
      stage: 'review',
      userMessage: prompt,
      systemPrompt, repoDir, jsonSchema, responseValidator,
    });
    return result.content.trim();
  }

  private buildSummarisationPrompt(file: string, patch: string): string {
    return `Summarise the following diff for ${file} into concise bullet points. `
      + `Preserve technical precision — identifiers, types, and values matter as much as narrative. `
      + `Cover changed functions, import changes, signature modifications, and behavioural shifts. `
      + `Before noting a naming or structural observation, check whether the pattern exists in the codebase by reading relevant files in the repository conventions — do not assert divergence from an established pattern if you have only read the diff. `
      + `Return ONLY a Markdown bullet list (- item).\n\n`
      + `\`\`\`diff\n${patch}\n\`\`\``;
  }

  private async executeReview(
    diff: string,
    guidelines: string[],
    options: ReviewDiffOptions
  ): Promise<{ review: CodeReview; sessionId?: string; modelUsed?: string }> {
    const { review, sessionId, modelUsed } = await this.performReview(diff, guidelines, options);
    return { review: this.ensureExecutionModeSet(review), sessionId, modelUsed };
  }

  private async performReview(
    diff: string,
    guidelines: string[],
    options: ReviewDiffOptions
  ): Promise<{ review: CodeReview; sessionId?: string; modelUsed?: string }> {
    if (!this.stageAgentService.isEnabledForStage('review')) {
      return { review: await this.aiService.reviewCode(diff, guidelines, options.onProgress) };
    }
    return this.reviewViaAgent(diff, guidelines, options);
  }

  private async reviewViaAgent(diff: string, guidelines: string[], options: ReviewDiffOptions
  ): Promise<{ review: CodeReview; sessionId?: string; modelUsed?: string }> {
    const { forkSession, figmaContextSection, screenshots } = options;
    try {
      const result = await this.stageAgentService.reviewCode(
        diff, guidelines, options.repoDir, options.priorStageSummary,
        options.resumeProviderSessionId, options.onProgress,
        { forkSession, figmaContextSection, screenshots, onProviderSessionId: options.onProviderSessionId },
      );
      return { review: result.review, sessionId: result.sessionId, modelUsed: result.modelUsed };
    } catch (error) {
      return this.recoverFromReviewError(error, diff);
    }
  }

  private async recoverFromReviewError(error: unknown, diff: string) {
    const sessionId = isAiProviderErrorLike(error) ? error.details?.sessionId : undefined;
    return { review: await this.recoverReviewFromValidation(error, diff), sessionId };
  }

  private async recoverReviewFromValidation(error: unknown, diff: string): Promise<CodeReview> {
    if (!isAiProviderErrorLike(error) || error.category !== 'parse' || !error.details?.response) throw error;
    return this.aiService.validateReviewJson(error.details.response as string, diff);
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

  /**
   * Assembles a ReviewArtifact without persisting it to disk.
   * Pass `repoScope` (repo basename) in multi-repo runs to prevent artifact path collision across repos.
   * Callers within ReviewStageService itself (e.g. `createReviewArtifact`) operate in single-repo context and omit it.
   */
  buildReviewArtifact(
    ticket: TicketArtifact, review: CodeReview, sessionId?: string, repoScope?: string, modelUsed?: string
  ): ReviewArtifact {
    return {
      review,
      path: deriveReviewArtifactPath(ticket.path, repoScope),
      approved: review.approved,
      sessionId,
      modelUsed,
    };
  }

  persistReviewArtifact(artifact: ReviewArtifact, ticketKey: string): void {
    fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
    fs.writeFileSync(artifact.path, this.formatReviewMarkdown(ticketKey, artifact.review));
  }

  createReviewArtifact(
    ticket: TicketArtifact, review: CodeReview, sessionId?: string
  ): ReviewArtifact {
    const artifact = this.buildReviewArtifact(ticket, review, sessionId);
    this.persistReviewArtifact(artifact, ticket.ticketKey);
    return artifact;
  }

  private formatReviewMarkdown(ticketKey: string, review: CodeReview): string {
    const presentation = buildCodeReviewPresentation(review);
    const sections = this.collectReviewSections(review, presentation);
    return this.buildReviewMarkdownString(ticketKey, review, sections);
  }

  private collectReviewSections(
    review: CodeReview,
    presentation: ReturnType<typeof buildCodeReviewPresentation>
  ): Record<string, string> {
    return {
      callStack: this.formatCallStackMarkdown(review.callStack),
      stateTransition: this.formatStateTransitionMarkdown(review.stateTransition),
      provenance: this.formatTraceProvenance(review),
      issues: this.formatIssuesSection(presentation),
      suggestions: this.formatTrailingSuggestionsSection(presentation),
    };
  }

  private buildReviewMarkdownString(
    ticketKey: string,
    review: CodeReview,
    sections: Record<string, string>
  ): string {
    const parts = [
      `# Code Review: ${ticketKey}\n\n## Summary\n${review.summary}\n`,
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
      ? presentation.issueRows.map(row => this.formatIssueRow(row)).join('\n')
      : '- None';
  }

  private formatIssueRow(
    row: ReturnType<typeof buildCodeReviewPresentation>['issueRows'][number]
  ): string {
    const { issue, suggestion } = row;
    const location = issue.file ? ` (${formatIssueFileLocation(issue)})` : '';
    const lines = [
      `- [${formatIssueSeverityLabel(issue)}] ${issue.message}${location}`,
      suggestion ? `  - Suggestion: ${suggestion}` : null,
    ];
    return lines.filter((line): line is string => line != null).join('\n');
  }

  private formatTrailingSuggestionsSection(presentation: ReturnType<typeof buildCodeReviewPresentation>): string {
    if (presentation.unmatchedSuggestions.length === 0) return '\n';
    const suggestionLines = presentation.unmatchedSuggestions.map(suggestion => `- ${suggestion}`).join('\n');
    return `\n## Suggestions\n${suggestionLines}\n`;
  }

  private resolveTraceProvenance(review: CodeReview): string {
    const hasStructuredTrace
      = Boolean(review.callStack?.length) || Object.keys(review.stateTransition ?? {}).length > 0;
    if (!hasStructuredTrace || review.traceProvenance === 'unavailable') {
      return 'unavailable';
    }

    if ((review.executionMode === 'agent' || review.executionMode === 'cli') && !review.repairStrategy) {
      return 'evidence-based';
    }

    if (review.traceProvenance) {
      return review.traceProvenance;
    }

    return 'best-effort';
  }

  private formatTraceProvenance(review: CodeReview): string {
    const provenance = this.resolveTraceProvenance(review);
    const executionMode = review.executionMode ?? 'standard';
    const repairLine = review.repairStrategy ? `> Repair strategy: ${review.repairStrategy}.` : null;

    if (provenance === 'evidence-based') {
      return this.formatEvidenceBasedTrace(executionMode, repairLine);
    }

    return provenance === 'best-effort'
      ? this.formatBestEffortTrace(executionMode, repairLine)
      : this.formatUnavailableTrace(executionMode, repairLine);
  }

  private formatEvidenceBasedTrace(executionMode: string, repairLine: string | null): string {
    return [
      `> Execution mode: ${executionMode}.`,
      repairLine,
      '> Provenance: evidence-based (code-path trace backed by the execution backend).',
      '> Evidence: the trace is grounded in the changed code path.',
    ].filter(Boolean).join('\n');
  }

  private formatBestEffortTrace(executionMode: string, repairLine: string | null): string {
    return [
      `> Execution mode: ${executionMode}.`,
      repairLine,
      '> Provenance: best-effort (code-path trace inferred from the diff and AI output).',
      '> Hindrance: there is no runtime execution trace backend in this path.',
    ].filter(Boolean).join('\n');
  }

  private formatUnavailableTrace(executionMode: string, repairLine: string | null): string {
    return [
      `> Execution mode: ${executionMode}.`,
      repairLine,
      '> Provenance: unavailable (no concrete code-path trace could be inferred from the diff).',
      '> Hindrance: the review pipeline did not return a code-path trace payload.',
    ].filter(Boolean).join('\n');
  }

  private handleSummariseFailure(
    failure: { file: string; originalLength: number; resultLength: number; error: unknown },
    onProgress?: StageProgressCallback
  ): void {
    const message = `Review diff summarisation failed for ${failure.file} `
      + `(original=${failure.originalLength}, result=${failure.resultLength}): `
      + `${failure.error instanceof Error ? failure.error.message : String(failure.error)}`;
    appendToLogFile('WARN', message, 'review-stage');
    onProgress?.(message);
  }

  private resolveReviewDiffThreshold(): number {
    return this.configService.get<number>('stages.review.maxDiffLength', MAX_REVIEW_DIFF_LENGTH);
  }

  private signalOversizedSummarisedDiff(
    diff: string, onProgress?: StageProgressCallback, threshold = MAX_REVIEW_DIFF_LENGTH
  ): void {
    if (diff.length <= threshold) return;
    const message = `Review diff remains oversized after summarisation (${diff.length}/${threshold} chars)`;
    appendToLogFile('WARN', message, 'review-stage');
    onProgress?.(message);
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
