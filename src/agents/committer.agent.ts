// src/agents/committer.agent.ts
import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import { AiService } from '../integrations/ai/ai.service';
import { GitError } from '../shared/utils/errors';
import { GitService } from '../integrations/git/git.service';

@Injectable()
export class CommitterAgent {
  constructor(
    private aiService: AiService,
    private gitService: GitService,
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
  ): Promise<void> {
    console.log(chalk.bold.yellow('\n💾 STAGE 5: Commit Changes'));
    console.log(chalk.gray('─'.repeat(70)));

    const status = await this.gitService.getStatus(repoDir);
    if (status.files.length === 0) {
      console.log(chalk.yellow('⚠ No changes to commit'));
      return;
    }

    console.log(chalk.bold('  Generating commit message...'));

    const diff = await this.gitService.getDiff(false, repoDir);
    const commits = await this.gitService.getRecentCommits(10, repoDir);
    const commitHistory = commits.map((c) => c.message);

    const rawMsg = await this.aiService.generateCommitMessage(
      diff,
      commitHistory,
      'auto',
      ticketContext,
    );
    // Strip conventional commit type prefix (e.g. "fix: ", "test(scope): ") and any
    // ticket-key prefix the LLM may have mirrored from commit history (e.g. "WBP-2979: ")
    // so the active ticketKey is always the sole prefix: "TAD-575: <description>"
    const commitMsg = rawMsg
      .replace(/^[a-z]+(\([^)]+\))?:\s*/, '')  // strip conventional prefix
      .replace(/^[A-Z][A-Z0-9]+-\d+:\s*/, ''); // strip ticket-key prefix
    const finalMsg = `${ticketKey}: ${commitMsg}`;

    console.log(chalk.green('\n✓ Commit message generated'));
    console.log(chalk.bold('\n  Message:'));
    console.log(chalk.bold.cyan(`    ${finalMsg}`));

    try {
      await this.gitService.commit({ message: finalMsg, cwd: repoDir });
      console.log(chalk.green('\n✓ Changes committed'));
    } catch (err) {
      if (err instanceof GitError && err.message === 'No changes to commit') {
        console.log(chalk.yellow('\n⚠ Nothing to commit — skipping'));
        return;
      }
      throw err;
    }

    console.log(chalk.bold('\n  Next step:'));
    console.log(chalk.cyan('    git push'));
  }
}
