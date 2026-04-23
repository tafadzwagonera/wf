import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import simpleGit, { SimpleGit, StatusResult, BranchSummary } from 'simple-git';
import { GitError } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';

export interface BranchInfo {
  current: string;
  all: string[];
  development?: string;
  isClean: boolean;
  hasUncommittedChanges: boolean;
}

export interface CommitOptions {
  message: string;
  files?: string[];
  allowEmpty?: boolean;
  cwd?: string;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: Date;
}

@Injectable()
export class GitService {
  private git: SimpleGit;
  private defaultBranch: string;

  constructor(
    private configService: ConfigService,
    private logger: LoggerService,
  ) {
    this.git = simpleGit();
    this.defaultBranch = this.configService.get<string>(
      'git.defaultBranch',
      'develop',
    );
  }

  async isGitRepository(cwd?: string): Promise<boolean> {
    const git = cwd ? simpleGit(cwd) : this.git;
    try {
      await git.status();
      return true;
    } catch {
      return false;
    }
  }

  async getBranchInfo(cwd?: string): Promise<BranchInfo> {
    const git = cwd ? simpleGit(cwd) : this.git;
    try {
      const status: StatusResult = await git.status();
      const branches: BranchSummary = await git.branch();

      // Detect development branch
      const devBranch = this.detectDevelopmentBranch(branches.all);

      return {
        current: status.current || 'HEAD',
        all: branches.all,
        development: devBranch,
        isClean: status.isClean(),
        hasUncommittedChanges: !status.isClean(),
      };
    } catch (error) {
      throw new GitError('Failed to get branch information', error);
    }
  }

  private detectDevelopmentBranch(branches: string[]): string | undefined {
    const devPatterns = ['develop', 'devel', 'dev', 'development'];

    for (const pattern of devPatterns) {
      const found = branches.find(
        (b) => b === pattern || b.endsWith(`/${pattern}`),
      );
      if (found) return found;
    }

    return this.defaultBranch;
  }

  async createBranch(
    branchName: string,
    baseBranch?: string,
    cwd?: string,
  ): Promise<void> {
    const git = cwd ? simpleGit(cwd) : this.git;
    try {
      // Validate branch name
      if (!this.isValidBranchName(branchName)) {
        throw new GitError(
          `Invalid branch name: ${branchName}. Branch names should follow pattern: feature/name or WBP-1234__feature-name`,
        );
      }

      const status = await git.status();
      const branches = await git.branch();

      // Check if branch already exists
      if (branches.all.includes(branchName)) {
        this.logger.warn(
          `Branch ${branchName} already exists, checking out...`,
        );
        await git.checkout(branchName);
        return;
      }

      // Determine base branch
      const devBranch = this.detectDevelopmentBranch(branches.all);
      const base = baseBranch || devBranch || status.current;

      // Create and checkout new branch
      await git.checkoutLocalBranch(branchName);

      this.logger.success(
        `Created and checked out branch: ${branchName} from ${base}`,
      );
    } catch (error) {
      if (error instanceof GitError) {
        throw error;
      }
      throw new GitError(`Failed to create branch: ${branchName}`, error);
    }
  }

  private isValidBranchName(name: string): boolean {
    // Allow patterns like: feature/name, WBP-1234__feature-name, fix/bug-name
    const validPatterns = [
      /^[a-z]+\/[\w-]+$/, // feature/name
      /^[A-Z]+-\d+__[\w-]+$/, // WBP-1234__feature-name
      /^[\w-]+$/, // simple-name
    ];

    return validPatterns.some((pattern) => pattern.test(name));
  }

  async commit(options: CommitOptions): Promise<string> {
    try {
      // Always create a fresh instance so LEFTHOOK=0 can be set without
      // mutating the shared this.git. LEFTHOOK=0 is the officially supported
      // skip mechanism — all Lefthook-generated hooks check this var and
      // exit 0 immediately, preventing hangs in automated commit flows.
      const git = simpleGit(options.cwd ?? process.cwd()).env({
        ...process.env,
        LEFTHOOK: '0',
      });

      const status = await git.status();

      // If specific files provided, add them
      if (options.files && options.files.length > 0) {
        await git.add(options.files);
      } else if (!status.staged.length && status.files.length > 0) {
        // Add all modified files if nothing is staged, excluding .wf/** runtime
        // artifacts and wf config files that wf writes into the consuming app's
        // directory. See src/config/wf-config-loader.ts for the full list of
        // recognized config file names.
        const filesToAdd = this.filterStageable(
          status.files.map((f) => f.path),
        );
        if (filesToAdd.length > 0) {
          await git.add(filesToAdd);
        }
      }

      // Check if there are changes to commit
      const updatedStatus = await git.status();
      if (!updatedStatus.staged.length && !options.allowEmpty) {
        throw new GitError('No changes to commit');
      }

      // Create commit
      const result = await git.commit(options.message);

      this.logger.success(`Created commit: ${result.commit}`);
      return result.commit;
    } catch (error) {
      if (error instanceof GitError) {
        throw error;
      }
      const e = error as Record<string, unknown>;
      const detail = e?.git ?? e?.message ?? error;
      throw new GitError('Failed to create commit', detail);
    }
  }

  async getRecentCommits(
    count: number = 10,
    cwd?: string,
  ): Promise<CommitInfo[]> {
    try {
      const git = cwd ? simpleGit(cwd) : this.git;
      const log = await git.log({ maxCount: count });

      return log.all.map((commit) => ({
        hash: commit.hash,
        message: commit.message,
        author: commit.author_name,
        date: new Date(commit.date),
      }));
    } catch (error) {
      throw new GitError('Failed to get commit history', error);
    }
  }

  async getDiff(staged: boolean = false, cwd?: string): Promise<string> {
    try {
      const git = cwd ? simpleGit(cwd) : this.git;
      const diff = staged ? await git.diff(['--staged']) : await git.diff();
      return diff;
    } catch (error) {
      throw new GitError('Failed to get diff', error);
    }
  }

  /**
   * Stage all modified and new files, excluding wf tooling artifacts:
   * - `.wf/**` — runtime state/log directories written by wf
   * - `wf.config.{js,mjs,ts,mts,yaml,yml}` — wf CLI config files that the
   *   implementer agent may create inside a target repo; these are tooling
   *   inputs, not code changes for the ticket.
   * - `dist/` — compiled build output that should not be committed to tickets
   * - `.gitignore` — managed by the repo owner; wf must not alter ignore rules
   *
   * Exclusions are applied by filtering the paths returned by `git.status()`
   * against {@link GitService.EXCLUDED_PATHS} and passing the filtered list
   * directly to `git.add()`. This avoids pathspec exclude magic (`:!` prefix)
   * which has known portability issues on macOS and with certain git versions.
   *
   * See `src/config/wf-config-loader.ts` for the canonical list of recognized
   * config file names. Any new extension added there must also be added here,
   * and the {@link GitService.EXCLUDED_PATHS} regex must be updated to match.
   *
   * Safe to call when nothing is staged yet; idempotent if run again.
   *
   * @param cwd - Optional repository directory; defaults to process.cwd()
   */
  async stageAll(cwd?: string): Promise<void> {
    try {
      const git = cwd ? simpleGit(cwd) : this.git;
      const status = await git.status();
      const filesToAdd = this.filterStageable(status.files.map((f) => f.path));
      if (filesToAdd.length > 0) {
        await git.add(filesToAdd);
      }
    } catch (error) {
      if (error instanceof GitError) {
        throw error;
      }
      const e = error as Record<string, unknown>;
      const detail = e?.git ?? e?.message ?? error;
      throw new GitError('Failed to stage all changes', detail);
    }
  }

  /**
   * Regex that matches paths that must never be staged by wf:
   * - `.wf/` or `.wf\` prefix — runtime state/log artifacts
   * - `wf.config.{js,mjs,ts,mts,yaml,yml}` — tooling config files
   * - `dist/` or `dist\` prefix — compiled build output
   * - `.gitignore` — git ignore rules are managed by the repo owner, not wf
   *
   * Uses `[/\\]` so it handles both POSIX and Windows path separators.
   */
  private static readonly EXCLUDED_PATHS =
    /^\.wf[/\\]|^wf\.config\.(js|mjs|ts|mts|yaml|yml)$|^dist[/\\]|^\.gitignore$/;

  /**
   * Filter a list of file paths, removing any that match {@link EXCLUDED_PATHS}.
   *
   * @param paths - File paths as returned by `StatusResult.files[n].path`
   * @returns Paths that are safe to pass to `git.add()`
   */
  private filterStageable(paths: string[]): string[] {
    return paths.filter((p) => !GitService.EXCLUDED_PATHS.test(p));
  }

  async stashChanges(message?: string): Promise<void> {
    try {
      await this.git.stash(['push', '-m', message || 'Auto-stashed by wf']);
      this.logger.success('Stashed uncommitted changes');
    } catch (error) {
      throw new GitError('Failed to stash changes', error);
    }
  }

  async stashPop(): Promise<void> {
    try {
      await this.git.stash(['pop']);
      this.logger.success('Restored stashed changes');
    } catch (error) {
      throw new GitError('Failed to restore stashed changes', error);
    }
  }

  async getStatus(cwd?: string): Promise<StatusResult> {
    try {
      const git = cwd ? simpleGit(cwd) : this.git;
      return await git.status();
    } catch (error) {
      throw new GitError('Failed to get git status', error);
    }
  }

  async getCurrentBranch(cwd?: string): Promise<string> {
    try {
      const git = cwd ? simpleGit(cwd) : this.git;
      const status = await git.status();
      return status.current || 'HEAD';
    } catch (error) {
      throw new GitError('Failed to get current branch', error);
    }
  }

  async checkoutBranch(branchName: string): Promise<void> {
    try {
      await this.git.checkout(branchName);
      this.logger.success(`Checked out branch: ${branchName}`);
    } catch (error) {
      throw new GitError(`Failed to checkout branch: ${branchName}`, error);
    }
  }

  async pull(remote: string = 'origin', branch?: string): Promise<void> {
    try {
      const currentBranch = branch || (await this.getCurrentBranch());
      await this.git.pull(remote, currentBranch);
      this.logger.success(
        `Pulled latest changes from ${remote}/${currentBranch}`,
      );
    } catch (error) {
      throw new GitError('Failed to pull changes', error);
    }
  }

  async push(
    remote: string = 'origin',
    branch?: string,
    setUpstream: boolean = false,
  ): Promise<void> {
    try {
      const currentBranch = branch || (await this.getCurrentBranch());

      if (setUpstream) {
        await this.git.push(['-u', remote, currentBranch]);
        this.logger.success(
          `Pushed and set upstream: ${remote}/${currentBranch}`,
        );
      } else {
        await this.git.push(remote, currentBranch);
        this.logger.success(`Pushed to ${remote}/${currentBranch}`);
      }
    } catch (error) {
      throw new GitError('Failed to push changes', error);
    }
  }
}
