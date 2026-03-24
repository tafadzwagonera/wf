// src/agents/committer.agent.ts
import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import { ClaudeService } from '../integrations/ai/claude.service';
import { GitService } from '../integrations/git/git.service';

@Injectable()
export class CommitterAgent {
  constructor(
    private claudeService: ClaudeService,
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

    const rawMsg = await this.claudeService.generateCommitMessage(
      diff,
      commitHistory,
      'auto',
      ticketContext,
    );
    // Strip conventional commit type prefix (e.g. "fix: ", "test(scope): ") so the
    // ticket key is always the sole prefix: "WBP-1234: <description>"
    const commitMsg = rawMsg.replace(/^[a-z]+(\([^)]+\))?:\s*/, '');
    const finalMsg = `${ticketKey}: ${commitMsg}`;

    console.log(chalk.green('\n✓ Commit message generated'));
    console.log(chalk.bold('\n  Message:'));
    console.log(chalk.bold.cyan(`    ${finalMsg}`));

    await this.gitService.commit({ message: finalMsg, cwd: repoDir });
    console.log(chalk.green('\n✓ Changes committed'));

    console.log(chalk.bold('\n  Next step:'));
    console.log(chalk.cyan('    git push'));
  }
}
