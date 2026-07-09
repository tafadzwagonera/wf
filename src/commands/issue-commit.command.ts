import { Command, CommandRunner, Option } from 'nest-commander';
import { GitService } from '../integrations/git/git.service';
import { AiService } from '../integrations/ai/ai.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
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
        `⚠️ Only the first repository will be used for issue:commit. Ignoring: ${repos!.slice(1).join(', ')}`
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

  async run(passedParams: string[], options?: IssueCommitOptions): Promise<void> {
    printExamples(ISSUE_COMMIT_EXAMPLES);

    try {
      const repoBaseDir = resolveRepoBasePath(options?.repos?.[0]);
      warnOnIgnoredRepos(options?.repos);

      // Get ticket key (from --ticket-key or branch) — needed for both dry-run and live
      let ticketKey: string | null = options?.ticketKey ?? null;

      if (options?.dryRun) {
        if (!ticketKey) {
          const detected = await this.detectTicketFromBranch(repoBaseDir);
          if (detected) {
            ticketKey = detected;
          }
        }

        this.dryRunPreview.showHeader('issue:commit', ticketKey ?? undefined);

        if (!options?.message) {
          this.dryRunPreview.previewApiCall({
            method: 'POST',
            endpoint: '/v1/messages',
            platform: this.aiService.getProviderDisplayName(),
            description: 'Generate conventional commit message from staged diff',
            estimatedResponse: [
              '{',
              `  "content": "${ticketKey ? ticketKey + ': ' : ''}feat(scope): <generated message>"`,
              '}',
            ].join('\n'),
          });
        }

        const msgPreview = options?.message ? options.message : '[AI-generated commit message]';
        const fullMsg = ticketKey ? `${ticketKey}: ${msgPreview}` : msgPreview;

        this.dryRunPreview.previewGitOperation({
          operation: 'commit',
          description: 'git commit -m "<message>"',
          message: fullMsg,
        });

        this.dryRunPreview.showSummary({
          apiCallCount: options?.message ? 0 : 1,
          fileCreatedCount: 0,
          fileModifiedCount: 0,
          gitOperationCount: 1,
          terminalOutputLines: [
            '✅ Commit created successfully!',
            '',
            'Commit hash: <short-sha>',
            `Message: ${ticketKey ? ticketKey + ': ' : ''}<AI-generated message>`,
            '',
            '💡 Tip: Use "git push" to push your commit to remote',
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      // Check if we're in a git repository
      const isRepo = await this.gitService.isGitRepository(repoBaseDir);
      if (!isRepo) {
        throw new Error(`Not a git repository. Run this command from a git repository: ${repoBaseDir}`);
      }

      let autoDetected = false;
      if (!ticketKey) {
        const detected = await this.detectTicketFromBranch(repoBaseDir);
        if (detected) {
          ticketKey = detected;
          autoDetected = true;
        }
      }

      const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');

      console.log(chalk.bold.cyan('\n📝 Commit'));
      console.log(chalk.gray('─'.repeat(70)));
      if (ticketKey) {
        console.log(chalk.gray(`Ticket: ${ticketKey}${autoDetected ? ' (auto-detected)' : ''}`));
      }
      console.log(chalk.gray(`Platform: ${trackerName}`));
      if (options?.repos?.length) {
        console.log(chalk.gray(`Repository: ${options.repos[0]}`));
      }
      console.log();

      // Get git diff to understand changes
      const diff = await this.gitService.getDiff(true, repoBaseDir); // Get staged changes
      if (!diff || diff.trim().length === 0) {
        throw new Error('No staged changes to commit. Use "git add" to stage changes first.');
      }

      const fileCount = this.countChangedFiles(diff);
      console.log(chalk.gray(`  Staged changes: ${fileCount} file(s)\n`));

      // Generate or get commit message
      let commitMessage: string;

      if (options?.message) {
        // Manual message provided via --message flag
        commitMessage = options.message;
        console.log(chalk.gray('  Using provided commit message\n'));
      } else {
        // Generate with AI (default behavior)
        console.log(chalk.cyan('🤖 Generating commit message with AI...\n'));
        commitMessage = await this.commitStageService.generateCommitMessage({
          diff,
          ticketKey: ticketKey || undefined,
          conventional: options?.conventional,
        });
        console.log(chalk.green('✓ Generated commit message:\n'));
        console.log(chalk.bold.cyan(this.indentMessage(commitMessage)));
        console.log();
      }

      // Add ticket key prefix if available and not already present
      if (ticketKey && !commitMessage.includes(ticketKey)) {
        commitMessage = `${ticketKey}: ${commitMessage}`;
      }

      // Create commit
      console.log(chalk.cyan('📦 Creating commit...\n'));
      const commitHash = await this.gitService.commit({
        message: commitMessage,
        cwd: repoBaseDir,
      });

      console.log(chalk.green('✅ Commit created successfully!\n'));
      console.log(chalk.bold('Commit hash:'), chalk.cyan(commitHash));
      console.log(chalk.bold('Message:'), chalk.bold.cyan(commitMessage.split('\n')[0]));
      console.log(chalk.gray('\n💡 Tip: Use "git push" to push your commit to remote\n'));
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
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
    try {
      const branchInfo = await this.gitService.getBranchInfo(repoBaseDir);
      const branchName = branchInfo.current;

      // Try to extract ticket key (format: ABC-123)
      const match = branchName.match(/([A-Z]+-\d+)/i);
      if (match) {
        return match[1].toUpperCase();
      }

      return null;
    } catch {
      return null;
    }
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
