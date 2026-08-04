import { Command, CommandRunner, Option } from 'nest-commander';
import { GitService } from '../integrations/git/git.service';
import { AiService } from '../integrations/ai/ai.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { GitError } from '../shared/utils/errors';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import { parseReposOption } from './utils/repos-option';
import { resolveRepoBasePath } from '../agents/utils';
import { CommitStageService } from '../workflows/stages/commit-stage.service';
import chalk from 'chalk';

interface IssueCommitOptions {
  message?: string;
  conventional?: boolean;
  dryRun?: boolean;
  ticketKey?: string;
  tracker?: string;
  repos?: string[];
  sessionId?: string;
}

const ISSUE_COMMIT_EXAMPLES: CliExample[] = [
  {
    comment: 'AI-generated commit message',
    command: 'wf issue:commit -k WBP-2971',
  },
  {
    comment: 'Run the commit stage from source with conventional commits enabled',
    command: 'yarn start issue:commit -c',
  },
  {
    comment: 'Force conventional format',
    command: 'wf issue:commit -k WBP-2971 --conventional --tracker jira',
  },
];

const warnOnIgnoredRepos = (repos?: string[]): void => {
  if ((repos?.length ?? 0) > 1) {
    console.log(
      chalk.yellow(
        `⚠️ Only the first repository will be used for issue:commit. Ignoring: ${(repos ?? []).slice(1).join(', ')}`
      )
    );
  }
};

/**
 * Command to create git commits with AI-generated messages
 * Auto-detects ticket key from branch name
 */
@Command({
  name: 'issue:commit',
  description:
    'Create git commit with AI-generated message (use -k for ticket key or auto-detects from branch; fails hard if .gitignore is staged; blank AI commit responses fail fast with provider-aware diagnostics)',
  options: { isDefault: false },
})
export class IssueCommitCommand extends CommandRunner {
  constructor(
    private readonly gitService: GitService,
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly commitStageService: CommitStageService
  ) {
    super();
  }

  async run(_passedParams: string[], options?: IssueCommitOptions): Promise<void> {
    printExamples(ISSUE_COMMIT_EXAMPLES);

    await executeAsyncWithCatch({ fn: async () => {
      const repoBaseDir = resolveRepoBasePath(options?.repos?.[0]);
      warnOnIgnoredRepos(options?.repos);
      const ticketKey = options?.ticketKey ?? await this.detectTicketFromBranch(repoBaseDir);

      if (options?.dryRun) return this.previewDryRun(ticketKey, options);

      await this.executeCommit(repoBaseDir, options?.ticketKey ?? null, options);
    } });
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
    const commitMessage = await this.buildFinalMessage(diff, ticketKey, options);
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
    if (detectedTicketKey) return { ticketKey: detectedTicketKey, autoDetected: false };
    const ticketKey = await this.detectTicketFromBranch(repoBaseDir);
    return { ticketKey, autoDetected: Boolean(ticketKey) };
  }

  private async buildFinalMessage(
    diff: string, ticketKey: string | null, options?: IssueCommitOptions
  ): Promise<string> {
    let msg = await this.resolveCommitMessage(diff, ticketKey, options);
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
    diff: string, ticketKey: string | null, options?: IssueCommitOptions
  ): Promise<string> {
    if (options?.message) {
      console.log(chalk.gray('  Using provided commit message\n'));
      return options.message;
    }
    console.log(chalk.cyan('🤖 Generating commit message with AI...\n'));
    const msg = await this.commitStageService.generateCommitMessage({
      diff, ticketKey: ticketKey || undefined, conventional: options?.conventional,
    });
    console.log(chalk.green('✓ Generated commit message:\n'));
    console.log(chalk.bold.cyan(this.indentMessage(msg)));
    console.log();
    return msg;
  }

  @Option({
    flags: '-c, --conventional',
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
      'Space-separated repositories; only the first repo is used and additional repos are ignored with a warning',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '--session-id <id>',
    description: 'Resume a wf session by UUID (persisted to ~/.wf/state/sessions/)',
  })
  parseSessionId(val: string): string {
    return val;
  }

  @Option({
    flags: '-k, --ticket-key <key>',
    description: 'Ticket key for the commit (e.g. WBP-2971)',
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

  /**
   * Detect ticket key from current branch name
   * Supports formats like: feature/WBP-2971-description, WBP-2971, etc.
   */
  private async detectTicketFromBranch(repoBaseDir?: string): Promise<string | null> {
    const branchInfo = await this.gitService.getBranchInfo(repoBaseDir).catch(() => null);
    if (!branchInfo) return null;

    const match = new RegExp(/([A-Z]+-\d+)/i).exec(branchInfo.current);
    return match ? match[1].toUpperCase() : null;
  }

  /**
   * Count changed files in diff
   */
  private countChangedFiles(diff: string): number {
    const lines = diff.split('\n');
    const fileLines = lines.filter(line => line.startsWith('diff --git'));
    return fileLines.length;
  }

  /**
   * Indent message for display
   */
  private indentMessage(message: string): string {
    return message
      .split('\n')
      .map(line => `  ${line}`)
      .join('\n');
  }
}
