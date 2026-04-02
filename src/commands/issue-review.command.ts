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
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

interface IssueReviewOptions {
  format?: string;
  output?: string;
  dryRun?: boolean;
  comment?: boolean;
  platform?: string;
  repos?: string[];
  criteria?: string;
  replaceCriteria?: string;
}

const ISSUE_REVIEW_EXAMPLES: CliExample[] = [
  {
    comment: 'Review current repo changes',
    command: 'wf issue:review',
  },
  {
    comment: 'Review with ticket context',
    command: 'wf issue:review WBP-2971 --platform jira --format md',
  },
];

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
 * Review code changes in the current or selected repositories, optionally
 * adding ticket context or reviewing a pull request URL directly.
 */
@Injectable()
@Command({
  name: 'issue:review',
  description:
    'AI-powered code review of local repository changes or pull request diffs',
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
    printExamples(ISSUE_REVIEW_EXAMPLES);

    const source = passedParams[0];
    const repoDirs = options?.repos?.length
      ? options.repos.map((repo) => resolveRepoBasePath(repo))
      : [process.cwd()];

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

    try {
      if (options?.dryRun) {
        this.dryRunPreview.showHeader('issue:review', source || 'current repo');

        if (!source) {
          console.log(
            chalk.gray(
              `   Source  : working tree diff in ${repoDirs.length} repo(s)\n`,
            ),
          );
        } else if (this.isTicketKey(source)) {
          this.dryRunPreview.previewApiCall({
            method: 'GET',
            endpoint: `/rest/api/3/issue/${source}`,
            platform: 'Jira',
            description: 'Fetch ticket details for review context',
            estimatedResponse: '200 OK — ticket title and description',
          });
        } else if (this.isUrl(source)) {
          this.dryRunPreview.previewApiCall({
            method: 'GET',
            endpoint: source,
            platform: source.includes('github') ? 'GitHub' : 'Bitbucket',
            description: 'Fetch pull request diff',
            estimatedResponse: '200 OK — diff content',
          });
        } else {
          throw new Error(
            `Invalid source: ${source}. Expected: ticket key (ABC-123) or PR URL.`,
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
          options?.comment && source && this.isBitbucketSource(source);

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
            (isTicketKey ? 2 : isPrUrl ? 2 : 1) + (willPostComment ? 1 : 0),
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
        diff = await this.reviewRepoSet(repoDirs);
        context = this.buildRepoContext(repoDirs, 'current repository changes');
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
        // Mode 3: Ticket key - fetch ticket context, then review local repo changes
        console.log(
          chalk.bold.cyan(`\n🔍 Reviewing Changes for Ticket: ${source}\n`),
        );

        console.log(chalk.gray(`  Fetching ticket ${source}...\n`));
        const ticket = await this.platformService
          .getDefaultAdapter()
          .getTicket(source);
        diff = await this.reviewRepoSet(repoDirs);
        context = `${this.buildTicketContext(ticket)}\n\n${this.buildRepoContext(repoDirs, 'repositories under review')}`;
      } else {
        throw new Error(
          `Invalid source: ${source}. Expected: ticket key (ABC-123) or PR URL.`,
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
    flags: '--comment',
    description: 'Post review as a comment on the Bitbucket PR',
  })
  parseComment(): boolean {
    return true;
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
    flags: '--dry-run',
    description: 'Preview the review operation without making changes',
  })
  parseDryRun(): boolean {
    return true;
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
    flags: '-p, --platform <platform>',
    description: 'Platform (jira|github|bitbucket)',
  })
  parsePlatform(val: string): string {
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

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; first repo anchors local review context and all repos are inspected for local changes',
    required: false,
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
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
  private async reviewCurrentRepo(repoDir: string): Promise<string> {
    const isRepo = await this.gitService.isGitRepository(repoDir);
    if (!isRepo) {
      throw new Error(`Not a git repository: ${repoDir}`);
    }

    // Try to get diff (staged or unstaged)
    let diff = await this.gitService.getDiff(true, repoDir); // Try staged first
    if (!diff || diff.trim().length === 0) {
      diff = await this.gitService.getDiff(false, repoDir); // Try unstaged
    }

    return diff;
  }

  private async reviewRepoSet(repoDirs: string[]): Promise<string> {
    const sections: string[] = [];

    for (const repoDir of repoDirs) {
      const diff = await this.reviewCurrentRepo(repoDir);
      if (!diff || diff.trim().length === 0) {
        continue;
      }

      sections.push(
        repoDirs.length > 1
          ? `## Repository: ${path.basename(repoDir)}\n\n${diff}`
          : diff,
      );
    }

    return sections.join('\n\n');
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

  private buildRepoContext(repoDirs: string[], label: string): string {
    const repoNames = repoDirs
      .map((repoDir) => path.basename(repoDir))
      .join(', ');
    return `${label}: ${repoNames}`;
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
