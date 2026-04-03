// src/agents/reviewer.agent.ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import chalk from 'chalk';
import type { CodeReview } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { TicketArtifact, ReviewArtifact, ReviewerOptions } from './interfaces';
import { ReviewStageService } from '../workflows/stages/review-stage.service';

@Injectable()
export class ReviewerAgent {
  constructor(
    private readonly gitService: GitService,
    private readonly reviewStageService: ReviewStageService,
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
  async execute(
    ticket: TicketArtifact,
    options: ReviewerOptions = {},
  ): Promise<ReviewArtifact | null> {
    const reviewPath = ticket.path.replace('.md', '-review.md');

    if (options.skipExisting && fs.existsSync(reviewPath)) {
      console.log(
        chalk.gray(`🔍 Skipping REVIEW - artifact exists: ${reviewPath}`),
      );
      const content = fs.readFileSync(reviewPath, 'utf-8');
      const approved = content.includes('✓ Approved');
      // Partial stub: full review text is in the markdown file on disk.
      // Only `approved` is meaningful here; `summary`, `issues`, and
      // `suggestions` are empty because we do not re-parse the markdown.
      // Callers must not rely on those fields for a skip-path artifact.
      return {
        review: {
          summary: '',
          issues: [],
          suggestions: [],
          approved,
        } as CodeReview,
        path: reviewPath,
        approved,
      };
    }

    if (!options.suppressHeader) {
      console.log(chalk.bold.yellow('\n🔍 STAGE 4: Code Review'));
      console.log(chalk.gray('─'.repeat(70)));
    }

    const status = await this.gitService.getStatus(options.repoDir);
    if (status.files.length === 0) {
      console.log(chalk.yellow('⚠️  No uncommitted changes to review'));
      return null;
    }

    // Stage all changes (including new untracked files) so the diff captures
    // the full set of changes written by ImplementerAgent.
    await this.gitService.stageAll(options.repoDir);
    const diff = await this.gitService.getDiff(true, options.repoDir);

    console.log(chalk.bold('  Analyzing changes...'));

    const review = await this.reviewStageService.reviewDiff(diff, {
      context: `ticket ${ticket.ticketKey}`,
    });

    console.log(chalk.green('\n✓ Review complete'));
    console.log(chalk.bold('\n  Summary:'), chalk.bold.cyan(review.summary));

    if (review.issues.length > 0) {
      console.log(chalk.bold('\n  Issues found:'));
      review.issues.forEach((issue) => {
        const color =
          issue.severity === 'error'
            ? chalk.red
            : issue.severity === 'warning'
              ? chalk.yellow
              : chalk.blue;
        console.log(color(`    [${issue.severity}] ${issue.message}`));
        if (issue.file) {
          console.log(
            chalk.gray(
              `      ${issue.file}${issue.line ? `:${issue.line}` : ''}`,
            ),
          );
        }
      });
    }

    if (review.suggestions.length > 0) {
      console.log(chalk.bold('\n  Suggestions:'));
      review.suggestions.forEach((s) => console.log(chalk.cyan(`    - ${s}`)));
    }

    console.log(
      chalk.bold('\n  Status:'),
      review.approved
        ? chalk.green('✓ Approved')
        : chalk.red('✗ Changes needed'),
    );

    const artifact = this.reviewStageService.createReviewArtifact(
      ticket,
      review,
    );
    console.log(chalk.gray(`\n  Saved to: ${artifact.path}`));

    return artifact;
  }
}
