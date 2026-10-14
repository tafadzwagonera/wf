import { Injectable, Optional } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import type { CodeReview } from '../shared/types/review.types';
import { REVIEW_VERDICT_APPROVED } from '../shared/types/review.types';
import { GitService } from '../integrations/git/git.service';
import { TicketArtifact, ReviewArtifact, ReviewerOptions } from './interfaces';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import { deriveReviewArtifactPath, parsePlanArtifact } from '../shared/utils/plan-artifact';
import { formatPlanRisksSection } from '../review/format-plan-risks-section';
import type { SonarScanResult } from '../review/sonar-scanner';
import { SonarStageService } from '../review/sonar-stage.service';
import { FigmaStageService, type FigmaResolveResult } from '../review/figma-stage.service';
import { UiDesignScreenshotsStageService } from '../review/ui-design-screenshots-stage.service';
import type { UiDesignScreenshotsResult } from '../shared/types/ui-design-screenshot';
import {
  CommentPolicyStageService,
  mergeCommentPolicyIssues,
} from '../review/comment-policy-stage.service';
import { buildFigmaContextSection } from '../integrations/ai/prompt-fragments';
import { ConfigurationError, ExecutionError } from '../shared/utils/errors';
import { runPostPullDependencyInstall } from '../shared/utils/post-pull-install';
import { resolveVerificationSummary } from '../shared/utils/implement-verification';
import { detectRepoConventions, formatRepoConventionsPromptSection } from '../shared/utils/detect-repo-conventions';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import { appendToLogFile } from '../shared/logger/log-file-writer';

interface DiffReviewInputs {
  onProgress?: (line: string) => void;
  sonarResult?: SonarScanResult;
  figmaResult?: FigmaResolveResult;
  uiResult?: UiDesignScreenshotsResult;
  commentPolicyEnabled: boolean;
}

@Injectable()
export class ReviewerAgent {
  constructor(
    private readonly gitService: GitService,
    private readonly reviewStageService: ReviewStageService,
    private readonly sonarStageService: SonarStageService,
    private readonly figmaStageService: FigmaStageService,
    @Optional() private readonly commentPolicyStageService: CommentPolicyStageService,
    private readonly presenter: CliPresenter,
    @Optional() private readonly uiDesignScreenshotsStageService?: UiDesignScreenshotsStageService
  ) {}

  private presentReviewHeader(options: ReviewerOptions): void {
    if (!options.suppressHeader && !options.silent) {
      this.presenter.stageHeader(4, 'Code Review');
      this.presenter.separator();
    }
  }

  /**
   * Run the REVIEW stage for the given ticket.
   *
   * Returns null without calling the AI in two cases:
   * - `options.skipExisting` is true and a review artifact already exists on disk
   * - The working tree has no uncommitted changes to review
   *
   * @param ticket
   * @param options - Optional reviewer configuration
   * @returns ReviewArtifact with review data, disk path, and approval status; or null when skipped
   */
  async execute(ticket: TicketArtifact, options: ReviewerOptions = {}): Promise<ReviewArtifact | null> {
    const cached = this.tryLoadCachedReview(ticket.path, options);
    if (cached) return cached;
    this.presentReviewHeader(options);
    await runPostPullDependencyInstall(options.repoDir ?? process.cwd());
    if (await this.hasNoChanges(options)) return null;
    if (!options.silent) this.presenter.progress('Analyzing changes...');
    const onProgress = options.onProgress
      ?? (options.silent ? undefined : (line: string) => this.presenter.progress(line));
    const repoDir = options.repoDir ?? process.cwd();
    const { review, sessionId, modelUsed } = await this.runStages(ticket, repoDir, options, onProgress);
    return this.reviewStageService.buildReviewArtifact(
      ticket, review, sessionId, this.deriveRepoScope(options), modelUsed
    );
  }

  private async runStages(
    ticket: TicketArtifact, repoDir: string, options: ReviewerOptions, onProgress: ((line: string) => void) | undefined,
  ) {
    await this.gitService.stageAll(repoDir);
    const [sonarResult, figmaResult, uiResult] = await Promise.all([
      this.runSonarStage(repoDir, ticket, options, onProgress),
      this.runFigmaStage(repoDir, ticket, options, onProgress),
      this.runUiDesignScreenshotsStage(options, onProgress),
    ]);
    return this.stageAndReview(ticket, repoDir, options, onProgress, sonarResult, figmaResult, uiResult);
  }

  persistArtifact(artifact: ReviewArtifact, ticketKey: string): void {
    this.reviewStageService.persistReviewArtifact(artifact, ticketKey);
  }

  private deriveRepoScope(options: ReviewerOptions): string | undefined {
    return options.repoDir ? path.basename(options.repoDir) : undefined;
  }

  private tryLoadCachedReview(ticketPath: string, options: ReviewerOptions): ReviewArtifact | null {
    const reviewPath = deriveReviewArtifactPath(ticketPath, this.deriveRepoScope(options));
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
    ticket: TicketArtifact, repoDir: string, options: ReviewerOptions,
    onProgress?: (line: string) => void, sonarResult?: SonarScanResult, figmaResult?: FigmaResolveResult,
    uiResult?: UiDesignScreenshotsResult
  ): Promise<{ review: CodeReview; sessionId?: string; modelUsed?: string }> {
    const diff = await this.gitService.getDiff(true, repoDir);
    const commentPolicyResult = await this.commentPolicyStageService?.scanIfEnabled(
      { diff, force: options.commentPolicy });

    const commentPolicyEnabled = commentPolicyResult !== undefined;
    const reviewOptions = this.buildDiffReviewOptions(ticket, repoDir, options,
      { onProgress, sonarResult, figmaResult, uiResult, commentPolicyEnabled });
    const { review, sessionId, modelUsed } = await this.reviewStageService.reviewDiff(diff, reviewOptions);
    return { review: mergeCommentPolicyIssues(review, commentPolicyResult), sessionId, modelUsed };
  }

  private buildDiffReviewOptions(
    ticket: TicketArtifact, repoDir: string, options: ReviewerOptions, inputs: DiffReviewInputs
  ): Parameters<ReviewStageService['reviewDiff']>[1] {
    return {
      context: this.buildReviewContext(ticket.ticketKey, repoDir, options.planArtifactPath),
      additionalContextSections: this.buildAdditionalContextSections(inputs.sonarResult),
      repoDir,
      resumeProviderSessionId: options.resumeProviderSessionId,
      priorStageSummary: options.priorStageSummary,
      forkSession: options.forkSession,
      onProgress: inputs.onProgress,
      onProviderSessionId: options.onProviderSessionId,
      figmaContextSection: buildFigmaContextSection(inputs.figmaResult?.frames ?? []),
      ...(inputs.uiResult ? { screenshots: inputs.uiResult.screenshots } : {}),
      commentPolicyEnabled: inputs.commentPolicyEnabled,
    };
  }

  private async runUiDesignScreenshotsStage(
    options: ReviewerOptions, onProgress?: (line: string) => void
  ): Promise<UiDesignScreenshotsResult | undefined> {
    if (!this.uiDesignScreenshotsStageService || !options.planArtifactPath) return undefined;
    return this.uiDesignScreenshotsStageService.resolveIfEnabled({
      artifactPath: options.planArtifactPath,
      onProgress,
    });
  }

  /**
   * Delegates SonarQube scan for the REVIEW stage to SonarStageService (gating, scope
   * selection, and source-branch fallback live there). Contains CLI failures so that
   * a scan error continues the review without Sonar findings rather than aborting. The
   * failure warning is always shown and logged at WARN, even when `silent` is set.
   */
  private async runSonarStage(
    repoDir: string, ticket: TicketArtifact, options: ReviewerOptions, onProgress?: (line: string) => void
  ): Promise<SonarScanResult | undefined> {
    const [scan] = await executeAsyncWithCatch({
      fn: () => this.sonarStageService.scanIfEnabled({
        repoDir,
        force: options.sonar,
        ticketKey: ticket.ticketKey,
        allowPrompt: false,
        onProgress,
      }),
      rethrowIf: error => !(error instanceof ConfigurationError) && !(error instanceof ExecutionError),
      onError: error => {
        const message = `SonarQube CLI error — continuing review for ${path.basename(repoDir)} without Sonar findings: ${(error as Error).message}`;
        appendToLogFile('WARN', message, 'sonar-stage');
        this.presenter.outcome('warning', message);
      },
    });
    return scan;
  }

  private async runFigmaStage(
    repoDir: string, ticket: TicketArtifact, options: ReviewerOptions, onProgress?: (line: string) => void
  ): Promise<FigmaResolveResult | undefined> {
    return this.figmaStageService.resolveIfEnabled({
      repoDir,
      force: options.figma,
      ticketKey: ticket.ticketKey,
      artifactPath: options.planArtifactPath,
      artifactDir: options.planArtifactPath
        ? path.dirname(options.planArtifactPath)
        : path.dirname(ticket.path),
      onProgress,
    });
  }

  private buildAdditionalContextSections(sonarResult?: SonarScanResult): string[] | undefined {
    if (!sonarResult?.findingsText) return undefined;
    return [sonarResult.findingsText];
  }

  private buildReviewContext(ticketKey: string, repoDir: string, planArtifactPath?: string): string {
    const verificationSummary = resolveVerificationSummary(repoDir, ticketKey);
    const conventions = detectRepoConventions(repoDir);
    const conventionsSection = formatRepoConventionsPromptSection(conventions, path.basename(repoDir));
    const risksSection = this.loadPlanRisksSection(planArtifactPath);
    const extraContext = [verificationSummary, conventionsSection, risksSection].filter(Boolean).join('\n\n');

    return extraContext ? `ticket ${ticketKey}\n\n${extraContext}` : `ticket ${ticketKey}`;
  }

  private loadPlanRisksSection(planArtifactPath?: string): string {
    if (!planArtifactPath) return '';

    try {
      const content = fs.readFileSync(planArtifactPath, 'utf-8');
      const plan = parsePlanArtifact(content, planArtifactPath);
      return formatPlanRisksSection(plan.risks);
    } catch (error) {
      const message = `unable to load plan risks from ${planArtifactPath}: `
        + (error instanceof Error ? error.message : String(error));
      appendToLogFile('WARN', message, 'plan-risks');
      this.presenter.outcome('warning', message);
      return '';
    }
  }
}
