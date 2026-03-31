import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { AiService, CodeIssue } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { UniversalTicket } from '../common/dto/universal-ticket.dto';
import { resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { getWfHomeDir } from '../shared/utils/wf-paths';

interface IssueReviewOptions {
  format?: string;
  output?: string;
  dryRun?: boolean;
  comment?: boolean;
  repos?: string[];
  criteria?: string;
  replaceCriteria?: string;
}

const DEFAULT_REVIEW_GUIDELINES = [
  'Clarity: Would another developer understand this instantly?',
  'Deletability: Can I remove or replace this easily?',
  'Failure handling: What breaks? Is it handled?',
  'Necessity: Is anything here unused or speculative?',
  'Quality: Do the changes conform to formatting and quality metrics?',
  'Security: Are there any glaring security concerns?',
  'Simplicity: Is this the simplest thing that works?',
  'Structure: Does this reflect the domain?',
];

/**
 * Parse a markdown criteria file into an array of guideline strings.
 * Strips leading bullet/number markers and blank lines.
 * @param filePath Absolute or relative path to the criteria markdown file
 * @returns Array of non-empty guideline strings
 */
const loadCriteriaFromFile = (filePath: string): string[] => {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Criteria file not found: ${resolved}`);
  }
  return fs
    .readFileSync(resolved, 'utf-8')
    .split('\n')
    .map((line) =>
      line
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .trim(),
    )
    .filter((line) => line.length > 0 && !line.startsWith('#'));
};

/**
 * Enhanced command to review code changes with flexible source options
 * Supports: current repo, ticket key, PR URL, or specific repo path
 */
@Injectable()
@Command({
  name: 'issue:review',
  description: 'AI-powered code review with flexible source options',
  arguments: '[source]',
  options: { isDefault: false },
})
export class IssueReviewCommand extends CommandRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly gitService: GitService,
    private readonly platformService: PlatformService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
  ) {
    super();
  }

  async run(
    passedParams: string[],
    options?: IssueReviewOptions,
  ): Promise<void> {
    fs.mkdirSync(getWfHomeDir(), { recursive: true });

    const source = passedParams[0];

    // Early validation — throws directly so callers can catch without going
    // through ErrorHandler.handle() → process.exit(1).
    if (options?.criteria && options?.replaceCriteria) {
      throw new Error(
        'Cannot use --criteria and --replace-criteria together. Use one or the other.',
      );
    }

    // Pre-load criteria file now to fail fast before any expensive API calls.
    const extraCriteria: string[] | null = options?.replaceCriteria
      ? loadCriteriaFromFile(options.replaceCriteria)
      : options?.criteria
        ? loadCriteriaFromFile(options.criteria)
        : null;

    // Resolve repo base path early so an invalid --repos value emits a warning
    // before any expensive API calls, consistent with issue:implement / issue:all.
    resolveRepoBasePath(options?.repos?.[0]);

    try {
      if (options?.dryRun) {
        this.dryRunPreview.showHeader('issue:review', source || 'current repo');

        if (!source) {
          console.log(chalk.gray('   Source  : current repository git diff\n'));
        } else if (this.isTicketKey(source)) {
          this.dryRunPreview.previewApiCall({
            method: 'GET',
            endpoint: `/rest/api/3/issue/${source}`,
            platform: 'Jira',
            description: 'Fetch ticket details for review context',
            estimatedResponse: '200 OK — ticket title and description',
          });
          this.dryRunPreview.previewApiCall({
            method: 'GET',
            endpoint: `/2.0/repositories/{workspace}/{repo}/pullrequests?q=source.branch.name~"${source}"`,
            platform: 'Bitbucket',
            description: 'Search for open PR with ticket key in branch name',
            estimatedResponse: '200 OK — list of matching pull requests',
          });
          this.dryRunPreview.previewApiCall({
            method: 'GET',
            endpoint: `/2.0/repositories/{workspace}/{repo}/pullrequests/{id}/diff`,
            platform: 'Bitbucket',
            description: 'Fetch pull request diff',
            estimatedResponse: '200 OK — diff content',
          });
        } else if (this.isUrl(source)) {
          this.dryRunPreview.previewApiCall({
            method: 'GET',
            endpoint: source,
            platform: source.includes('github') ? 'GitHub' : 'Bitbucket',
            description: 'Fetch pull request diff',
            estimatedResponse: '200 OK — diff content',
          });
        } else if (
          fs.existsSync(source) ||
          fs.existsSync(path.join(getWfHomeDir(), source))
        ) {
          const resolvedDrySource = fs.existsSync(source)
            ? source
            : path.join(getWfHomeDir(), source);
          console.log(
            chalk.gray(`   Source  : repository at ${resolvedDrySource}\n`),
          );
        }

        this.dryRunPreview.previewApiCall({
          method: 'POST',
          endpoint: '/v1/messages',
          platform: this.aiService.getProviderDisplayName(),
          description: 'Perform AI-powered code review',
          estimatedResponse: [
            '{',
            '  "summary": "<review summary>",',
            '  "approved": true,',
            '  "issues": [],',
            '  "suggestions": ["..."]',
            '}',
          ].join('\n'),
        });

        const willPostComment =
          options?.comment &&
          source &&
          (this.isBitbucketSource(source) || this.isTicketKey(source));

        if (willPostComment) {
          this.dryRunPreview.previewApiCall({
            method: 'POST',
            endpoint:
              '/2.0/repositories/{workspace}/{repo}/pullrequests/{id}/comments',
            platform: 'Bitbucket',
            description: 'Post review summary as PR comment',
            estimatedResponse: '201 Created',
          });
        }

        let fileCreatedCount = 0;
        if (options?.output) {
          this.dryRunPreview.previewFileWrite({
            filePath: path.resolve(options.output),
            operation: 'create',
            sizeEstimate: '2–5 KB',
            format: options?.format || 'text',
            contentPreview: [
              'Code Review Report',
              'Context: <source>',
              '',
              '## Summary',
              '<AI review summary>',
              '',
              '## Issues Found',
              '(none)',
              '',
              'Status: ✓ Approved',
            ].join('\n'),
          });
          fileCreatedCount++;
        }

        const isTicketKey = source && this.isTicketKey(source);
        const isPrUrl = source && this.isUrl(source);
        this.dryRunPreview.showSummary({
          apiCallCount:
            (isTicketKey ? 3 : isPrUrl ? 2 : 1) + (willPostComment ? 1 : 0),
          fileCreatedCount,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          // Optimistic preview — actual approval status depends on AI response at runtime
          terminalOutputLines: [
            '✓ Code review complete',
            '',
            'Summary: <AI-generated review summary>',
            '',
            '✓ No issues found',
            '',
            'Approval Status: ✓ APPROVED',
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      let diff: string;
      let context: string;
      let bitbucketCommentRef: string | undefined;

      if (!source) {
        // Mode 1: No argument - review current repo changes
        console.log(
          chalk.bold.cyan('\n🔍 Reviewing Current Repository Changes\n'),
        );
        diff = await this.reviewCurrentRepo();
        context = 'current repository changes';
      } else if (this.isUrl(source)) {
        // Mode 2: PR URL - review GitHub/BitBucket PR
        console.log(chalk.bold.cyan(`\n🔍 Reviewing Pull Request\n`));
        console.log(chalk.gray(`  URL: ${source}\n`));
        diff = await this.reviewPullRequest(source);
        context = `pull request: ${source}`;
        if (source.includes('bitbucket.org')) {
          bitbucketCommentRef = source;
        }
      } else if (this.isTicketKey(source)) {
        // Mode 3: Ticket key - fetch from platform, search for associated PR
        console.log(
          chalk.bold.cyan(`\n🔍 Reviewing Changes for Ticket: ${source}\n`),
        );

        console.log(chalk.gray(`  Fetching ticket ${source}...\n`));
        const ticket = await this.platformService
          .getDefaultAdapter()
          .getTicket(source);
        context = this.buildTicketContext(ticket);

        const repoHint = options?.repos?.[0] ?? path.basename(process.cwd());
        const prUrl = await this.findBitbucketPr(source, repoHint);
        if (prUrl) {
          console.log(chalk.gray(`  Found PR: ${prUrl}\n`));
          diff = await this.reviewPullRequest(prUrl);
          bitbucketCommentRef = prUrl;
        } else {
          throw new Error(
            `No open pull request found for ${source} in repository "${repoHint}".\n` +
              `  Searched by branch name and PR title.\n` +
              `  To target a specific repo use: --repos <workspace/repo>\n` +
              `  To review uncommitted changes instead, omit the ticket argument:\n` +
              `  wf issue:review`,
          );
        }
      } else if (
        fs.existsSync(source) ||
        fs.existsSync(path.join(getWfHomeDir(), source))
      ) {
        // Mode 4: Path - review specific repo
        const resolvedSource = fs.existsSync(source)
          ? source
          : path.join(getWfHomeDir(), source);
        console.log(chalk.bold.cyan(`\n🔍 Reviewing Repository at Path\n`));
        console.log(chalk.gray(`  Path: ${resolvedSource}\n`));
        diff = await this.reviewRepositoryPath(resolvedSource);
        context = `repository at ${resolvedSource}`;
      } else {
        throw new Error(
          `Invalid source: ${source}. Expected: ticket key (ABC-123), PR URL, or valid path.`,
        );
      }

      if (!diff || diff.trim().length === 0) {
        console.log(chalk.yellow('⚠️  No changes to review'));
        console.log(
          chalk.gray(
            'Make sure you have changes to review (commits, staged, or unstaged)\n',
          ),
        );
        return;
      }

      console.log(chalk.cyan('🤖 Analyzing changes with AI...\n'));

      // Build review guidelines using pre-loaded extraCriteria.
      const relevancyGuideline = `Relevancy: Does the feature or fix work? (This is very important — context: ${context})`;
      const guidelines: string[] = options?.replaceCriteria
        ? extraCriteria!
        : [
            ...DEFAULT_REVIEW_GUIDELINES,
            relevancyGuideline,
            ...(extraCriteria ?? []),
          ];

      // Perform AI review
      const review = await this.aiService.reviewCode(diff, guidelines);

      console.log(chalk.green('✓ Code review complete\n'));

      // Display review results
      this.displayReview(review);

      // Post comment to Bitbucket if requested
      if (options?.comment) {
        if (bitbucketCommentRef) {
          await this.postBitbucketComment(bitbucketCommentRef, review);
        } else {
          console.log(
            chalk.yellow(
              '  ⚠️  --comment skipped: no Bitbucket PR associated with this review\n',
            ),
          );
        }
      }

      // Save to file if requested
      if (options?.output) {
        const outputPath = path.resolve(options.output);
        const reviewText = this.formatReviewAsText(review, context);
        fs.writeFileSync(outputPath, reviewText);
        console.log(chalk.green(`\n✓ Review saved to: ${outputPath}\n`));
      }
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  @Option({
    flags: '-f, --format <format>',
    description: 'Output format (text|json|md) - default: text',
  })
  parseFormat(val: string): string {
    return val;
  }

  @Option({
    flags: '-o, --output <path>',
    description: 'Save review to file',
  })
  parseOutput(val: string): string {
    return val;
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the review operation without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '--comment',
    description: 'Post review as a comment on the Bitbucket PR',
  })
  parseComment(): boolean {
    return true;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
    required: false,
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '--criteria <path>',
    description:
      'Path to a markdown file with additional review criteria to append to the defaults',
  })
  parseCriteria(val: string): string {
    return val;
  }

  @Option({
    flags: '--replace-criteria <path>',
    description:
      'Path to a markdown file whose criteria replace the default review guidelines entirely',
  })
  parseReplaceCriteria(val: string): string {
    return val;
  }

  /**
   * Search Bitbucket for an open PR whose source branch contains the ticket key.
   * @param ticketKey Jira-style ticket key (e.g. "WBP-2955")
   * @param repo Repo in "workspace/repo" format
   * @returns PR URL if found, null otherwise
   */
  private async findBitbucketPr(
    ticketKey: string,
    repo: string,
  ): Promise<string | null> {
    const adapter = this.platformService.getAdapter('bitbucket');
    return adapter.findPullRequestByTicketKey?.(ticketKey, repo) ?? null;
  }

  /**
   * Build a rich review context string from a fetched ticket.
   * @param ticket Universal ticket data
   * @returns Context string for the AI review prompt
   */
  private buildTicketContext(ticket: UniversalTicket): string {
    return `ticket ${ticket.key}: ${ticket.title}\n\n${ticket.description}`;
  }

  /**
   * Post the AI review as a Bitbucket PR comment.
   * @param prUrl Bitbucket PR URL to comment on
   * @param review The AI review result
   */
  private async postBitbucketComment(
    prUrl: string,
    review: any,
  ): Promise<void> {
    const adapter = this.platformService.getAdapter('bitbucket');

    const inlineIssues: CodeIssue[] = (review.issues ?? []).filter(
      (i: CodeIssue) =>
        (i.severity === 'error' || i.severity === 'warning') &&
        i.file != null &&
        i.line != null &&
        i.line > 0,
    );

    if (inlineIssues.length > 0 && adapter.createInlineComment) {
      console.log(
        chalk.cyan(
          `💬 Posting ${inlineIssues.length} inline comment(s) to Bitbucket...\n`,
        ),
      );
      for (const issue of inlineIssues) {
        const body = issue.message;
        try {
          await adapter.createInlineComment(
            prUrl,
            issue.file!,
            issue.line!,
            body,
          );
        } catch (err: any) {
          console.log(
            chalk.yellow(
              `  ⚠️  Inline comment skipped (${issue.file}:${issue.line}): ${err.message}\n`,
            ),
          );
        }
      }
      console.log(chalk.green('✓ Inline comments posted\n'));
    }
  }

  /**
   * Format an AI review as a Bitbucket-ready markdown comment.
   * Omits the approval status section.
   * @param review The AI review result
   * @returns Markdown string
   */
  private formatReviewAsComment(review: any): string {
    let body = '';

    if (review.issues && review.issues.length > 0) {
      body += `\n### Issues (${review.issues.length})\n`;
      review.issues.forEach((issue: any) => {
        const location = issue.file
          ? ` — ${issue.file}${issue.line ? `:${issue.line}` : ''}`
          : '';
        body += `- ${issue.message}${location}\n`;
      });
    }

    return body;
  }

  /**
   * Check if string is a Bitbucket source (URL or issue reference)
   */
  private isBitbucketSource(str: string): boolean {
    return (
      str.includes('bitbucket.org') ||
      /^\d+$/.test(str) ||
      /^[^/]+\/[^#]+#\d+$/.test(str)
    );
  }

  /**
   * Review current repository changes
   */
  private async reviewCurrentRepo(): Promise<string> {
    const isRepo = await this.gitService.isGitRepository();
    if (!isRepo) {
      throw new Error('Not a git repository');
    }

    // Try to get diff (staged or unstaged)
    let diff = await this.gitService.getDiff(true); // Try staged first
    if (!diff || diff.trim().length === 0) {
      diff = await this.gitService.getDiff(false); // Try unstaged
    }

    return diff;
  }

  /**
   * Review pull request from URL
   */
  private async reviewPullRequest(url: string): Promise<string> {
    // Determine platform from URL
    if (url.includes('github.com')) {
      const adapter = this.platformService.getAdapter('github');
      return await adapter.getPullRequestDiff!(url);
    } else if (url.includes('bitbucket.org')) {
      const adapter = this.platformService.getAdapter('bitbucket');
      return await adapter.getPullRequestDiff!(url);
    } else {
      throw new Error(
        'Unsupported PR URL. Only GitHub and BitBucket are supported.',
      );
    }
  }

  /**
   * Review repository at specific path. When no .git directory is present,
   * falls back to collecting source file contents for review instead of throwing,
   * allowing review of directories not yet initialised as git repos.
   * @param repoPath Absolute or relative path to the directory
   * @returns Diff string or collected file contents
   */
  private async reviewRepositoryPath(repoPath: string): Promise<string> {
    const resolvedPath = path.resolve(repoPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }

    const gitDir = path.join(resolvedPath, '.git');
    if (!fs.existsSync(gitDir)) {
      console.log(
        chalk.yellow(
          `  ⚠️  No .git directory found — collecting source files for review\n`,
        ),
      );
      return this.collectFilesForReview(resolvedPath);
    }

    const currentDir = process.cwd();
    try {
      process.chdir(resolvedPath);
      return await this.gitService.getDiff(false);
    } finally {
      process.chdir(currentDir);
    }
  }

  /**
   * Collect source file contents from a directory for AI review.
   * Used when the directory has no .git working tree.
   * Reads .ts, .js, and .json files up to 50 KB each,
   * skipping node_modules, dist, and .git.
   * @param dirPath Absolute path to the directory to scan
   * @returns Formatted string of file contents ready for AI review
   */
  private collectFilesForReview(dirPath: string): string {
    const maxFileSizeInBytes = 50 * 1024;
    const allowedExtensions = new Set(['.ts', '.js', '.json']);
    const excludedDirs = new Set(['node_modules', 'dist', '.git']);

    const collectPaths = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.flatMap((entry) => {
        if (entry.isDirectory()) {
          return excludedDirs.has(entry.name)
            ? []
            : collectPaths(path.join(dir, entry.name));
        }
        const ext = path.extname(entry.name);
        return allowedExtensions.has(ext) ? [path.join(dir, entry.name)] : [];
      });
    };

    const filePaths = collectPaths(dirPath);
    if (filePaths.length === 0) {
      return `# Directory Review: ${dirPath}\n\nNo .ts, .js, or .json source files found.`;
    }

    const sections = filePaths.map((filePath) => {
      const relativePath = path.relative(dirPath, filePath);
      if (fs.statSync(filePath).size > maxFileSizeInBytes) {
        return `## ${relativePath}\n\n_Skipped: exceeds ${maxFileSizeInBytes / 1024} KB_\n`;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const ext = path.extname(filePath).slice(1) || 'text';
      return `## ${relativePath}\n\n\`\`\`${ext}\n${content}\n\`\`\`\n`;
    });

    return `# Directory Review: ${dirPath}\n\n${sections.join('\n')}`;
  }

  /**
   * Check if string is a URL
   */
  private isUrl(str: string): boolean {
    return str.startsWith('http://') || str.startsWith('https://');
  }

  /**
   * Check if string is a ticket key (format: ABC-123)
   */
  private isTicketKey(str: string): boolean {
    return /^[A-Z]+-\d+$/i.test(str);
  }

  /**
   * Display review results
   */
  private displayReview(review: any): void {
    console.log(chalk.bold('Summary:'));
    console.log(chalk.bold.cyan('  ' + review.summary));

    if (review.issues && review.issues.length > 0) {
      console.log(chalk.bold('\nIssues Found:'));
      review.issues.forEach((issue: any) => {
        const severityColor =
          issue.severity === 'error'
            ? chalk.red
            : issue.severity === 'warning'
              ? chalk.yellow
              : chalk.blue;
        console.log(
          severityColor(`  [${issue.severity.toUpperCase()}] ${issue.message}`),
        );
        if (issue.file) {
          console.log(
            chalk.gray(
              `    File: ${issue.file}${issue.line ? `:${issue.line}` : ''}`,
            ),
          );
        }
      });
    } else {
      console.log(chalk.green('\n✓ No issues found'));
    }

    if (review.suggestions && review.suggestions.length > 0) {
      console.log(chalk.bold('\nSuggestions:'));
      review.suggestions.forEach((suggestion: any) => {
        console.log(chalk.cyan(`  💡 ${suggestion}`));
      });
    }

    console.log(
      chalk.bold('\nApproval Status:'),
      review.approved ? chalk.green('✓ APPROVED') : chalk.red('✗ NOT APPROVED'),
    );

    if (!review.approved) {
      console.log(
        chalk.yellow('\n⚠️  Address the issues above before proceeding'),
      );
    }

    console.log();
  }

  /**
   * Format review as text for file output
   */
  private formatReviewAsText(review: any, context: string): string {
    let text = `Code Review Report\n`;
    text += `Context: ${context}\n`;
    text += `Generated: ${new Date().toISOString()}\n`;
    text += `\n${'='.repeat(70)}\n\n`;

    text += `SUMMARY:\n${review.summary}\n\n`;

    if (review.issues && review.issues.length > 0) {
      text += `ISSUES FOUND (${review.issues.length}):\n`;
      review.issues.forEach((issue: any, index: number) => {
        text += `\n${index + 1}. [${issue.severity.toUpperCase()}] ${issue.message}\n`;
        if (issue.file) {
          text += `   File: ${issue.file}${issue.line ? `:${issue.line}` : ''}\n`;
        }
      });
      text += '\n';
    } else {
      text += 'ISSUES: None\n\n';
    }

    if (review.suggestions && review.suggestions.length > 0) {
      text += `SUGGESTIONS (${review.suggestions.length}):\n`;
      review.suggestions.forEach((suggestion: any, index: number) => {
        text += `${index + 1}. ${suggestion}\n`;
      });
      text += '\n';
    }

    text += `APPROVAL: ${review.approved ? 'APPROVED' : 'NOT APPROVED'}\n`;

    return text;
  }
}
