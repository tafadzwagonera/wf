// src/agents/committer.agent.ts
import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import { GitError } from '../shared/utils/errors';
import { GitService } from '../integrations/git/git.service';
import { CommitStageService } from '../workflows/stages/commit-stage.service';

@Injectable()
export class CommitterAgent {
  constructor(
    private readonly gitService: GitService,
    private readonly commitStageService: CommitStageService
  ) {}

  /**
   * Generate a commit message for uncommitted changes, stage all files, and
   * create a git commit in the given repo directory. Prints `git push` as a
   * manual next step but does not execute it.
   *
   * Returns early with a warning if the working tree has no modified or untracked files.
   *
   * @param ticketKey - The ticket identifier prepended to the commit message (e.g. WBP-1234)
   * @param repoDir - Optional path to the repository directory
   * @param ticketContext - Optional plan summary or ticket description used to improve commit message accuracy
   * @returns A promise that resolves when the commit has been created
   */
  async execute(
    ticketKey: string,
    repoDir?: string,
    ticketContext?: string,
    suppressHeader?: boolean,
    silent?: boolean
  ): Promise<void> {
    if (!suppressHeader && !silent) {
      console.log(chalk.bold.yellow('\n💾 STAGE 5: Commit Changes'));
      console.log(chalk.gray('─'.repeat(70)));
    }

    const status = await this.gitService.getStatus(repoDir);
    if (status.files.length === 0) {
      if (!silent) {
        console.log(chalk.yellow('⚠️  No changes to commit'));
      }
      return;
    }

    if (!silent) {
      console.log(chalk.bold('  Generating commit message...'));
    }

    const diff = await this.gitService.getDiff(false, repoDir);
    const commits = await this.gitService.getRecentCommits(10, repoDir);
    const commitHistory = commits.map(c => c.message);

    const finalMsg = await this.commitStageService.generateCommitMessage({
      diff,
      ticketKey,
      commitHistory,
      ticketContext,
    });

    if (!silent) {
      console.log(chalk.green('\n✓ Commit message generated'));
      console.log(chalk.bold('\n  Message:'));
      console.log(chalk.bold.cyan(`    ${finalMsg}`));
    }

    try {
      await this.gitService.commit({ message: finalMsg, cwd: repoDir });
      if (!silent) {
        console.log(chalk.green('\n✓ Changes committed'));
      }
    } catch (err) {
      if (err instanceof GitError && err.message === 'No changes to commit') {
        if (!silent) {
          console.log(chalk.yellow('\n⚠️ Nothing to commit — skipping'));
        }
        return;
      }
      throw err;
    }

    if (!silent) {
      console.log(chalk.bold('\n  Next step:'));
      console.log(chalk.cyan('    git push'));
    }
  }
}
