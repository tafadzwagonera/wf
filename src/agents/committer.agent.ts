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

  async execute(ticketKey: string): Promise<void> {
    console.log(chalk.bold.yellow('\n💾 STAGE 5: Commit Changes'));
    console.log(chalk.gray('─'.repeat(70)));

    const status = await this.gitService.getStatus();
    if (status.files.length === 0) {
      console.log(chalk.yellow('⚠ No changes to commit'));
      return;
    }

    console.log(chalk.bold('  Generating commit message...'));

    const diff = await this.gitService.getDiff();
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
    console.log(chalk.cyan(`    git commit -m "${finalMsg}"`));
    console.log(chalk.cyan('    git push'));
  }
}
