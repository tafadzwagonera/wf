import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import simpleGit, { BranchSummary, SimpleGit, StatusResult } from 'simple-git';
import { GitError } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';
import type { BranchInfo, CommitInfo, CommitOptions } from '../../shared/types/git.types';

export type { BranchInfo, CommitOptions, CommitInfo } from '../../shared/types/git.types';

/**
 * Create a SimpleGit instance pointed at the given directory.
 *
 * @param cwd - Optional repository working directory
 * @returns A configured SimpleGit instance
 */
const createGit = (cwd?: string): SimpleGit =>
  simpleGit({ baseDir: cwd });

/**
 * Create a SimpleGit instance for `cwd` with LEFTHOOK disabled so automated
 * commit flows are not blocked by git hooks.
 *
 * @param cwd - Repository working directory
 * @returns A SimpleGit instance with LEFTHOOK=0 in its environment
 */
const createCommitGit = (cwd: string): SimpleGit =>
  createGit(cwd).env({ ...process.env, LEFTHOOK: '0' });

const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'develop'];

/**
 * Re-throw `error` as a {@link GitError} unless it already is one, extracting
 * the most descriptive detail available from the raw error object.
 *
 * @param error - The caught value
 * @param message - Human-readable error message for the GitError
 * @returns Never — always throws
 */
const wrapGitError = (error: unknown, message: string): never => {
  if (error instanceof GitError) throw error;
  const e = error as Record<string, unknown>;
  const detail = e?.git ?? e?.message ?? error;
  throw new GitError(message, detail);
};

/**
 * Detect the pathspec-not-found failure `git add` raises when a path it was
 * asked to stage no longer exists in any form (working tree, index, or HEAD)
 * — typically because another process already committed its deletion between
 * this call's `git status()` read and its `git add()` write.
 *
 * @param error - The caught value from a failed `git.add()` call
 * @returns True when the error is this specific vanished-pathspec failure
 */
const extractErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  const e = error as Record<string, unknown>;
  if (typeof e?.message === 'string') return e.message;
  if (typeof e?.git === 'string') return e.git;
  return '';
};

const isMissingPathspecError = (error: unknown): boolean => /did not match any files/i.test(extractErrorText(error));

/**
 * Assemble a {@link BranchInfo} value object from git status and branch data.
 *
 * @param status - Current git status
 * @param branches - Current branch summary
 * @param devBranches - Detected development branches (first entry used as primary)
 * @returns Populated BranchInfo
 */
const buildBranchInfo = (
  status: StatusResult,
  branches: BranchSummary,
  devBranches: string[]
): BranchInfo => ({
  current: status.current ?? 'HEAD',
  all: branches.all,
  development: devBranches[0],
  isClean: status.isClean(),
  hasUncommittedChanges: !status.isClean(),
});

/**
 * Resolve the base branch to create a new branch from.
 *
 * @param branches - Full branch summary from simple-git
 * @param currentBranch - Currently checked-out branch name (may be null)
 * @param baseBranch - Caller-supplied override; takes precedence when set
 * @returns The branch name to use as the base
 */
const resolveBaseBranch = (
  branches: BranchSummary,
  currentBranch: string | null,
  baseBranch?: string
): string => {
  const devBranch = branches.all.find(b => {
    const name = b.includes('/') ? b.split('/').at(-1) ?? b : b;
    return name.includes('dev');
  });
  return baseBranch ?? devBranch ?? currentBranch ?? 'HEAD';
};

/**
 * Parses `git rev-list --pretty=format:%H%x00%s --no-commit-header` output
 * into hash/subject pairs, one per commit.
 *
 * @param output - Raw rev-list output
 * @returns Array of `{hash, subject}` pairs, ordered newest first
 */
const parseRevListOutput = (output: string): { hash: string; subject: string }[] =>
  output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [hash, subject] = line.split('\0');
      return { hash, subject };
    });

/**
 * Run `git check-ignore` on a single chunk of paths, returning the ignored subset.
 * exit code 1 from git means "none ignored" — that is not an error.
 *
 * @param git - SimpleGit instance to use
 * @param chunk - Slice of paths to check (should be ≤ 100 to stay within OS arg limits)
 * @returns The paths from `chunk` that are gitignored
 */
const checkIgnoredChunk = async (git: SimpleGit, chunk: string[]): Promise<string[]> => {
  try {
    const result = await git.raw(['check-ignore', ...chunk]);
    return result
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

@Injectable()
export class GitService {
  private readonly git: SimpleGit;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService
  ) {
    this.git = createGit();
  }

  async isGitRepository(cwd?: string): Promise<boolean> {
    const git = cwd ? createGit(cwd) : this.git;
    try {
      await git.status();
      return true;
    } catch {
      return false;
    }
  }

  async getBranchInfo(cwd?: string): Promise<BranchInfo> {
    const git = cwd ? createGit(cwd) : this.git;
    try {
      const status: StatusResult = await git.status();
      const branches: BranchSummary = await git.branch();
      const devBranches = this.detectDevelopmentBranches(branches.all);
      return buildBranchInfo(status, branches, devBranches);
    } catch (error) {
      throw new GitError('Failed to get branch information', error);
    }
  }

  detectDevelopmentBranches(branches: string[]): string[] {
    return branches.filter(b => {
      const name = b.includes('/') ? b.split('/').at(-1) ?? b : b;
      return name.includes('dev');
    });
  }

  detectMainBranch(branches: string[]): string | undefined {
    const mainPatterns = ['main', 'master'];

    for (const pattern of mainPatterns) {
      const found = branches.find(b => b === pattern || b.endsWith(`/${pattern}`));
      if (found) return found;
    }

    return undefined;
  }

  async hasUpstream(branchName: string, cwd?: string): Promise<boolean> {
    const git = cwd ? createGit(cwd) : this.git;
    try {
      await git.raw(['rev-parse', '--abbrev-ref', `${branchName}@{upstream}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async checkoutOrCreateBranch(git: SimpleGit, branchName: string, baseBranch?: string): Promise<void> {
    const [status, branches] = await Promise.all([git.status(), git.branch()]);
    if (branches.all.includes(branchName)) return this.checkoutExistingBranch(git, branchName);
    const base = resolveBaseBranch(branches, status.current, baseBranch);
    await git.checkout(['-b', branchName, base]);
    this.logger.success(`Created and checked out branch: ${branchName} from ${base}`);
  }

  async createBranch(branchName: string, baseBranch?: string, cwd?: string): Promise<void> {
    const git = cwd ? createGit(cwd) : this.git;
    try {
      this.assertValidBranchName(branchName);
      await this.checkoutOrCreateBranch(git, branchName, baseBranch);
    } catch (error) {
      wrapGitError(error, `Failed to create branch: ${branchName}`);
    }
  }

  /**
   * Throw a {@link GitError} if `name` does not match any recognised branch
   * name pattern (feature/name, WBP-1234__feature-name, or simple-name).
   *
   * @param name - Branch name to validate
   */
  private assertValidBranchName(name: string): void {
    if (!this.isValidBranchName(name)) {
      throw new GitError(
        `Invalid branch name: ${name}. Branch names should follow pattern: feature/name or WBP-1234__feature-name`
      );
    }
  }

  /**
   * Check out an already-existing local branch and log a warning.
   *
   * @param git - SimpleGit instance to use
   * @param branchName - Name of the branch to check out
   */
  private async checkoutExistingBranch(git: SimpleGit, branchName: string): Promise<void> {
    this.logger.warn(`Branch ${branchName} already exists, checking out...`);
    await git.checkout(branchName);
  }

  private isValidBranchName(name: string): boolean {
    // Allow patterns like: feature/name, WBP-1234__feature-name, fix/bug-name
    const validPatterns = [
      /^[a-z]+\/[\w-]+$/, // feature/name
      /^[A-Z]+-\d+__[\w-]+$/, // WBP-1234__feature-name
      /^[\w-]+$/, // simple-name
    ];

    return validPatterns.some(pattern => pattern.test(name));
  }

  async commit(options: CommitOptions): Promise<string> {
    try {
      const git = createCommitGit(options.cwd ?? process.cwd());
      const status = await git.status();
      this.ensureGitignoreIsNotStaged(status.staged);
      await this.stageFilesForCommit(git, status, options.files);
      return await this.finaliseCommit(git, options);
    } catch (error) {
      return wrapGitError(error, 'Failed to create commit');
    }
  }

  /**
   * Verify staged files, then create the git commit and return its hash.
   *
   * @param git - SimpleGit instance (LEFTHOOK=0 already set)
   * @param options - Commit options including message and allowEmpty flag
   * @returns The short commit hash
   */
  private async finaliseCommit(git: SimpleGit, options: CommitOptions): Promise<string> {
    const updatedStatus = await git.status();
    this.ensureGitignoreIsNotStaged(updatedStatus.staged);
    if (!updatedStatus.staged.length && !options.allowEmpty) {
      throw new GitError('No changes to commit');
    }
    const result = await git.commit(options.message);
    this.logger.success(`Created commit: ${result.commit}`);
    return result.commit;
  }

  /**
   * Stage files for a commit: explicit files when provided, otherwise all
   * stageable modified files that are not already staged.
   *
   * @param git - SimpleGit instance to use
   * @param status - Current git status snapshot
   * @param files - Optional explicit list of files to stage
   */
  private async stageFilesForCommit(
    git: SimpleGit,
    status: StatusResult,
    files?: string[]
  ): Promise<void> {
    if (files && files.length > 0) {
      this.ensureGitignoreIsNotStaged(files);
      await git.add(files);
      return;
    }
    if (status.staged.length || !status.files.length) return;
    const filesToAdd = this.filterStageable(status.files.map(f => f.path));
    if (filesToAdd.length > 0) await git.add(filesToAdd);
  }

  async getRecentCommits(count: number = 10, cwd?: string): Promise<CommitInfo[]> {
    try {
      const git = cwd ? createGit(cwd) : this.git;
      const log = await git.log({ maxCount: count });

      return log.all.map(commit => ({
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
      const git = cwd ? createGit(cwd) : this.git;
      return staged ? await git.diff(['--staged']) : await git.diff();
    } catch (error) {
      throw new GitError('Failed to get diff', error);
    }
  }

  /**
   * Lists commits in `from..to` (defaults `to` to `HEAD`), optionally
   * restricted to merge commits only.
   *
   * @param options - Range and merge-only filter
   * @param cwd - Optional repository working directory
   * @returns Array of `{hash, subject}` pairs for commits in the range, ordered newest first
   */
  async listCommitsInRange(
    options: { from: string; to?: string; mergesOnly?: boolean },
    cwd?: string
  ): Promise<{ hash: string; subject: string }[]> {
    try {
      const git = cwd ? createGit(cwd) : this.git;
      const output = await git.raw(this.buildRevListArgs(options));
      return parseRevListOutput(output);
    } catch (error) {
      throw new GitError('Failed to list commits in range', error);
    }
  }

  private buildRevListArgs(options: { from: string; to?: string; mergesOnly?: boolean }): string[] {
    const range = `${options.from}..${options.to ?? 'HEAD'}`;
    return [
      'rev-list',
      ...(options.mergesOnly ? ['--merges'] : []),
      '--pretty=format:%H%x00%s',
      '--no-commit-header',
      range,
    ];
  }

  /**
   * Soft-resets to `ref`, unwinding any commits made after it while leaving
   * their content staged. Re-unstages wf tooling artifacts the reset may
   * have re-staged (see {@link GitService.EXCLUDED_PATHS}) since neither
   * `ReviewerAgent` nor `CommitterAgent` unstage anything themselves.
   *
   * @param ref - Commit to reset to
   * @param cwd - Optional repository working directory
   */
  async resetSoftToCommit(ref: string, cwd?: string): Promise<void> {
    try {
      const git = cwd ? createGit(cwd) : this.git;
      await git.reset(['--soft', ref]);
      const status = await git.status();
      const excluded = status.staged.filter(p => GitService.EXCLUDED_PATHS.test(p));
      if (excluded.length > 0) await git.reset(['--', ...excluded]);
    } catch (error) {
      wrapGitError(error, `Failed to soft reset to ${ref}`);
    }
  }

  /**
   * Stage all modified and new files, excluding wf tooling artifacts:
   * - `.wf/**` — runtime state/log directories written by wf
   * - `wf.config.{js,mjs,ts,mts,yaml,yml}` — wf CLI config files that the
   *   implementer agent may create inside a target repo; these are tooling
   *   inputs, not code changes for the ticket.
   * - `verification.policy.json` — wf verification policy config
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
      const git = cwd ? createGit(cwd) : this.git;
      await this.addStageableFiles(git);
    } catch (error) {
      wrapGitError(error, 'Failed to stage all changes');
    }
  }

  /**
   * Stage every stageable path from the current git status. If `git add`
   * fails because a path vanished between reading status and staging it
   * (see {@link isMissingPathspecError} — e.g. another process deleted and
   * committed it in that window), re-read status and retry once against the
   * files that are still actually present, rather than failing the whole
   * command over a race outside this call's control.
   *
   * @param git - SimpleGit instance to stage against
   */
  private async addStageableFiles(git: SimpleGit): Promise<void> {
    const status = await git.status();
    const filesToAdd = this.filterStageable(status.files.map(f => f.path));
    if (filesToAdd.length === 0) return;

    try {
      await git.add(filesToAdd);
    } catch (error) {
      if (!isMissingPathspecError(error)) throw error;
      this.logger.warn('A path vanished after git status but before staging (likely a concurrent process); retrying.');
      await this.retryStageAfterVanishedPath(git);
    }
  }

  private async retryStageAfterVanishedPath(git: SimpleGit): Promise<void> {
    const status = await git.status();
    const filesToAdd = this.filterStageable(status.files.map(f => f.path));
    if (filesToAdd.length > 0) await git.add(filesToAdd);
  }

  /**
   * Regex that matches paths that must never be staged by wf:
   * - `.wf/` or `.wf\` prefix — runtime state/log artifacts
   * - `wf.config.{js,mjs,ts,mts,yaml,yml}` — tooling config files
   * - `verification.policy.json` — wf verification policy config
   * - `dist/` or `dist\` prefix — compiled build output
   * - `.gitignore` — git ignore rules are managed by the repo owner, not wf
   *
   * Uses `[/\\]` so it handles both POSIX and Windows path separators.
   */
  private static readonly EXCLUDED_PATHS
    = /^\.wf[/\\]|^wf\.config\.(js|mjs|ts|mts|yaml|yml)$|^verification\.policy\.json$|^dist[/\\]|^\.gitignore$/;

  /**
   * Filter a list of file paths, removing any that match {@link EXCLUDED_PATHS}.
   *
   * @param paths - File paths as returned by `StatusResult.files[n].path`
   * @returns Paths that are safe to pass to `git.add()`
   */
  private filterStageable(paths: string[]): string[] {
    return paths.filter(p => !GitService.EXCLUDED_PATHS.test(p));
  }

  private ensureGitignoreIsNotStaged(paths: string[]): void {
    if (!paths.includes('.gitignore')) {
      return;
    }

    throw new GitError('⚠ Refusing to create commit because .gitignore is staged', {
      stagedPaths: paths,
    });
  }

  async stashChanges(message?: string, cwd?: string): Promise<void> {
    try {
      const git = cwd ? createGit(cwd) : this.git;
      await git.stash(['push', '-m', message || 'Auto-stashed by wf']);
      this.logger.success('Stashed uncommitted changes');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GitError(`Failed to stash changes: ${reason}`, error);
    }
  }

  async stashPop(cwd?: string): Promise<void> {
    try {
      const git = cwd ? createGit(cwd) : this.git;
      await git.stash(['pop']);
      this.logger.success('Restored stashed changes');
    } catch (error) {
      throw new GitError('Failed to restore stashed changes', error);
    }
  }

  async getStatus(cwd?: string): Promise<StatusResult> {
    try {
      const git = cwd ? createGit(cwd) : this.git;
      return await git.status();
    } catch (error) {
      throw new GitError('Failed to get git status', error);
    }
  }

  async getCurrentBranch(cwd?: string): Promise<string> {
    try {
      const git = cwd ? createGit(cwd) : this.git;
      const status = await git.status();
      return status.current || 'HEAD';
    } catch (error) {
      throw new GitError('Failed to get current branch', error);
    }
  }

  async checkoutBranch(branchName: string, cwd?: string): Promise<void> {
    try {
      const git = cwd ? createGit(cwd) : this.git;
      await git.checkout(branchName);
      this.logger.success(`Checked out branch: ${branchName}`);
    } catch (error) {
      throw new GitError(`Failed to checkout branch: ${branchName}`, error);
    }
  }

  async pull(remote: string = 'origin', branch?: string, cwd?: string): Promise<void> {
    const git = cwd ? createGit(cwd) : this.git;
    try {
      const currentBranch = branch || (await this.getCurrentBranch(cwd));
      await git.pull(remote, currentBranch);
      this.logger.success(`Pulled latest changes from ${remote}/${currentBranch}`);
    } catch (error) {
      throw new GitError('Failed to pull changes', error);
    }
  }

  /**
   * Returns the configured protected branch list, or the module-level default
   * when none is configured.
   *
   * @returns Array of branch name strings to protect
   */
  private resolveProtectedBranches(): string[] {
    const configured = this.configService.get<string[]>('git.protectedBranches');
    return configured ?? DEFAULT_PROTECTED_BRANCHES;
  }

  /**
   * Throw a {@link GitError} if `branch` (after stripping remote prefixes)
   * matches any protected branch name.
   *
   * @param branch - The resolved branch name to check
   */
  private assertNotProtectedBranch(branch: string): void {
    const protectedBranches = this.resolveProtectedBranches();
    const bare = branch.replace(/^(remotes\/origin\/|origin\/)/, '');
    const isProtected = protectedBranches.some(
      p => p.toLowerCase() === bare.toLowerCase()
    );
    if (isProtected) {
      throw new GitError(
        `Refusing to push directly to protected branch '${branch}'. Use a pull request instead.`
      );
    }
  }

  async push(remote: string = 'origin', branch?: string, setUpstream: boolean = false): Promise<void> {
    try {
      const currentBranch = branch || (await this.getCurrentBranch());
      this.assertNotProtectedBranch(currentBranch);

      if (setUpstream) {
        await this.git.push(['-u', remote, currentBranch]);
        this.logger.success(`Pushed and set upstream: ${remote}/${currentBranch}`);
      } else {
        await this.git.push(remote, currentBranch);
        this.logger.success(`Pushed to ${remote}/${currentBranch}`);
      }
    } catch (error) {
      wrapGitError(error, 'Failed to push changes');
    }
  }

  /**
   * Returns which of the given paths are covered by .gitignore rules.
   *
   * Uses `git check-ignore` under the hood; paths that don't exist on disk
   * are still checked against the ignore patterns.
   *
   * @param paths - Absolute or repo-relative paths to test
   * @param cwd - Working directory (defaults to the repo root)
   * @returns The subset of `paths` that are gitignored
   */
  async checkIgnored(paths: string[], cwd?: string): Promise<string[]> {
    if (paths.length === 0) return [];

    const git = cwd ? createGit(cwd) : this.git;
    const CHUNK_SIZE = 100;
    const results = await Promise.all(
      Array.from({ length: Math.ceil(paths.length / CHUNK_SIZE) }, (_, i) =>
        checkIgnoredChunk(git, paths.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))
      )
    );
    return results.flat();
  }
}
