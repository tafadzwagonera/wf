import { Command, CommandRunner, Option } from 'nest-commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitService } from '../integrations/git/git.service';
import { AiService } from '../integrations/ai/ai.service';
import { ConfigService } from '@nestjs/config';
import { DryRunPreviewService } from '../common/preview/dry-run-preview.service';
import { GitError, ValidationError } from '../common/utils/errors';
import { executeAsyncWithCatch } from '../common/utils/execute-with-catch';
import { printCommandHeader } from '../common/utils/command-header.helper';
import { parseReposOption } from './utils/repos-option';
import { resolveRepoBasePath } from '../agents/utils';
import { resolveCommitScopeSummary, resolveFreshCommitDescription } from '../common/utils/resolve-commit-scope-summary';
import {
  findDatePrefixedReviewArtifact,
  listReviewArtifactVariants,
  resolveCustomReviewArtifactPath,
  resolveReviewArtifactPath,
} from '../common/utils/resolve-review-summary';
import { renderCommitDescriptionContext } from '../common/utils/commit-description-artifact';
import { stripSupportedPlanExtension } from '../common/utils/plan-artifact';
import { appendToLogFile } from '../common/logger/log-file-writer';
import type { CommitDescriptionResponse } from '../common/types/commit-description.types';
import { CommitDescriptionStageService } from '../workflows/stages/commit-description-stage.service';
import { CommitStageService } from '../workflows/stages/commit-stage.service';
import { withRepoLock } from '../common/utils/repo-lock';
import chalk from 'chalk';
import inquirer from 'inquirer';

interface IssueCommitOptions {
  message?: string;
  conventional?: boolean;
  dryRun?: boolean;
  ticketKey?: string;
  tracker?: string;
  repos?: string[];
  review?: string;
  sessionId?: string;
  silent?: boolean;
}
const warnOnIgnoredRepos = (repos?: string[]): void => {
  if ((repos?.length ?? 0) > 1) {
    console.log(
      chalk.yellow(
        `⚠ Only the first repository will be used for issue:commit. Ignoring: ${(repos ?? []).slice(1).join(', ')}`
      )
    );
  }
};

@Command({
  name: 'issue:commit',
  description:
    'Create a git commit with an AI-generated message. '
    + 'Use -k for the ticket key, or the key is auto-detected from the branch name. '
    + 'When -k differs from the branch-embedded ticket key, warns and prompts to pick a value interactively, '
    + 'or fails hard with both keys shown when non-interactive; --dry-run only warns. '
    + 'Fails hard if .gitignore is staged. '
    + 'Blank AI commit responses fail fast with provider-aware diagnostics. '
    + 'When a code review or plan artifact already exists for the ticket, its summary is used to scope '
    + 'the commit message automatically. '
    + 'Use --review <plan-stem|ticket-key> to point at a specific review artifact; the lookup probes the tracker '
    + 'directory first, then the custom directory, and finds the artifact in any supported format (json|md|yaml|yml). '
    + 'When no exact artifact matches, the tracker and custom directories are scanned for date-prefixed variants '
    + '(YYYY-MM-DD-<token>-review.<ext>, exact stem) and the newest by mtime wins on ambiguity with a warning. '
    + 'When no fresh diff-grounded commit description exists for the staged diff, one is generated inline. '
    + 'When running from source, use yarn start issue:commit --conventional.',
  options: { isDefault: false },
})
export class IssueCommitCommand extends CommandRunner {
  constructor(
    private readonly gitService: GitService,
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly commitStageService: CommitStageService,
    private readonly commitDescriptionStageService: CommitDescriptionStageService
  ) {
    super();
  }

  async run(_passedParams: string[], options?: IssueCommitOptions): Promise<void> {
    if (!options?.silent) printCommandHeader('issue:commit');

    await executeAsyncWithCatch({ fn: async () => {
      const repoBaseDir = resolveRepoBasePath(options?.repos?.[0]);
      warnOnIgnoredRepos(options?.repos);

      if (options?.dryRun) return this.previewDryRun(await this.resolveDryRunTicketKey(options, repoBaseDir), options);

      await withRepoLock(repoBaseDir, () => this.executeCommit(repoBaseDir, options?.ticketKey ?? null, options));
    } });
  }

  private async resolveDryRunTicketKey(options: IssueCommitOptions, repoBaseDir: string): Promise<string | null> {
    const branchTicketKey = await this.detectTicketFromBranch(repoBaseDir);
    if (options?.ticketKey && branchTicketKey && branchTicketKey.toUpperCase() !== options.ticketKey.toUpperCase()) {
      console.log(chalk.yellow(
        `  ⚠  --ticket-key '${options.ticketKey}' does not match branch ticket key '${branchTicketKey}' `
        + '(dry-run — no changes made).'
      ));
    }
    return options?.ticketKey ?? branchTicketKey;
  }

  private previewDryRun(ticketKey: string | null, options: IssueCommitOptions): void {
    const prefix = ticketKey ? `${ticketKey}: ` : '';
    this.dryRunPreview.showHeader('issue:commit', ticketKey ?? undefined);
    this.previewDryRunApiCall(prefix, options);
    this.previewDryRunSummary(prefix, ticketKey, options);
    this.dryRunPreview.showValidationResult();
  }

  private previewDryRunApiCall(prefix: string, options: IssueCommitOptions): void {
    if (options?.message) return;
    this.dryRunPreview.previewApiCall({
      method: 'POST',
      endpoint: this.aiService.getProviderEndpoint('commit'),
      platform: this.aiService.getProviderDisplayName('commit'),
      description: 'Generate conventional commit message from staged diff',
      estimatedResponse: `{\n  "content": "${prefix}feat(scope): <generated message>"\n}`,
    });
  }

  private previewDryRunSummary(
    prefix: string, ticketKey: string | null, options: IssueCommitOptions
  ): void {
    const msgPreview = options?.message ?? '[AI-generated commit message]';
    const fullMsg = ticketKey ? `${ticketKey}: ${msgPreview}` : msgPreview;
    this.dryRunPreview.previewGitOperation({
      operation: 'commit', description: 'git commit -m "<message>"', message: fullMsg,
    });
    this.dryRunPreview.showSummary({
      apiCallCount: options?.message ? 0 : 1, fileCreatedCount: 0, fileModifiedCount: 0, gitOperationCount: 1,
      terminalOutputLines: [
        '✔ Commit created successfully!', '', 'Commit hash: <short-sha>',
        `Message: ${prefix}<AI-generated message>`, '',
        '💡 Tip: Use "git push" to push your commit to remote',
      ],
    });
  }

  private async executeCommit(
    repoBaseDir: string, detectedTicketKey: string | null, options?: IssueCommitOptions
  ): Promise<void> {
    await this.assertGitRepository(repoBaseDir);

    const { ticketKey, autoDetected } = await this.resolveTicketKey(detectedTicketKey, repoBaseDir);
    this.printCommitHeader(ticketKey, autoDetected, options);

    const diff = await this.getStagedDiff(repoBaseDir);
    const commitMessage = await this.buildFinalMessage(diff, ticketKey, repoBaseDir, options);
    await this.createAndPrintCommit(commitMessage, repoBaseDir);
  }

  private async assertGitRepository(repoBaseDir: string): Promise<void> {
    const isRepo = await this.gitService.isGitRepository(repoBaseDir);
    if (!isRepo) {
      throw new GitError(`Not a git repository. Run this command from within a git repository: ${repoBaseDir}`);
    }
  }

  private async resolveTicketKey(
    detectedTicketKey: string | null, repoBaseDir: string
  ): Promise<{ ticketKey: string | null; autoDetected: boolean }> {
    const branchTicketKey = await this.detectTicketFromBranch(repoBaseDir);
    if (!detectedTicketKey) return { ticketKey: branchTicketKey, autoDetected: Boolean(branchTicketKey) };

    if (branchTicketKey && branchTicketKey.toUpperCase() !== detectedTicketKey.toUpperCase()) {
      const resolved = await this.resolveTicketKeyMismatch(detectedTicketKey, branchTicketKey);
      return { ticketKey: resolved, autoDetected: false };
    }
    return { ticketKey: detectedTicketKey, autoDetected: false };
  }

  /**
   * Warn about a --ticket-key / branch-name ticket key mismatch and let the
   * user pick which value to use.
   *
   * @param explicitKey - The value passed via --ticket-key
   * @param branchKey - The ticket key detected from the current branch name
   * @returns The ticket key the user selected
   * @throws ValidationError when the session is non-interactive
   */
  private async resolveTicketKeyMismatch(explicitKey: string, branchKey: string): Promise<string> {
    console.log(chalk.yellow(
      `  ⚠  --ticket-key '${explicitKey}' does not match the branch's ticket key '${branchKey}'.`
    ));
    if (!this.isInteractiveSession()) {
      throw new ValidationError(
        `Ticket key mismatch: --ticket-key '${explicitKey}' does not match branch ticket key `
        + `'${branchKey}'. Pass the correct --ticket-key or re-run interactively to choose.`
      );
    }
    const { selectedKey } = await inquirer.prompt<{ selectedKey: string }>([{
      type: 'list', name: 'selectedKey', message: 'Which ticket key should be used?', prefix: ' ', choices: [
        { name: `Use '${explicitKey}' (from --ticket-key)`, value: explicitKey },
        { name: `Use '${branchKey}' (from branch name)`, value: branchKey },
      ], default: explicitKey,
    }]);
    return selectedKey;
  }

  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  private async buildFinalMessage(
    diff: string, ticketKey: string | null, repoBaseDir: string, options?: IssueCommitOptions
  ): Promise<string> {
    let msg = await this.resolveCommitMessage(diff, ticketKey, repoBaseDir, options);
    if (ticketKey && !msg.includes(ticketKey)) msg = `${ticketKey}: ${msg}`;
    return msg;
  }

  private async createAndPrintCommit(commitMessage: string, repoBaseDir: string): Promise<void> {
    console.log(chalk.cyan('📦 Creating commit...\n'));
    const commitHash = await this.gitService.commit({ message: commitMessage, cwd: repoBaseDir });
    console.log(chalk.green('✔ Commit created successfully!\n'));
    console.log(chalk.bold('Commit hash:'), chalk.cyan(commitHash));
    console.log(chalk.bold('Message:'), chalk.bold.cyan(commitMessage.split('\n')[0]));
    console.log(chalk.gray('\n💡 Tip: Use "git push" to push your commit to remote\n'));
  }

  private printCommitHeader(ticketKey: string | null, autoDetected: boolean, options?: IssueCommitOptions): void {
    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    console.log(chalk.bold.cyan('\n📝 Commit'));
    console.log(chalk.gray('─'.repeat(70)));
    if (ticketKey) console.log(chalk.gray(`Ticket: ${ticketKey}${autoDetected ? ' (auto-detected)' : ''}`));
    console.log(chalk.gray(`Platform: ${trackerName}`));
    if (options?.repos?.length) console.log(chalk.gray(`Repository: ${options.repos[0]}`));
    console.log();
  }

  private async getStagedDiff(repoBaseDir: string): Promise<string> {
    const diff = await this.gitService.getDiff(true, repoBaseDir);
    if (!diff || diff.trim().length === 0) {
      throw new GitError('No staged changes to commit. Stage files with git add before running this command.');
    }
    console.log(chalk.gray(`  Staged changes: ${this.countChangedFiles(diff)} file(s)\n`));
    return diff;
  }

  private async resolveCommitMessage(
    diff: string, ticketKey: string | null, repoBaseDir: string, options?: IssueCommitOptions
  ): Promise<string> {
    if (options?.message) {
      console.log(chalk.gray('  Using provided commit message\n'));
      return options.message;
    }
    console.log(chalk.cyan('🤖 Generating commit message with AI...\n'));

    const scopeSummary = await this.resolveScopeSummary({ diff, ticketKey, repoBaseDir, options });
    const msg = await this.commitStageService.generateCommitMessage({
      diff, ticketKey: ticketKey || undefined, conventional: options?.conventional, scopeSummary,
    });
    console.log(chalk.green('✔ Generated commit message:\n'));
    console.log(chalk.bold.cyan(this.indentMessage(msg)));
    console.log();
    return msg;
  }

  private async resolveScopeSummary(
    { diff, ticketKey, repoBaseDir, options }: {
      diff: string; ticketKey: string | null; repoBaseDir: string; options?: IssueCommitOptions;
    }
  ): Promise<string | undefined> {
    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    const lookup = { diff, ticketKey, repoBaseDir, trackerName };
    const reviewArtifactPath = this.resolveReviewOverride(repoBaseDir, trackerName, options);
    const proseSummary = resolveCommitScopeSummary({
      repoBaseDir, trackerName, ticketKey, stagedDiff: diff, reviewArtifactPath,
    }) ?? undefined;
    const isFresh = this.findFreshDescription({ ...lookup, reviewArtifactPath }) === proseSummary;
    const generated = isFresh ? null : await this.generateDescription(diff, options);
    const scopeSummary = generated ? renderCommitDescriptionContext(generated) : proseSummary;
    if (scopeSummary && !generated) this.printScopeSummarySource(options);
    return scopeSummary;
  }

  private findFreshDescription(
    { diff, ticketKey, repoBaseDir, trackerName, reviewArtifactPath }: {
      diff: string; ticketKey: string | null; repoBaseDir: string; trackerName: string; reviewArtifactPath?: string;
    }
  ): string | null {
    const reviewPath = reviewArtifactPath
      ?? (ticketKey ? resolveReviewArtifactPath(repoBaseDir, trackerName, ticketKey) : null);
    return reviewPath ? resolveFreshCommitDescription(reviewPath, diff) : null;
  }

  private printScopeSummarySource(options?: IssueCommitOptions): void {
    if (!options?.silent) console.log(chalk.gray('  Using scope summary from prior review/plan'));
  }

  private async generateDescription(
    diff: string, options?: IssueCommitOptions
  ): Promise<CommitDescriptionResponse | null> {
    if (!options?.silent) console.log(chalk.gray('  Generating commit description from staged diff...'));
    return this.commitDescriptionStageService.generate({ diff, stage: 'commit' });
  }

  private resolveReviewOverride(
    repoBaseDir: string, trackerName: string, options?: IssueCommitOptions
  ): string | undefined {
    if (!options?.review) return undefined;
    const stem = stripSupportedPlanExtension(path.basename(options.review));
    const candidates = [
      resolveReviewArtifactPath(repoBaseDir, trackerName, stem),
      resolveCustomReviewArtifactPath(repoBaseDir, stem),
    ].flatMap(listReviewArtifactVariants);
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (found) return found;
    const fallback = this.resolveDatePrefixedReview(repoBaseDir, trackerName, stem, options.silent);
    if (fallback) return fallback;
    const message = `--review '${options.review}' matched no review artifact (searched: ${candidates.join(', ')})`;
    appendToLogFile('WARN', message, 'issue-commit');
    if (!options?.silent) console.log(chalk.yellow(`  ⚠  ${message}`));
    return undefined;
  }

  private resolveDatePrefixedReview(
    repoBaseDir: string, trackerName: string, stem: string, silent?: boolean
  ): string | undefined {
    const match = findDatePrefixedReviewArtifact(repoBaseDir, trackerName, stem);
    if (!match) return undefined;
    const { artifactPath, alternates } = match;
    if (alternates.length === 0) {
      const info = `--review '${stem}' resolved to date-prefixed artifact '${artifactPath}'`;
      appendToLogFile('INFO', info, 'issue-commit');
      return artifactPath;
    }
    const message = `--review '${stem}' matched ${alternates.length + 1} review artifacts; `
      + `using newest '${artifactPath}' (also matched: ${alternates.join(', ')})`;
    appendToLogFile('WARN', message, 'issue-commit');
    if (!silent) console.log(chalk.yellow(`  ⚠  ${message}`));
    return artifactPath;
  }

  @Option({
    flags: '--conventional',
    description: 'Force conventional commits format',
  })
  parseConventional(): boolean {
    return true;
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the commit operation without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '-m, --message <message>',
    description: 'Manual commit message (bypasses AI generation)',
  })
  parseMessage(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; only the first repo is used and additional repos are ignored with a warning. Names resolve from cwd, a sibling directory, then $WF_REPOS_DIR (default: $HOME/Apps, Projects, apps, projects)',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '--review <planOrTicket>',
    description:
      'Plan file or ticket key whose review artifact supplies the commit description; probes the tracker directory, '
      + 'then the custom directory, matching any supported artifact format (json|md|yaml|yml); when no exact artifact '
      + 'matches, both directories are scanned for date-prefixed variants (YYYY-MM-DD-<token>-review.<ext>, exact '
      + 'stem) and the newest by mtime wins on ambiguity with a warning',
  })
  parseReview(val: string): string {
    return val;
  }

  @Option({
    flags: '--session-id <id>',
    description: 'Resume a wf session by UUID (persisted to ~/.wf/state/sessions/)',
  })
  parseSessionId(val: string): string {
    return val;
  }

  @Option({
    flags: '-s, --silent',
    description: 'Suppress decorative output; emits no header',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '-k, --ticket-key <key>',
    description: 'Ticket key for the commit (e.g. WBP-2971); validated against the branch-embedded ticket key',
  })
  parseTicketKey(val: string): string {
    return val;
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description: 'Tracker (jira|github|bitbucket)',
  })
  parseTracker(val: string): string {
    return val;
  }

  private async detectTicketFromBranch(repoBaseDir?: string): Promise<string | null> {
    const branchInfo = await this.gitService.getBranchInfo(repoBaseDir).catch(() => null);
    if (!branchInfo) return null;

    const match = /([A-Z]+-\d+)/.exec(branchInfo.current);
    return match ? match[1].toUpperCase() : null;
  }

  private countChangedFiles(diff: string): number {
    const lines = diff.split('\n');
    const fileLines = lines.filter(line => line.startsWith('diff --git'));
    return fileLines.length;
  }

  private indentMessage(message: string): string {
    return message
      .split('\n')
      .map(line => `  ${line}`)
      .join('\n');
  }
}
