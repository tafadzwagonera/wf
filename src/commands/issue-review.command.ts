import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import inquirer from 'inquirer';
import {
  AiService,
  CodeIssue,
  CodeReview,
} from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { UniversalTicket } from '../common/dto/universal-ticket.dto';
import { resolveCustomArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
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

interface ReviewTarget {
  title: string;
  diff: string;
  context: string;
  adapterName?: string;
  commentRef?: string;
}

interface ReviewedTarget extends ReviewTarget {
  review: CodeReview;
}

type TraceProvenance = 'evidence-based' | 'best-effort' | 'unavailable';

interface DiscoveredPullRequestTarget {
  adapterName: string;
  commentRef: string;
  title: string;
  context: string;
}

const ISSUE_REVIEW_EXAMPLES: CliExample[] = [
  {
    comment: 'Review current repo changes',
    command: 'wf issue:review',
  },
  {
    comment: 'Review a ticket and its associated pull requests',
    command: 'wf issue:review WBP-2971 --platform jira --repos service-tourv3',
  },
];

/**
 * Parse a markdown criteria file into an array of guideline strings.
 * Strips leading bullet/number markers and blank lines.
 * @param filePath Absolute or relative path to the criteria markdown file
 * @returns Array of non-empty guideline strings
 */
const loadCriteriaFromFile = (filePath: string): string[] => {
  const resolved = path.resolve(filePath);

  if (path.extname(resolved).toLowerCase() !== '.md') {
    throw new Error(`Criteria file must be a Markdown (.md) file: ${filePath}`);
  }

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
 * adding ticket context, reviewing ticket-associated pull requests, or
 * reviewing a pull request URL directly.
 */
@Injectable()
@Command({
  name: 'issue:review',
  description:
    'AI-powered code review of local repository changes, ticket-associated pull requests, or pull request diffs',
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
    private readonly reviewStageService: ReviewStageService,
  ) {
    super();
  }

  async run(
    passedParams: string[],
    options?: IssueReviewOptions,
  ): Promise<void> {
    printExamples(ISSUE_REVIEW_EXAMPLES);

    const source = passedParams[0];
    const repoInputs = options?.repos?.length ? options.repos : [];
    const repoDirs = repoInputs.length
      ? repoInputs.map((repo) => resolveRepoBasePath(repo))
      : [process.cwd()];

    try {
      if (options?.criteria && options?.replaceCriteria) {
        throw new Error(
          'Cannot use --criteria and --replace-criteria together. Use one or the other.',
        );
      }

      const extraCriteria: string[] | null = options?.replaceCriteria
        ? loadCriteriaFromFile(options.replaceCriteria)
        : options?.criteria
          ? loadCriteriaFromFile(options.criteria)
          : null;

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
          this.dryRunPreview.previewApiCall({
            method: 'GET',
            endpoint: '<ticket-associated pull requests>',
            platform: 'Primary platform adapters',
            description:
              'Discover associated open pull requests for the ticket',
            estimatedResponse: '200 OK — 0..n pull request URLs',
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
            '  "traceProvenance": "best-effort",',
            '  "callStack": ["..."],',
            '  "stateTransition": { "...": "..." },',
            '  "suggestions": ["..."]',
            '}',
          ].join('\n'),
        });

        const willPostComment = Boolean(options?.comment && source);

        if (willPostComment) {
          this.dryRunPreview.previewApiCall({
            method: 'POST',
            endpoint: '<pull-request comments endpoint>',
            platform: 'Supported PR platforms',
            description: 'Post review summary as a PR comment',
            estimatedResponse: '201 Created',
          });
        }

        let fileCreatedCount = 0;
        if (options?.output) {
          const outputPath = this.resolveOutputPath(
            options.output,
            repoDirs[0] ?? process.cwd(),
          );
          this.dryRunPreview.previewFileWrite({
            filePath: outputPath,
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
              '## Call Stack',
              'Provenance: best-effort',
              'Best effort: call stack is reconstructed from review context and AI output.',
              'Hindrance: the review command does not capture a runtime execution trace.',
              '- (none)',
              '',
              '## State Transition',
              'Provenance: best-effort',
              'Best effort: state transitions are inferred from the reviewed diff and AI output.',
              'Hindrance: the review pipeline does not emit a machine-verified state trace.',
              '{ }',
              '',
              '## Suggestions',
              '(none)',
              '',
              '## Approval Status',
              '✓ Approved',
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
            'Call Stack: provenance best-effort',
            'State Transition: provenance best-effort',
            '',
            'Approval Status: ✓ APPROVED',
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      const reviewTargets: ReviewTarget[] = [];

      if (!source) {
        // Mode 1: No argument - review current repo changes
        console.log(
          chalk.bold.cyan('\n🔍 Reviewing Current Repository Changes\n'),
        );
        const diff = await this.reviewRepoSet(repoDirs);
        reviewTargets.push({
          title: 'Current repository changes',
          diff,
          context: this.buildRepoContext(
            repoDirs,
            'current repository changes',
          ),
        });
      } else if (this.isUrl(source)) {
        // Mode 2: PR URL - review GitHub/BitBucket PR
        console.log(chalk.bold.cyan(`\n🔍 Reviewing Pull Request\n`));
        console.log(chalk.gray(`  URL: ${source}\n`));
        reviewTargets.push({
          title: this.formatPullRequestTitle(source),
          diff: await this.reviewPullRequest(source),
          context: `pull request: ${source}`,
          adapterName: this.resolveAdapterNameForPullRequestUrl(source),
          commentRef: source,
        });
      } else if (this.isTicketKey(source)) {
        // Mode 3: Ticket key - fetch ticket context, then review associated PRs or local changes
        console.log(
          chalk.bold.cyan(`\n🔍 Reviewing Changes for Ticket: ${source}\n`),
        );

        const ticketAdapter = options?.platform
          ? this.platformService.getAdapter(options.platform)
          : this.platformService.getDefaultAdapter();

        console.log(
          chalk.gray(
            `  Fetching ticket ${source} from ${ticketAdapter.getPlatformName()}...\n`,
          ),
        );
        const ticket = await ticketAdapter.getTicket(source);
        if (!ticket) {
          throw new Error(`Ticket lookup failed for ${source}`);
        }

        const ticketReviewContext = this.buildTicketContext(ticket);
        const discoveredPullRequests = await this.discoverTicketPullRequests(
          source,
          repoInputs,
        );

        if (discoveredPullRequests.length > 0) {
          console.log(
            chalk.gray(
              `  Found ${discoveredPullRequests.length} open pull request(s) for ${source}\n`,
            ),
          );

          for (const pullRequest of discoveredPullRequests) {
            try {
              const diff = await this.reviewPullRequest(pullRequest.commentRef);
              reviewTargets.push({
                title: pullRequest.title,
                diff,
                context: `${ticketReviewContext}\n\n${pullRequest.context}`,
                adapterName: pullRequest.adapterName,
                commentRef: pullRequest.commentRef,
              });
            } catch (error: any) {
              console.log(
                chalk.yellow(
                  `⚠️  Skipping ${pullRequest.title}: ${error.message}`,
                ),
              );
            }
          }
        } else {
          console.log(
            chalk.yellow(
              `⚠️ No open pull requests were found for ticket ${source}`,
            ),
          );

          const fallbackDecision = await this.promptTicketFallbackAction();
          if (fallbackDecision === 'return') {
            return;
          }

          const diff = await this.reviewRepoSet(repoDirs);
          reviewTargets.push({
            title: 'Local repository changes',
            diff,
            context: `${ticketReviewContext}\n\n${this.buildRepoContext(repoDirs, 'repositories under review')}`,
          });
        }
      } else {
        throw new Error(
          `Invalid source: ${source}. Expected: ticket key (ABC-123) or PR URL.`,
        );
      }

      const reviewableTargets = reviewTargets.filter(
        (target) => target.diff.trim().length > 0,
      );

      if (reviewableTargets.length === 0) {
        console.log(chalk.yellow('⚠️  No changes to review'));
        console.log(
          chalk.gray(
            'Make sure you have changes to review (commits, staged, or unstaged)\n',
          ),
        );
        return;
      }

      console.log(chalk.cyan('🤖 Analyzing changes with AI...\n'));

      const reviewedTargets: ReviewedTarget[] = [];
      for (const target of reviewableTargets) {
        const review = await this.reviewStageService.reviewDiff(target.diff, {
          context: target.context,
          extraCriteria: extraCriteria ?? undefined,
          replaceCriteria: Boolean(options?.replaceCriteria),
        });

        reviewedTargets.push({ ...target, review });
        this.displayReview(review, target.title);

        if (options?.comment) {
          await this.postReviewComment(target, review);
        }
      }

      console.log(chalk.green('✓ Code review complete\n'));

      // Save to file if requested
      if (options?.output) {
        const outputPath = this.resolveOutputPath(
          options.output,
          repoDirs[0] ?? process.cwd(),
        );
        const reviewText = this.formatReviewAsText(reviewedTargets);
        fs.writeFileSync(outputPath, reviewText);
        console.log(chalk.green(`\n✓ Review saved to: ${outputPath}\n`));
      }
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  @Option({
    flags: '--comment',
    description: 'Post review as a comment on supported pull requests',
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
    description:
      'Platform (jira|github|bitbucket) used to resolve a ticket source; defaults to the configured primary platform',
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
   * Resolve the trace provenance from AI output, defaulting to best-effort
   * when structured trace data is present but no explicit provenance exists.
   * @param review The AI review result
   * @returns Provenance label for trace sections
   */
  private resolveTraceProvenance(review: CodeReview): TraceProvenance {
    if (review.traceProvenance) {
      return review.traceProvenance;
    }

    if (
      review.callStack?.length ||
      Object.keys(review.stateTransition ?? {}).length
    ) {
      return 'best-effort';
    }

    return 'unavailable';
  }

  /**
   * Render a provenance note for trace sections.
   * @param review The AI review result
   * @param colorized Whether terminal colors should be applied
   * @returns Rendered provenance note block
   */
  private formatTraceProvenanceNote(
    review: CodeReview,
    colorized: boolean,
  ): string {
    const provenance = this.resolveTraceProvenance(review);
    const line =
      provenance === 'evidence-based'
        ? 'Provenance: evidence-based (agent-backed trace data)'
        : provenance === 'best-effort'
          ? 'Provenance: best-effort (generated without an execution-trace backend)'
          : 'Provenance: unavailable (no structured trace data was returned)';

    if (!colorized) {
      return `  ${line}`;
    }

    if (provenance === 'evidence-based') {
      return chalk.green(`  ${line}`);
    }

    if (provenance === 'best-effort') {
      return chalk.yellow(`  ${line}`);
    }

    return chalk.gray(`  ${line}`);
  }

  /**
   * Render the supporting note block for a trace section based on provenance.
   * @param review The AI review result
   * @param colorized Whether terminal colors should be applied
   * @param sectionLabel Human-friendly section label
   * @returns Supporting note block for the trace section
   */
  private formatTraceSectionNotes(
    review: CodeReview,
    colorized: boolean,
    sectionLabel: 'call stack' | 'state transition',
  ): string[] {
    const provenance = this.resolveTraceProvenance(review);
    const provenanceNote = this.formatTraceProvenanceNote(review, colorized);

    if (provenance === 'evidence-based') {
      const evidenceLine = colorized
        ? chalk.green(
            `  Evidence: generated by the selected execution backend for the ${sectionLabel} section.`,
          )
        : `  Evidence: generated by the selected execution backend for the ${sectionLabel} section.`;

      return [provenanceNote, evidenceLine];
    }

    if (provenance === 'unavailable') {
      const unavailableLine = colorized
        ? chalk.gray(
            `  Trace unavailable: no structured ${sectionLabel} data was returned.`,
          )
        : `  Trace unavailable: no structured ${sectionLabel} data was returned.`;

      return [provenanceNote, unavailableLine];
    }

    const bestEffortText =
      sectionLabel === 'call stack'
        ? 'Best effort: call stack is reconstructed from review context and AI output.'
        : 'Best effort: state transitions are inferred from the reviewed diff and AI output.';
    const hindranceText =
      sectionLabel === 'call stack'
        ? 'Hindrance: the review command does not capture a runtime execution trace.'
        : 'Hindrance: the review pipeline does not emit a machine-verified state trace.';

    return [
      provenanceNote,
      this.formatBestEffortNote(bestEffortText, hindranceText, colorized),
    ];
  }

  /**
   * Post the AI review as a pull request comment when the adapter supports it.
   * @param target Review target metadata
   * @param review The AI review result
   */
  private async postReviewComment(
    target: ReviewTarget,
    review: CodeReview,
  ): Promise<void> {
    const commentBody = this.formatReviewAsComment(review);
    const adapterName =
      target.adapterName ??
      this.resolveAdapterNameForPullRequestUrl(target.commentRef ?? '');

    if (!adapterName) {
      console.log(
        chalk.yellow(
          `  ⚠️  --comment skipped for ${target.title}: no supported PR adapter was resolved\n`,
        ),
      );
      return;
    }

    let adapter: any;
    try {
      adapter = this.platformService.getAdapter(adapterName);
    } catch (error: any) {
      console.log(
        chalk.yellow(
          `  ⚠️  --comment skipped for ${target.title}: ${error.message}\n`,
        ),
      );
      return;
    }
    if (!adapter.createComment) {
      console.log(
        chalk.yellow(
          `  ⚠️  --comment skipped for ${target.title}: comment API is not supported by ${adapterName}\n`,
        ),
      );
      return;
    }

    try {
      await adapter.createComment(
        target.commentRef ?? target.title,
        commentBody,
      );
    } catch (error: any) {
      console.log(
        chalk.yellow(
          `  ⚠️  --comment skipped for ${target.title}: ${error.message}\n`,
        ),
      );
      return;
    }

    const inlineIssues: CodeIssue[] = (review.issues ?? []).filter(
      (issue: CodeIssue) =>
        (issue.severity === 'error' || issue.severity === 'warning') &&
        issue.file != null &&
        issue.line != null &&
        issue.line > 0,
    );

    if (inlineIssues.length > 0 && adapter.createInlineComment) {
      console.log(
        chalk.cyan(
          `💬 Posting ${inlineIssues.length} inline comment(s) to ${adapterName}...\n`,
        ),
      );

      for (const issue of inlineIssues) {
        try {
          await adapter.createInlineComment(
            target.commentRef ?? target.title,
            issue.file!,
            issue.line!,
            issue.message,
          );
        } catch (error: any) {
          console.log(
            chalk.yellow(
              `  ⚠️  Inline comment skipped (${issue.file}:${issue.line}): ${error.message}\n`,
            ),
          );
        }
      }
    }
  }

  /**
   * Format an AI review as a comment body for PR platforms.
   * @param review The AI review result
   * @returns Markdown string
   */
  private formatReviewAsComment(review: CodeReview): string {
    const lines: string[] = ['## AI Code Review', ''];
    lines.push(`**Summary:** ${review.summary}`);
    lines.push('');
    lines.push('### Issues');

    if (review.issues.length > 0) {
      for (const issue of review.issues) {
        const location = issue.file
          ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})`
          : '';
        lines.push(`- [${issue.severity}] ${issue.message}${location}`);
      }
    } else {
      lines.push('- None');
    }

    lines.push('');
    lines.push('### Call Stack');
    lines.push(this.formatCallStackPlain(review));
    lines.push('');
    lines.push('### State Transition');
    lines.push(this.formatStateTransitionPlain(review));
    lines.push('');
    lines.push('### Suggestions');

    if (review.suggestions.length > 0) {
      for (const suggestion of review.suggestions) {
        lines.push(`- ${suggestion}`);
      }
    } else {
      lines.push('- None');
    }

    lines.push('');
    lines.push(
      `**Approval Status:** ${review.approved ? '✓ Approved' : '✗ Changes needed'}`,
    );

    return lines.join('\n');
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
   * Discover all pull requests associated with a ticket across registered adapters.
   * @param ticketKey Ticket key to search for
   * @param repoInputs Raw repo arguments supplied on the command line
   * @returns Stable list of PR metadata objects
   */
  private async discoverTicketPullRequests(
    ticketKey: string,
    repoInputs: string[],
  ): Promise<DiscoveredPullRequestTarget[]> {
    const adapters = [...this.platformService.getAllAdapters().entries()]
      .filter(
        ([, adapter]) =>
          typeof adapter.findPullRequestsByTicketKey === 'function',
      )
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));

    const repoHints = repoInputs.length
      ? repoInputs.map((repo) => this.normalizeRepoHint(repo))
      : [undefined];

    const discovered = new Map<string, DiscoveredPullRequestTarget>();

    for (const repoHint of repoHints) {
      for (const [adapterName, adapter] of adapters) {
        let pullRequestUrls: string[] = [];
        try {
          pullRequestUrls = await adapter.findPullRequestsByTicketKey!(
            ticketKey,
            repoHint,
          );
        } catch (error: any) {
          console.log(
            chalk.yellow(
              `⚠️  PR discovery skipped for ${adapterName}${repoHint ? ` (${repoHint})` : ''}: ${error.message}`,
            ),
          );
          continue;
        }

        for (const url of pullRequestUrls) {
          const cacheKey = `${adapterName}:${url}`;
          if (discovered.has(cacheKey)) {
            continue;
          }

          discovered.set(cacheKey, {
            adapterName,
            commentRef: url,
            title: this.formatPullRequestTitle(url),
            context: `pull request: ${url}`,
          });
        }
      }
    }

    return [...discovered.values()].sort((left, right) => {
      const adapterComparison = left.adapterName.localeCompare(
        right.adapterName,
      );
      if (adapterComparison !== 0) {
        return adapterComparison;
      }

      const numberComparison =
        this.extractPullRequestNumber(left.commentRef) -
        this.extractPullRequestNumber(right.commentRef);
      if (numberComparison !== 0) {
        return numberComparison;
      }

      return left.commentRef.localeCompare(right.commentRef);
    });
  }

  /**
   * Ask the user how ticket review should proceed when no pull request is found.
   * Falls back to returning without review when the session is non-interactive.
   * @returns The selected fallback action
   */
  private async promptTicketFallbackAction(): Promise<'local' | 'return'> {
    if (!this.isInteractiveSession()) {
      console.log(
        chalk.yellow(
          '⚠️  Non-interactive session; returning without local review',
        ),
      );
      return 'return';
    }

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'decision',
        message: 'No pull request was found. What would you like to do?',
        choices: [
          { name: 'Review local changes', value: 'local' },
          { name: 'Return without reviewing', value: 'return' },
        ],
      },
    ]);

    return answers.decision as 'local' | 'return';
  }

  /**
   * Determine whether the current process can prompt the user interactively.
   * @returns True when stdin and stdout are attached to a TTY
   */
  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  /**
   * Normalize a repo hint so PR discovery can reuse local repo names.
   * @param repo Raw repo argument
   * @returns PR lookup hint
   */
  private normalizeRepoHint(repo: string): string {
    if (
      path.isAbsolute(repo) ||
      repo.includes(path.sep) ||
      repo.startsWith('.')
    ) {
      return path.basename(repo);
    }

    return repo;
  }

  /**
   * Resolve the adapter name for a pull request URL.
   * @param url Pull request URL
   * @returns Adapter name or undefined when unsupported
   */
  private resolveAdapterNameForPullRequestUrl(url: string): string | undefined {
    if (url.includes('github.com')) {
      return 'github';
    }

    if (url.includes('bitbucket.org')) {
      return 'bitbucket';
    }

    return undefined;
  }

  /**
   * Format a pull request title for grouped output.
   * @param url Pull request URL
   * @returns Human-friendly title string
   */
  private formatPullRequestTitle(url: string): string {
    const adapterName = this.resolveAdapterNameForPullRequestUrl(url);
    const pullRequestNumber = this.extractPullRequestNumber(url);

    if (adapterName === 'github') {
      return `GitHub PR #${pullRequestNumber}`;
    }

    if (adapterName === 'bitbucket') {
      return `Bitbucket PR #${pullRequestNumber}`;
    }

    return `Pull Request: ${url}`;
  }

  /**
   * Extract a numeric pull request identifier from a PR URL.
   * @param url Pull request URL
   * @returns Pull request number or Number.MAX_SAFE_INTEGER if unavailable
   */
  private extractPullRequestNumber(url: string): number {
    const match = url.match(/\/pull\/(\d+)|\/pull-requests\/(\d+)/);
    const value = match?.[1] ?? match?.[2];
    return value ? parseInt(value, 10) : Number.MAX_SAFE_INTEGER;
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
   * Render a best-effort note with an explicit hindrance statement.
   * @param bestEffortText Best-effort description
   * @param hindranceText Hindrance description
   * @param colorized Whether terminal colors should be applied
   * @returns Rendered note text
   */
  private formatBestEffortNote(
    bestEffortText: string,
    hindranceText: string,
    colorized: boolean,
  ): string {
    if (!colorized) {
      return `  ${bestEffortText}\n  ${hindranceText}`;
    }

    return [
      chalk.yellow(`  ${bestEffortText}`),
      chalk.gray(`  ${hindranceText}`),
    ].join('\n');
  }

  /**
   * Apply semantic colors to a call stack branch marker.
   * @param branch Branch marker
   * @returns Colorized branch marker
   */
  private colorizeBranch(branch: string): string {
    return chalk.blueBright(branch);
  }

  /**
   * Apply semantic colors to a call stack frame.
   * @param frame Frame description
   * @returns Colorized frame text
   */
  private colorizeCallStackFrame(frame: string): string {
    return chalk.whiteBright(frame);
  }

  /**
   * Apply muted formatting to a single informational line.
   * @param line Plain text line
   * @returns Muted line
   */
  private colorizeMutedLine(line: string): string {
    return chalk.gray(line);
  }

  /**
   * Colorize a JSON-like state transition structure for terminal output.
   * @param stateTransition Structured state transition object
   * @returns Pretty-printed and colorized text
   */
  private colorizeJsonLike(stateTransition: Record<string, unknown>): string {
    return JSON.stringify(stateTransition, null, 2)
      .split('\n')
      .map((line) => this.colorizeJsonLine(line))
      .join('\n');
  }

  /**
   * Colorize an individual JSON-like line using semantic colors.
   * @param line JSON-like line
   * @returns Colorized line
   */
  private colorizeJsonLine(line: string): string {
    if (!line.trim()) {
      return line;
    }

    let rendered = line;
    rendered = rendered.replace(/"([^"]+)":/g, (_match, key: string) =>
      chalk.cyan(`"${key}":`),
    );
    rendered = rendered.replace(
      /: "([^"]+)"/g,
      (_match, value: string) => `: ${chalk.green(`"${value}"`)}`,
    );
    rendered = rendered.replace(
      /: (true|false)/g,
      (_match, value: string) => `: ${chalk.magenta(value)}`,
    );
    rendered = rendered.replace(
      /: (\d+)/g,
      (_match, value: string) => `: ${chalk.yellow(value)}`,
    );

    return rendered;
  }

  /**
   * Format the call stack as a tree-like visual block.
   * @param review The AI review result
   * @returns Tree-like text block
   */
  private formatCallStackInline(review: CodeReview): string {
    const lines = this.formatTraceSectionNotes(review, true, 'call stack');
    const callStack = review.callStack;

    if (!callStack?.length) {
      lines.push(
        this.colorizeMutedLine('  (no structured call stack was returned)'),
      );
      return lines.join('\n');
    }

    lines.push(
      ...callStack.map((frame, index) => {
        const branch = index === callStack.length - 1 ? '└─' : '├─';
        return `  ${this.colorizeBranch(branch)} ${this.colorizeCallStackFrame(frame)}`;
      }),
    );

    return lines.join('\n');
  }

  /**
   * Format the call stack as plain text for markdown artifacts.
   * @param review The AI review result
   * @returns Plain-text tree-like block
   */
  private formatCallStackPlain(review: CodeReview): string {
    const lines = this.formatTraceSectionNotes(review, false, 'call stack');
    const callStack = review.callStack;

    if (!callStack?.length) {
      lines.push('  (no structured call stack was returned)');
      return lines.join('\n');
    }

    lines.push(
      ...callStack.map((frame, index) => {
        const branch = index === callStack.length - 1 ? '└─' : '├─';
        return `  ${branch} ${frame}`;
      }),
    );

    return lines.join('\n');
  }

  /**
   * Format the state transition as a JSON-like visual block.
   * @param review The AI review result
   * @returns Pretty-printed JSON block
   */
  private formatStateTransitionInline(review: CodeReview): string {
    const lines = this.formatTraceSectionNotes(
      review,
      true,
      'state transition',
    );
    const stateTransition = review.stateTransition;

    if (!stateTransition || Object.keys(stateTransition).length === 0) {
      lines.push(this.colorizeMutedLine('  {}'));
      return lines.join('\n');
    }

    lines.push(this.colorizeJsonLike(stateTransition));
    return lines.join('\n');
  }

  /**
   * Format the state transition as plain text for markdown artifacts.
   * @param review The AI review result
   * @returns Plain-text JSON-like block
   */
  private formatStateTransitionPlain(review: CodeReview): string {
    const lines = this.formatTraceSectionNotes(
      review,
      false,
      'state transition',
    );
    const stateTransition = review.stateTransition;

    if (!stateTransition || Object.keys(stateTransition).length === 0) {
      lines.push('  {}');
      return lines.join('\n');
    }

    lines.push(
      JSON.stringify(stateTransition, null, 2)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
    return lines.join('\n');
  }

  /**
   * Display review results
   */
  private displayReview(review: CodeReview, heading?: string): void {
    if (heading) {
      console.log(chalk.bold.cyan(`\n${heading}\n`));
    }

    console.log(chalk.bold('Summary:'));
    console.log(chalk.bold.cyan('  ' + review.summary));

    if (review.issues.length > 0) {
      console.log(chalk.bold('\nIssues Found:'));
      review.issues.forEach((issue: CodeIssue) => {
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

    console.log(chalk.bold('\nCall Stack:'));
    console.log(this.formatCallStackInline(review));

    console.log(chalk.bold('\nState Transition:'));
    console.log(this.formatStateTransitionInline(review));

    if (review.suggestions.length > 0) {
      console.log(chalk.bold('\nSuggestions:'));
      review.suggestions.forEach((suggestion: string) => {
        console.log(chalk.cyan(`  💡 ${suggestion}`));
      });
    } else {
      console.log(chalk.green('\n✓ No suggestions'));
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
  private formatReviewAsText(reviewedTargets: ReviewedTarget[]): string {
    let text = `Code Review Report\n`;
    text += `Context: ${reviewedTargets
      .map((target) => target.title)
      .join(', ')}\n`;
    text += `Generated: ${new Date().toISOString()}\n`;
    text += `\n${'='.repeat(70)}\n\n`;

    reviewedTargets.forEach((target, index) => {
      if (index > 0) {
        text += `\n${'='.repeat(70)}\n\n`;
      }

      text += `TARGET: ${target.title}\n`;
      text += `Context: ${target.context}\n\n`;
      text += this.formatReviewBlockText(target.review);
    });

    return text;
  }

  /**
   * Format a single review result as text.
   * @param review The AI review result
   * @returns Review block text
   */
  private formatReviewBlockText(review: CodeReview): string {
    let text = '';

    text += `SUMMARY:\n${review.summary}\n\n`;

    if (review.issues.length > 0) {
      text += `ISSUES FOUND (${review.issues.length}):\n`;
      review.issues.forEach((issue: CodeIssue, index: number) => {
        text += `\n${index + 1}. [${issue.severity.toUpperCase()}] ${issue.message}\n`;
        if (issue.file) {
          text += `   File: ${issue.file}${issue.line ? `:${issue.line}` : ''}\n`;
        }
      });
      text += '\n';
    } else {
      text += 'ISSUES: None\n\n';
    }

    text += `CALL STACK:\n${this.formatCallStackPlain(review)}\n\n`;
    text += `STATE TRANSITION:\n${this.formatStateTransitionPlain(review)}\n\n`;

    if (review.suggestions.length > 0) {
      text += `SUGGESTIONS (${review.suggestions.length}):\n`;
      review.suggestions.forEach((suggestion: string, index: number) => {
        text += `${index + 1}. ${suggestion}\n`;
      });
      text += '\n';
    } else {
      text += 'SUGGESTIONS: None\n\n';
    }

    text += `APPROVAL STATUS: ${review.approved ? 'APPROVED' : 'NOT APPROVED'}\n`;

    return text;
  }

  /**
   * Resolve the review output path.
   *
   * Filename-only outputs are treated as repo-scoped custom artifacts under
   * `~/.wf/<repo>/`, while absolute paths and explicit relative paths keep
   * their filesystem semantics.
   *
   * @param output - Raw `--output` CLI value
   * @param baseDir - Repo-aware base directory
   * @returns Absolute output path
   */
  private resolveOutputPath(output: string, baseDir: string): string {
    if (path.isAbsolute(output)) {
      return output;
    }

    if (path.dirname(output) === '.') {
      return path.join(resolveCustomArtifactDir(baseDir), output);
    }

    return path.resolve(output);
  }
}
