import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AiService, CodeReview } from '../../integrations/ai/ai.service';
import { ReviewArtifact, TicketArtifact } from '../../agents/interfaces';

const DEFAULT_REVIEW_GUIDELINES = [
  'Clarity: Would another developer understand this instantly?',
  'Deletability: Can I remove or replace this easily?',
  'Failure handling: What breaks? Is it handled?',
  'Necessity: Is anything here unused or speculative?',
  'Quality: Do the changes conform to formatting and quality metrics?',
  'Security: Are there any glaring security concerns?',
  'Simplicity: Is this the simplest thing that works?',
  'Structure: Does this reflect the domain?',
];

interface ReviewDiffOptions {
  context: string;
  extraCriteria?: string[];
  replaceCriteria?: boolean;
}

@Injectable()
export class ReviewStageService {
  constructor(private readonly aiService: AiService) {}

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

    return this.aiService.reviewCode(diff, guidelines);
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
    const callStackSection = this.formatCallStackMarkdown(review.callStack);
    const stateTransitionSection = this.formatStateTransitionMarkdown(
      review.stateTransition,
    );
    const provenanceSection = this.formatTraceProvenance(review);

    return `# Code Review: ${ticketKey}

## Summary
${review.summary}

## Issues
${review.issues.map((issue) => `- [${issue.severity}] ${issue.message}${issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : ''}`).join('\n')}

## Call Stack
${provenanceSection}
${callStackSection}

## State Transition
${provenanceSection}
${stateTransitionSection}

## Suggestions
${review.suggestions.map((suggestion) => `- ${suggestion}`).join('\n')}

## Approval Status
${review.approved ? '✓ Approved' : '✗ Changes needed'}
`;
  }

  private resolveTraceProvenance(review: CodeReview): string {
    if (review.traceProvenance) {
      return review.traceProvenance;
    }

    if (
      review.callStack?.length ||
      Object.keys(review.stateTransition ?? {}).length
    ) {
      return 'best-effort';
    }

    return 'unavailable';
  }

  private formatTraceProvenance(review: CodeReview): string {
    const provenance = this.resolveTraceProvenance(review);

    if (provenance === 'evidence-based') {
      return [
        '> Provenance: evidence-based (code-path trace backed by the execution backend).',
        '> Evidence: the trace is grounded in the changed code path.',
      ].join('\n');
    }

    if (provenance === 'best-effort') {
      return [
        '> Provenance: best-effort (code-path trace inferred from the diff and AI output).',
        '> Hindrance: there is no runtime execution trace backend in this path.',
      ].join('\n');
    }

    return [
      '> Provenance: unavailable (no concrete code-path trace could be inferred from the diff).',
      '> Hindrance: the review pipeline did not return a code-path trace payload.',
    ].join('\n');
  }

  private formatCallStackMarkdown(callStack?: string[]): string {
    const lines: string[] = [];

    if (!callStack?.length) {
      lines.push('- (no structured call stack was returned)');
      return lines.join('\n');
    }

    callStack.forEach((frame, index) => {
      const branch = index === callStack.length - 1 ? '└─' : '├─';
      lines.push(`- ${branch} ${frame}`);
    });

    return lines.join('\n');
  }

  private formatStateTransitionMarkdown(
    stateTransition?: Record<string, unknown>,
  ): string {
    const lines: string[] = [];

    if (!stateTransition || Object.keys(stateTransition).length === 0) {
      lines.push('```json');
      lines.push('{}');
      lines.push('```');
      return lines.join('\n');
    }

    lines.push('```json');
    lines.push(JSON.stringify(stateTransition, null, 2));
    lines.push('```');
    return lines.join('\n');
  }
}
