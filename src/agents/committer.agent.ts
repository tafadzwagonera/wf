import { Injectable } from '@nestjs/common';
import { GitError } from '../shared/utils/errors';
import { GitService } from '../integrations/git/git.service';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { CommitStageService } from '../workflows/stages/commit-stage.service';

@Injectable()
export class CommitterAgent {
  constructor(
    private readonly gitService: GitService,
    private readonly commitStageService: CommitStageService,
    private readonly presenter: CliPresenter
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
   * @param ticketContext - Optional review/plan summary or ticket description to improve accuracy
   * @param suppressHeader
   * @param silent
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
      this.presenter.stageHeader(5, 'Commit Changes');
      this.presenter.separator();
    }

    const hasChanges = await this.hasChangesToCommit(repoDir, silent);
    if (!hasChanges) return;
    if (!silent) this.presenter.progress('Generating commit message...');

    const finalMsg = await this.buildCommitMessage(ticketKey, repoDir, ticketContext);
    this.logCommitMessage(finalMsg, silent);
    await this.commitChanges(finalMsg, repoDir, silent);
    this.logNextStep(silent);
  }

  /**
   * Only auto-stages everything when nothing has been staged yet — a caller
   * that already ran `git add` on a deliberately scoped set of files (per
   * this project's commit convention) must have that scope respected, not
   * widened to every changed/untracked file in the working tree.
   */
  private async hasChangesToCommit(repoDir?: string, silent?: boolean): Promise<boolean> {
    const status = await this.gitService.getStatus(repoDir);
    if (status.files.length === 0) {
      if (!silent) this.presenter.outcome('warning', 'No changes to commit');
      return false;
    }
    if (!status.staged.length) await this.gitService.stageAll(repoDir);
    return true;
  }

  private async buildCommitMessage(ticketKey: string, repoDir?: string, ticketContext?: string): Promise<string> {
    const diff = await this.gitService.getDiff(true, repoDir);
    const commits = await this.gitService.getRecentCommits(10, repoDir);
    const commitHistory = commits.map(c => c.message);
    return this.commitStageService.generateCommitMessage({ diff, ticketKey, commitHistory, ticketContext });
  }

  private logCommitMessage(message: string, silent?: boolean): void {
    if (silent) return;
    this.presenter.outcome('success', 'Commit message generated');
    this.presenter.detail('Message', message);
  }

  private async commitChanges(message: string, repoDir?: string, silent?: boolean): Promise<void> {
    try {
      await this.gitService.commit({ message, cwd: repoDir });
      if (!silent) this.presenter.outcome('success', 'Changes committed');
    } catch (err) {
      if (err instanceof GitError && err.message === 'No changes to commit') {
        if (!silent) this.presenter.outcome('warning', 'Nothing to commit — skipping');
        return;
      }
      throw err;
    }
  }

  private logNextStep(silent?: boolean): void {
    if (silent) return;
    this.presenter.detail('Next step', 'git push');
  }
}
