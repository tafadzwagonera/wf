import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import type { CodeReview } from '../shared/types/review.types';
import { REVIEW_VERDICT_APPROVED } from '../shared/types/review.types';
import { GitService } from '../integrations/git/git.service';
import { TicketArtifact, ReviewArtifact, ReviewerOptions } from './interfaces';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import { deriveReviewArtifactPath } from '../shared/utils/plan-artifact';
import type { SonarScanResult } from '../review/sonar-scanner';
import { SonarStageService } from '../review/sonar-stage.service';
import { ConfigurationError, ExecutionError } from '../shared/utils/errors';
import { runPostPullDependencyInstall } from '../shared/utils/post-pull-install';
import { resolveVerificationSummary } from '../shared/utils/implement-verification';
import { detectRepoConventions, formatRepoConventionsPromptSection } from '../shared/utils/detect-repo-conventions';

@Injectable()
export class ReviewerAgent {
  constructor(
    private readonly gitService: GitService,
    private readonly reviewStageService: ReviewStageService,
    private readonly sonarStageService: SonarStageService,
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

    await runPostPullDependencyInstall(options.repoDir ?? process.cwd());

    if (!options.suppressHeader && !options.silent) {
      this.presenter.stageHeader(4, 'Code Review');
      this.presenter.separator();
    }

    if (await this.hasNoChanges(options)) return null;
    if (!options.silent) this.presenter.progress('Analyzing changes...');

    const onProgress = options.onProgress
      ?? (options.silent ? undefined : (line: string) => this.presenter.progress(line));

    const repoDir = options.repoDir ?? process.cwd();
    await this.gitService.stageAll(repoDir);
    const sonarResult = await this.runSonarStage(repoDir, ticket, options, onProgress);

    const { review, sessionId } = await this.stageAndReview(ticket, repoDir, options, onProgress, sonarResult);

    return this.reviewStageService.buildReviewArtifact(ticket, review, sessionId);
  }

  persistArtifact(artifact: ReviewArtifact, ticketKey: string): void {
    this.reviewStageService.persistReviewArtifact(artifact, ticketKey);
  }

  private tryLoadCachedReview(ticketPath: string, options: ReviewerOptions): ReviewArtifact | null {
    const reviewPath = deriveReviewArtifactPath(ticketPath);
    if (!options.skipExisting || !fs.existsSync(reviewPath)) return null;

    if (!options.silent) {
      this.presenter.progress(`Skipping REVIEW - artifact exists: ${reviewPath}`);
    }
    const content = fs.readFileSync(reviewPath, 'utf-8');
    const approved = content.includes(`✔ ${REVIEW_VERDICT_APPROVED}`);
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
        ? '⚠  --force requested, but no uncommitted changes are available for review regeneration'
        : '⚠  No uncommitted changes to review';
      this.presenter.outcome('warning', message.replace(/^⚠\s+/, ''));
    }
    return true;
  }

  private async stageAndReview(
    ticket: TicketArtifact,
    repoDir: string,
    options: ReviewerOptions,
    onProgress?: (line: string) => void,
    sonarResult?: SonarScanResult
  ): Promise<{ review: CodeReview; sessionId?: string }> {
    const diff = await this.gitService.getDiff(true, repoDir);

    return this.reviewStageService.reviewDiff(diff, {
      context: this.buildReviewContext(ticket.ticketKey, repoDir),
      additionalContextSections: this.buildAdditionalContextSections(sonarResult),
      repoDir,
      resumeProviderSessionId: options.resumeProviderSessionId,
      priorStageSummary: options.priorStageSummary,
      forkSession: options.forkSession,
      onProgress,
    });
  }

  /**
   * Delegates SonarQube scan for the REVIEW stage to SonarStageService (gating, scope
   * selection, and source-branch fallback live there). Contains CLI failures so that
   * a scan error continues the review without Sonar findings rather than aborting.
   */
  private async runSonarStage(
    repoDir: string, ticket: TicketArtifact, options: ReviewerOptions, onProgress?: (line: string) => void
  ): Promise<SonarScanResult | undefined> {
    try {
      return await this.sonarStageService.scanIfEnabled({
        repoDir,
        force: options.sonar,
        ticketKey: ticket.ticketKey,
        allowPrompt: false,
        onProgress,
      });
    } catch (error) {
      if (!(error instanceof ConfigurationError) && !(error instanceof ExecutionError)) throw error;
      const message = `SonarQube CLI error — continuing review for ${path.basename(repoDir)} without Sonar findings: ${error.message}`;
      if (!options.silent) this.presenter.outcome('warning', message);
      return undefined;
    }
  }

  private buildAdditionalContextSections(sonarResult?: SonarScanResult): string[] | undefined {
    if (!sonarResult?.findingsText) return undefined;
    return [sonarResult.findingsText];
  }

  private buildReviewContext(ticketKey: string, repoDir: string): string {
    const verificationSummary = resolveVerificationSummary(repoDir, ticketKey);
    const conventions = detectRepoConventions(repoDir);
    const conventionsSection = formatRepoConventionsPromptSection(conventions, path.basename(repoDir));
    const extraContext = [verificationSummary, conventionsSection].filter(Boolean).join('\n\n');

    return extraContext ? `ticket ${ticketKey}\n\n${extraContext}` : `ticket ${ticketKey}`;
  }
}
