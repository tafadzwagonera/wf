import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { AiService, CodeReview } from '../../integrations/ai/ai.service';
import {
  formatReviewCallStack,
  formatReviewStateTransition,
} from '../../integrations/ai/review-trace';
import { ReviewArtifact, TicketArtifact } from '../../agents/interfaces';
import { StageAgentService } from '../../integrations/ai/stage-agent.service';
import { buildCodeReviewPresentation } from '../../review/code-review-post-processing';
import {
  splitDiffByFile,
  summariseDiff,
  MAX_REVIEW_DIFF_LENGTH,
} from '../../review/summarise-diff';

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
}

@Injectable()
export class ReviewStageService {
  constructor(
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly stageAgentService: StageAgentService,
  ) {}

  async reviewDiff(
    diff: string,
    options: ReviewDiffOptions,
  ): Promise<CodeReview> {
    const guidelines = options.replaceCriteria
      ? [...(options.extraCriteria ?? [])]
      : [
          ...DEFAULT_REVIEW_GUIDELINES,
          `Relevancy: Does the feature or fix work? (This is very important — context: ${options.context})`,
          ...(options.extraCriteria ?? []),
        ];

    const segments = splitDiffByFile(diff);
    const summariseCallback = async (patch: string, file: string) => {
      const prompt =
        `Summarise the following diff for ${file} into concise bullet points that capture every ` +
        `changed function, added/removed import, modified signature, and behavioural change. ` +
        `Do not omit technical details (identifiers, types, values). ` +
        `Return ONLY a Markdown bullet list (- item).\n\n` +
        `\`\`\`diff\n${patch}\n\`\`\``;

      return this.stageAgentService.isEnabledForStage('review')
        ? (await this.stageAgentService.generateFromPrompt(prompt)).trim()
        : (
            await this.aiService.execute({
              prompt,
              maxTokens: 2048,
              stage: 'review',
            })
          ).content.trim();
    };

    const processedDiff = await summariseDiff(
      segments,
      MAX_REVIEW_DIFF_LENGTH,
      summariseCallback,
    );

    const review = this.stageAgentService.isEnabledForStage('review')
      ? await this.stageAgentService.reviewCode(
          processedDiff,
          guidelines,
          options.repoDir,
        )
      : await this.aiService.reviewCode(processedDiff, guidelines);
    const agentEnabled =
      this.configService.get<boolean>('stages.review.agent', false) === true;
    return {
      ...review,
      executionMode: agentEnabled ? 'agent' : 'standard',
    };
  }

  createReviewArtifact(
    ticket: TicketArtifact,
    review: CodeReview,
  ): ReviewArtifact {
    const reviewPath = ticket.path.replace('.md', '-review.md');
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    fs.writeFileSync(
      reviewPath,
      this.formatReviewMarkdown(ticket.ticketKey, review),
    );

    return {
      review,
      path: reviewPath,
      approved: review.approved,
    };
  }

  private formatReviewMarkdown(ticketKey: string, review: CodeReview): string {
    const presentation = buildCodeReviewPresentation(review);
    const callStackSection = this.formatCallStackMarkdown(review.callStack);
    const stateTransitionSection = this.formatStateTransitionMarkdown(
      review.stateTransition,
    );
    const provenanceSection = this.formatTraceProvenance(review);
    const issuesSection =
      presentation.issueRows.length > 0
        ? presentation.issueRows
            .map(({ issue, suggestion }) =>
              [
                `- [${issue.severity}] ${issue.message}${issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : ''}`,
                suggestion ? `  - Suggestion: ${suggestion}` : null,
              ]
                .filter((line): line is string => line != null)
                .join('\n'),
            )
            .join('\n')
        : '- None';
    const trailingSuggestionsSection =
      presentation.unmatchedSuggestions.length > 0
        ? `\n## Suggestions\n${presentation.unmatchedSuggestions.map((suggestion) => `- ${suggestion}`).join('\n')}\n`
        : '\n';

    return `# Code Review: ${ticketKey}

## Summary
${review.summary}

## Issues
${issuesSection}

## Call Stack
${provenanceSection}
${callStackSection}

## State Transition
${provenanceSection}
${stateTransitionSection}
${trailingSuggestionsSection}

## Approval Status
${review.approved ? '✓ Approved' : '✗ Changes needed'}
`;
  }

  private resolveTraceProvenance(review: CodeReview): string {
    const hasStructuredTrace =
      Boolean(review.callStack?.length) ||
      Object.keys(review.stateTransition ?? {}).length > 0;
    if (!hasStructuredTrace || review.traceProvenance === 'unavailable') {
      return 'unavailable';
    }

    if (review.executionMode === 'agent') return 'evidence-based';

    if (review.traceProvenance) {
      return review.traceProvenance;
    }

    return 'best-effort';
  }

  private formatTraceProvenance(review: CodeReview): string {
    const provenance = this.resolveTraceProvenance(review);

    if (provenance === 'evidence-based') {
      return [
        `> Execution mode: ${review.executionMode ?? 'standard'}.`,
        '> Provenance: evidence-based (code-path trace backed by the execution backend).',
        '> Evidence: the trace is grounded in the changed code path.',
      ].join('\n');
    }

    if (provenance === 'best-effort') {
      return [
        `> Execution mode: ${review.executionMode ?? 'standard'}.`,
        '> Provenance: best-effort (code-path trace inferred from the diff and AI output).',
        '> Hindrance: there is no runtime execution trace backend in this path.',
      ].join('\n');
    }

    return [
      `> Execution mode: ${review.executionMode ?? 'standard'}.`,
      '> Provenance: unavailable (no concrete code-path trace could be inferred from the diff).',
      '> Hindrance: the review pipeline did not return a code-path trace payload.',
    ].join('\n');
  }

  private formatCallStackMarkdown(callStack?: CodeReview['callStack']): string {
    const lines = formatReviewCallStack(callStack);
    return lines.length > 0
      ? lines.join('\n')
      : '- (no structured call stack was returned)';
  }

  private formatStateTransitionMarkdown(
    stateTransition?: CodeReview['stateTransition'],
  ): string {
    const lines = formatReviewStateTransition(stateTransition);
    if (lines.length === 0) {
      return '```text\n(no structured state transition was returned)\n```';
    }

    return lines.join('\n');
  }
}
