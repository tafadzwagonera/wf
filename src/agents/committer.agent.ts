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
   * Generate a commit message for uncommitted changes and print the git commands
   * needed to stage, commit, and push. Does not execute any git commands itself.
   *
   * Returns early with a warning if the working tree has no modified or untracked files.
   *
   * @param ticketKey - The ticket identifier prepended to the commit message (e.g. WBP-1234)
   * @returns A promise that resolves when guidance has been printed
   */
  async execute(ticketKey: string): Promise<void> {
    console.log(chalk.bold.yellow('\n💾 STAGE 5: Commit Changes'));
    console.log(chalk.gray('─'.repeat(70)));

    const status = await this.gitService.getStatus();
    if (status.files.length === 0) {
      console.log(chalk.yellow('⚠ No changes to commit'));
      return;
    }

    console.log(chalk.bold('  Generating commit message...'));

    const diff = await this.gitService.getDiff(true);
    const commits = await this.gitService.getRecentCommits(10);
    const commitHistory = commits.map((c) => c.message);

    const commitMsg = await this.claudeService.generateCommitMessage(
      diff,
      commitHistory,
      'auto',
    );
    const finalMsg = `${ticketKey}: ${commitMsg}`;

    console.log(chalk.green('\n✓ Commit message generated'));
    console.log(chalk.bold('\n  Message:'));
    console.log(chalk.white(`    ${finalMsg}`));
    console.log(chalk.bold('\n  Commands:'));
    console.log(chalk.cyan('    git add .'));
    const escapedMsg = finalMsg.replace(/"/g, '\\"');
    console.log(chalk.cyan(`    git commit -m "${escapedMsg}"`));
    console.log(chalk.cyan('    git push'));
  }
}
