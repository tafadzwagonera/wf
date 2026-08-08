// src/agents/reviewer.agent.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import type { CodeReview } from '../shared/types/review.types';
import { REVIEW_VERDICT_APPROVED, REVIEW_VERDICT_CHANGES_REQUESTED } from '../shared/types/review.types';
import { GitService } from '../integrations/git/git.service';
import { TicketArtifact, ReviewArtifact, ReviewerOptions } from './interfaces';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import { deriveReviewArtifactPath } from '../shared/utils/plan-artifact';

@Injectable()
export class ReviewerAgent {
  constructor(
    private readonly gitService: GitService,
    private readonly reviewStageService: ReviewStageService,
    private readonly configService: ConfigService,
    private readonly presenter: CliPresenter
  ) {}

  /**
   * Run the REVIEW stage for the given ticket.
   *
   * Returns null without calling the AI in two cases:
   * - `options.skipExisting` is true and a review artifact already exists on disk
   * - The working tree has no uncommitted changes to review
   *
   * @param ticket - Ticket artifact produced by FetcherAgent (used for key and artifact path)
   * @param options - Optional reviewer configuration
   * @returns ReviewArtifact with review data, disk path, and approval status; or null when skipped
   */
  async execute(ticket: TicketArtifact, options: ReviewerOptions = {}): Promise<ReviewArtifact | null> {
    const cached = this.tryLoadCachedReview(ticket.path, options);
    if (cached) return cached;

    if (!options.suppressHeader && !options.silent) {
      this.presenter.stageHeader(4, 'Code Review');
      this.presenter.separator();
    }

    if (await this.hasNoChanges(options)) return null;
    if (!options.silent) this.presenter.progress('Analyzing changes...');

    const onProgress = options.onProgress
      ?? (options.silent ? undefined : (line: string) => this.presenter.progress(line));

    const { review, sessionId } = await this.stageAndReview(ticket, options, onProgress);
    if (!options.silent) this.logReview(review);

    const artifact = this.reviewStageService.createReviewArtifact(ticket, review, sessionId);
    if (!options.silent) this.presenter.detail('Saved to', artifact.path);
    return artifact;
  }

  private tryLoadCachedReview(ticketPath: string, options: ReviewerOptions): ReviewArtifact | null {
    const reviewPath = deriveReviewArtifactPath(ticketPath);
    if (!options.skipExisting || !fs.existsSync(reviewPath)) return null;

    if (!options.silent) {
      this.presenter.progress(`Skipping REVIEW - artifact exists: ${reviewPath}`);
    }
    const content = fs.readFileSync(reviewPath, 'utf-8');
    const approved = content.includes(`✓ ${REVIEW_VERDICT_APPROVED}`);
    return {
      review: { summary: '', issues: [], suggestions: [], approved } as CodeReview,
      path: reviewPath,
      approved,
    };
  }

  private async hasNoChanges(options: ReviewerOptions): Promise<boolean> {
    const status = await this.gitService.getStatus(options.repoDir);
    if (status.files.length > 0) return false;

    if (!options.silent) {
      const message = options.skipExisting === false
        ? '⚠️  --force requested, but no uncommitted changes are available for review regeneration'
        : '⚠️  No uncommitted changes to review';
      this.presenter.outcome('warning', message.replace(/^⚠️\s+/, ''));
    }
    return true;
  }

  private async stageAndReview(
    ticket: TicketArtifact,
    options: ReviewerOptions,
    onProgress?: (line: string) => void
  ): Promise<{ review: CodeReview; sessionId?: string }> {
    await this.gitService.stageAll(options.repoDir);
    const diff = await this.gitService.getDiff(true, options.repoDir);

    return this.reviewStageService.reviewDiff(diff, {
      context: `ticket ${ticket.ticketKey}`,
      repoDir: options.repoDir,
      resumeProviderSessionId: options.resumeProviderSessionId,
      priorStageSummary: options.priorStageSummary,
      onProgress,
    });
  }

  private logReview(review: CodeReview): void {
    this.presenter.outcome('success', 'Review complete');
    this.presenter.detail('Summary', review.summary);
    this.logIssues(review.issues);
    this.logSuggestions(review.suggestions);
    this.presenter.outcome(
      review.approved ? 'success' : 'error',
      review.approved ? REVIEW_VERDICT_APPROVED : REVIEW_VERDICT_CHANGES_REQUESTED
    );
  }

  private logIssues(issues: CodeReview['issues']): void {
    if (issues.length === 0) return;
    this.presenter.progress('  Issues found:');
    for (const issue of issues) {
      console.log(`    [${issue.severity}] ${issue.message}`);
      if (issue.file) {
        this.presenter.progress(`      ${issue.file}${issue.line ? `:${issue.line}` : ''}`);
      }
    }
  }

  private logSuggestions(suggestions: string[]): void {
    if (suggestions.length === 0) return;
    this.presenter.progress('  Suggestions:');
    for (const s of suggestions) {
      console.log(`    - ${s}`);
    }
  }
}
