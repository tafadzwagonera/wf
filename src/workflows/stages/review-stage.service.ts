import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { CodeReview, AiService } from '../../integrations/ai/ai.service';
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
    return `# Code Review: ${ticketKey}

## Summary
${review.summary}

## Issues
${review.issues.map((issue) => `- [${issue.severity}] ${issue.message}${issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : ''}`).join('\n')}

## Suggestions
${review.suggestions.map((suggestion) => `- ${suggestion}`).join('\n')}

## Status
${review.approved ? '✓ Approved' : '✗ Changes needed'}
`;
  }
}
