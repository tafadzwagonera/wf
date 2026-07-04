import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import inquirer from 'inquirer';
import { ensureWfHome } from '../shared/utils/ensure-wf-home';
import { AiService, CodeIssue, CodeReview } from '../integrations/ai/ai.service';
import { buildCodeReviewPresentation } from '../review/code-review-post-processing';
import { formatReviewCallStack, formatReviewStateTransition } from '../integrations/ai/review-trace';
import { GitService } from '../integrations/git/git.service';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { UniversalTicket } from '../common/dto/universal-ticket.dto';
import { resolveArtifactDir, resolveCustomArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import { ConversationService } from '../integrations/ai/conversation/conversation.service';
import { ConversationContext } from '../integrations/ai/conversation/interfaces';
import { deriveReviewArtifactPath } from '../shared/utils/plan-artifact';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

type OutputFormat = 'json' | 'md' | 'yaml' | 'yml';

interface IssueReviewOptions {
  format?: OutputFormat;
  force?: boolean;
  output?: string;
  dryRun?: boolean;
  comment?: boolean;
  tracker?: string;
  repos?: string[];
  criteria?: string;
  replaceCriteria?: string;
  silent?: boolean;
  sessionId?: string;
}

interface ReviewTarget {
  title: string;
  diff: string;
  context: string;
  repoDir?: string;
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
  repoDir?: string;
}

interface PullRequestDiscoveryResult {
  pullRequests: DiscoveredPullRequestTarget[];
  attemptedLookupCount: number;
  missingRepoScopeErrors: string[];
}

const ISSUE_REVIEW_EXAMPLES: CliExample[] = [
  {
    comment: 'Review current repo changes',
    command: 'wf issue:review',
  },
  {
    comment: 'Review a ticket and associated pull requests from credentialed adapters using a remote repo hint',
    command: 'yarn start issue:review WBP-3057 -r service-bookingv3',
  },
  {
    comment: 'Review a ticket and its associated pull requests across credentialed repos',
    command: 'wf issue:review WBP-2971 --tracker jira --repos service-tourv3',
  },
  {
    comment: 'Force re-review a ticket, ignoring cached artifacts',
    command: 'wf issue:review WBP-2971 --force --tracker jira -r service-bookingv3',
  },
  {
    comment: 'Review a ticket PR remotely without a local checkout; fails fast if local fallback would target cwd',
    command: 'yarn start issue:review CTRL-280 -r api-gateway-v1',
  },
  {
    comment: 'Review a pull request and post review comments with diff-aligned inline anchors',
    command: 'wf issue:review https://bitbucket.org/workspace/repo/pull-requests/160 --comment',
  },
  {
    comment:
      'Resume a provider-backed review session; CLI review sessions leave a human-readable summary as the resume tail',
    command: 'wf issue:review WBP-2971 --session-id review-session-42 -r service-bookingv3',
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
    .map(line =>
      line
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .trim()
    )
    .filter(line => line.length > 0 && !line.startsWith('#'));
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
    'AI-powered code review of local repository changes, ticket-associated pull requests, or pull request diffs with nested trace provenance, issue-local suggestions, and diff-aligned inline comment anchors. Blank or blocked AI review responses fail fast with provider-aware diagnostics instead of generic parse errors. CLI-backed review sessions also send a final human-readable summary so manual provider resume replays readable text instead of raw JSON.',
  arguments: '[source]',
  options: { isDefault: false },
})
export class IssueReviewCommand extends CommandRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly gitService: GitService,
    private readonly issueTrackerService: IssueTrackerService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly reviewStageService: ReviewStageService,
    private readonly conversationService: ConversationService
  ) {
    super();
  }

  async run(passedParams: string[], options?: IssueReviewOptions): Promise<void> {
    if (!options?.silent) {
      printExamples(ISSUE_REVIEW_EXAMPLES);
    }

    const source = passedParams[0];
    const repoInputs = options?.repos?.length ? options.repos : [];

    try {
      await ensureWfHome();

      if (options?.criteria && options?.replaceCriteria) {
        throw new Error('Cannot use --criteria and --replace-criteria together. Use one or the other.');
      }

      const extraCriteria: string[] | null = options?.replaceCriteria
        ? loadCriteriaFromFile(options.replaceCriteria)
        : options?.criteria
          ? loadCriteriaFromFile(options.criteria)
          : null;

      if (options?.dryRun) {
        const repoDirs = this.resolveLocalReviewRepoDirs(repoInputs);
        const reviewScopeLabel = source ? source : `current repo (${this.formatRepoScope(repoDirs)})`;
        this.dryRunPreview.showHeader('issue:review', reviewScopeLabel);
        const outputFormat =
          options?.format ??
          (this.configService.get<string>('stages.review.outputFormat') as OutputFormat | undefined) ??
          'md';
        const ticketAdapter =
          source && this.isTicketKey(source)
            ? options?.tracker
              ? this.issueTrackerService.getAdapter(options.tracker)
              : this.issueTrackerService.getDefaultAdapter()
            : null;
        const reviewPath =
          source && ticketAdapter
            ? this.resolveTicketReviewArtifactPath(source, repoInputs, ticketAdapter.getTrackerName())
            : undefined;
        const reviewArtifactExists = reviewPath ? fs.existsSync(reviewPath) : false;

        if (!source) {
          console.log(chalk.gray(`   Repository: ${this.formatRepoScope(repoDirs)}\n`));
        } else if (this.isTicketKey(source)) {
          if (!options?.force && reviewPath && reviewArtifactExists) {
            this.dryRunPreview.previewFileRead({
              filePath: reviewPath,
              exists: true,
              sizeInKb: (fs.statSync(reviewPath).size / 1024).toFixed(2),
            });
            this.dryRunPreview.showSkipped('artifact exists');
          }

          if (options?.force || !reviewPath || !reviewArtifactExists) {
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
              description: 'Discover associated open pull requests for the ticket',
              estimatedResponse: '200 OK — 0..n pull request URLs',
            });
          }
        } else if (this.isUrl(source)) {
          this.dryRunPreview.previewApiCall({
            method: 'GET',
            endpoint: source,
            platform: source.includes('github') ? 'GitHub' : 'Bitbucket',
            description: 'Fetch pull request diff',
            estimatedResponse: '200 OK — diff content',
          });
        } else {
          throw new Error(`Invalid source: ${source}. Expected: ticket key (ABC-123) or PR URL.`);
        }

        const shouldPreviewAiReview =
          !source ||
          this.isUrl(source) ||
          !this.isTicketKey(source) ||
          options?.force ||
          !reviewPath ||
          !reviewArtifactExists;

        if (shouldPreviewAiReview) {
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
              '  "traceProvenance": "evidence-based|best-effort|unavailable",',
              '  "callStack": [{ "frame": "...", "children": [] }],',
              '  "stateTransition": {',
              '    "from": "...",',
              '    "to": "...",',
              '    "steps": [{',
              '      "frame": "...",',
              '      "captured": { "...": "..." },',
              '      "changes": { "...": { "before": "...", "after": "..." } }',
              '    }]',
              '  },',
              '  "suggestions": ["..."]',
              '}',
            ].join('\n'),
          });
        }

        const willPostComment = Boolean(options?.comment && source);

        if (willPostComment && shouldPreviewAiReview) {
          this.dryRunPreview.previewApiCall({
            method: 'POST',
            endpoint: '<pull-request comments endpoint>',
            platform: 'Supported PR platforms',
            description: 'Post review summary as a PR comment',
            estimatedResponse: '201 Created',
          });
        }

        let fileCreatedCount = 0;
        if (source && this.isTicketKey(source) && reviewPath && shouldPreviewAiReview) {
          this.dryRunPreview.previewFileWrite({
            filePath: reviewPath,
            operation: reviewArtifactExists ? 'overwrite' : 'create',
            sizeEstimate: '2–5 KB',
            format: 'md',
            contentPreview: ['Code Review Report', 'Context: <source>', '', '## Summary', '<AI review summary>'].join(
              '\n'
            ),
          });
          fileCreatedCount++;
        }

        if (options?.output) {
          const outputPath = this.resolveOutputPath(options.output, this.resolveOutputBaseDir(source, repoInputs));
          this.dryRunPreview.previewFileWrite({
            filePath: outputPath,
            operation: 'create',
            sizeEstimate: '2–5 KB',
            format: outputFormat,
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
              'Suggestion: <paired issue suggestion>',
              '',
              '## Call Stack',
              'Provenance: code-path trace or unavailable',
              'Code-path trace: grounded in the changed code or marked unavailable.',
              '- (no structured call stack was returned)',
              '',
              '## State Transition',
              'Provenance: code-path trace or unavailable',
              'Code-path trace: grounded in the changed code or marked unavailable.',
              '(no structured state transition was returned)',
              '',
              '## Suggestions',
              '<unmatched suggestions only>',
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
          apiCallCount: shouldPreviewAiReview ? (isTicketKey ? 2 : isPrUrl ? 2 : 1) + (willPostComment ? 1 : 0) : 0,
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
            'Call Stack: code-path trace or unavailable',
            'State Transition: code-path trace or unavailable',
            '',
            'Approval Status: ✓ APPROVED',
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      const reviewTargets: ReviewTarget[] = [];
      let reviewPath: string | undefined;

      if (!source) {
        const repoDirs = this.resolveLocalReviewRepoDirs(repoInputs);
        // Mode 1: No argument - review current repo changes
        if (!options?.silent) {
          console.log(chalk.gray(`  Repository: ${this.formatRepoScope(repoDirs)}\n`));
          console.log(chalk.bold.cyan('\n🔍 Reviewing Current Repository Changes\n'));
        }
        const diff = await this.reviewRepoSet(repoDirs);
        reviewTargets.push({
          title: `Current repository changes (${this.formatRepoScope(repoDirs)})`,
          diff,
          context: this.buildRepoContext(repoDirs, 'current repository changes'),
        });
      } else if (this.isUrl(source)) {
        // Mode 2: PR URL - review GitHub/BitBucket PR
        if (!options?.silent) {
          console.log(chalk.bold.cyan(`\n🔍 Reviewing Pull Request\n`));
          console.log(chalk.gray(`  URL: ${source}\n`));
        }
        reviewTargets.push({
          title: this.formatPullRequestTitle(source),
          diff: await this.reviewPullRequest(source),
          context: `pull request: ${source}`,
          repoDir: this.resolveLocalRepoDirForReview(repoInputs),
          adapterName: this.resolveAdapterNameForPullRequestUrl(source),
          commentRef: source,
        });
      } else if (this.isTicketKey(source)) {
        // Mode 3: Ticket key - fetch ticket context, then review associated PRs or local changes
        if (!options?.silent) {
          console.log(chalk.bold.cyan(`\n🔍 Reviewing Changes for Ticket: ${source}\n`));
        }

        const ticketAdapter = options?.tracker
          ? this.issueTrackerService.getAdapter(options.tracker)
          : this.issueTrackerService.getDefaultAdapter();

        reviewPath = this.resolveTicketReviewArtifactPath(source, repoInputs, ticketAdapter.getTrackerName());
        const reviewArtifactExists = fs.existsSync(reviewPath);
        if (!options?.force && reviewArtifactExists) {
          if (!options?.silent) {
            console.log(chalk.gray(`  Review artifact exists: ${reviewPath}`));
            console.log(chalk.gray('  Use --force to regenerate.\n'));
          }

          if (options?.output) {
            const outputPath = this.resolveOutputPath(options.output, this.resolveOutputBaseDir(source, repoInputs));
            const cachedReviewOutput = fs.readFileSync(reviewPath, 'utf-8');
            fs.writeFileSync(outputPath, cachedReviewOutput);
            if (options?.silent) {
              console.log(outputPath);
            } else {
              console.log(chalk.green(`\n✓ Review saved to: ${outputPath}\n`));
            }
          }

          if (options?.silent && !options?.output) {
            console.log(reviewPath);
          }

          return;
        }

        if (options?.force && reviewArtifactExists && !options?.silent) {
          this.logger.info('Forcing recreation of review artifact...');
        }

        if (!options?.silent) {
          console.log(chalk.gray(`  Fetching ticket ${source} from ${ticketAdapter.getTrackerName()}...\n`));
        }
        const ticket = await ticketAdapter.getTicket(source);
        if (!ticket) {
          throw new Error(`Ticket lookup failed for ${source}`);
        }

        const ticketReviewContext = this.buildTicketContext(ticket);
        const discoveryResult = await this.discoverTicketPullRequests(source, repoInputs);
        const discoveredPullRequests = discoveryResult.pullRequests;

        if (
          discoveredPullRequests.length === 0 &&
          discoveryResult.attemptedLookupCount === 0 &&
          discoveryResult.missingRepoScopeErrors.length > 0 &&
          repoInputs.length === 0
        ) {
          throw new Error(
            `Pull request discovery for ticket ${source} requires a repository. Pass --repos <repo> so wf can search the correct remote repository instead of guessing from the current directory.`
          );
        }

        if (discoveredPullRequests.length > 0) {
          if (!options?.silent) {
            console.log(chalk.gray(`  Found ${discoveredPullRequests.length} open pull request(s) for ${source}\n`));
          }

          for (const pullRequest of discoveredPullRequests) {
            try {
              const diff = await this.reviewPullRequest(pullRequest.commentRef);
              reviewTargets.push({
                title: pullRequest.title,
                diff,
                context: `${ticketReviewContext}\n\n${pullRequest.context}`,
                repoDir: pullRequest.repoDir,
                adapterName: pullRequest.adapterName,
                commentRef: pullRequest.commentRef,
              });
            } catch (error: any) {
              console.log(chalk.yellow(`⚠️ Skipping ${pullRequest.title}: ${error.message}`));
            }
          }
        } else {
          const unresolvedRepoInputs = repoInputs.length > 0 ? this.findUnresolvedLocalRepoInputs(repoInputs) : [];
          if (unresolvedRepoInputs.length > 0) {
            const unresolvedRepoList = unresolvedRepoInputs.map(repo => `'${repo}'`).join(', ');
            throw new Error(
              `Repository ${unresolvedRepoList} was provided for ticket review but was not found as a local path or sibling directory. Check out the repository locally before falling back to local review.`
            );
          }

          if (!options?.silent) {
            console.log(chalk.yellow(`⚠️ No open pull requests were found for ticket ${source}`));
          }

          if (!options?.silent) {
            const fallbackDecision = await this.promptTicketFallbackAction();
            if (fallbackDecision === 'return') {
              return;
            }
          }

          const repoDirs = this.resolveLocalReviewRepoDirs(repoInputs);
          if (!options?.silent) {
            console.log(chalk.gray(`  Repository: ${this.formatRepoScope(repoDirs)}\n`));
          }
          const diff = await this.reviewRepoSet(repoDirs);
          reviewTargets.push({
            title: `Local repository changes (${this.formatRepoScope(repoDirs)})`,
            diff,
            context: `${ticketReviewContext}\n\n${this.buildRepoContext(repoDirs, 'repositories under review')}`,
            repoDir: repoDirs[0],
          });
        }
      } else {
        throw new Error(`Invalid source: ${source}. Expected: ticket key (ABC-123) or PR URL.`);
      }

      const reviewableTargets = reviewTargets.filter(target => target.diff.trim().length > 0);

      if (reviewableTargets.length === 0) {
        if (!options?.silent) {
          console.log(chalk.yellow('⚠️ No changes to review'));
          console.log(chalk.gray('Make sure you have changes to review (commits, staged, or unstaged)\n'));
        }
        return;
      }

      if (!options?.silent) {
        console.log(chalk.cyan('🤖 Analyzing changes with AI...\n'));
      }

      const reviewedTargets: ReviewedTarget[] = [];
      for (const target of reviewableTargets) {
        const review = await this.reviewStageService.reviewDiff(target.diff, {
          context: target.context,
          extraCriteria: extraCriteria ?? undefined,
          replaceCriteria: Boolean(options?.replaceCriteria),
          repoDir: target.repoDir,
          resumeProviderSessionId: options?.sessionId,
        });

        reviewedTargets.push({ ...target, review });
        if (!options?.silent) {
          this.displayReview(review, target.title);
        }

        if (options?.comment) {
          await this.postReviewComment(target, review);
        }
      }

      if (source && this.isTicketKey(source) && reviewPath && reviewedTargets.length > 0) {
        const reviewOutput = this.formatReviewOutput(reviewedTargets, 'md');
        fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
        fs.writeFileSync(reviewPath, reviewOutput);
        if (!options?.silent) {
          console.log(chalk.gray(`  Cached to: ${reviewPath}`));
        }
      }

      if (!options?.silent && this.isInteractiveSession() && reviewedTargets.length > 0) {
        const { startChat } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'startChat',
            message: 'Would you like to discuss the review?',
            prefix: ' ',
            default: false,
          },
        ]);
        if (startChat) {
          const lastReviewed = reviewedTargets[reviewedTargets.length - 1];
          const repoDir = lastReviewed.repoDir ?? process.cwd();
          await this.startInteractiveChat(lastReviewed.review, lastReviewed.context, repoDir);
        }
      }

      if (!options?.silent) {
        console.log(chalk.green('✓ Code review complete\n'));
      }

      // Save to file if requested
      if (options?.output) {
        // Output format: CLI flag > per-stage config > hardcoded default
        const outputFormat =
          options?.format ??
          (this.configService.get<string>('stages.review.outputFormat') as OutputFormat | undefined) ??
          'md';
        const outputPath = this.resolveOutputPath(options.output, this.resolveOutputBaseDir(source, repoInputs));
        const reviewOutput = this.formatReviewOutput(reviewedTargets, outputFormat);
        fs.writeFileSync(outputPath, reviewOutput);
        if (options?.silent) {
          console.log(outputPath);
        } else {
          console.log(chalk.green(`\n✓ Review saved to: ${outputPath}\n`));
        }
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
    description: 'Path to a markdown file with additional review criteria to append to the defaults',
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
    description: 'Output format (json|md|yaml|yml) - default: md',
  })
  parseFormat(format: string): OutputFormat {
    const validFormats: OutputFormat[] = ['json', 'md', 'yaml', 'yml'];
    if (!validFormats.includes(format as OutputFormat)) {
      throw new Error(`Invalid format: ${format}. Valid formats: ${validFormats.join(', ')}`);
    }
    return format as OutputFormat;
  }

  @Option({
    flags: '--force',
    description: 'Force recreate review artifacts, ignoring any cached files',
  })
  parseForce(): boolean {
    return true;
  }

  @Option({
    flags: '-o, --output <path>',
    description: 'Save review to file',
  })
  parseOutput(val: string): string {
    return val;
  }

  @Option({
    flags: '--replace-criteria <path>',
    description: 'Path to a markdown file whose criteria replace the default review guidelines entirely',
  })
  parseReplaceCriteria(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; used as remote PR-discovery hints for ticket review, and as local review roots when the repositories exist on disk',
    required: false,
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '--session-id <id>',
    description: 'Resume an AI provider session (e.g. Anthropic sess_*, Claude CLI, or Codex CLI session ID)',
  })
  parseSessionId(val: string): string {
    return val;
  }

  @Option({
    flags: '-s, --silent',
    description: 'Suppress decorative output and interactive prompts. Emits only the review artifact path for piping',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description:
      'Tracker (jira|github|bitbucket) used to resolve a ticket source; defaults to the configured primary tracker',
  })
  parseTracker(val: string): string {
    return val;
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
   * Resolve the cache artifact path for a ticket review.
   * @param source Ticket key under review
   * @param repoInputs Raw `--repos` values
   * @param trackerName Tracker namespace for cache storage
   * @returns Absolute review artifact path
   */
  private resolveTicketReviewArtifactPath(source: string, repoInputs: string[], trackerName: string): string {
    const repoBaseDir = this.resolveLocalRepoDirForReview(repoInputs) ?? process.cwd();
    const trackerDir = resolveArtifactDir(repoBaseDir, trackerName);
    const ticketPath = path.join(trackerDir, `${source}.md`);
    return deriveReviewArtifactPath(ticketPath);
  }

  /**
   * Resolve the trace provenance from AI output, defaulting to best-effort
   * when structured trace data is present but no explicit provenance exists.
   * @param review The AI review result
   * @returns Provenance label for trace sections
   */
  private resolveTraceProvenance(review: CodeReview): TraceProvenance {
    const hasStructuredTrace =
      Boolean(review.callStack?.length) || Object.keys(review.stateTransition ?? {}).length > 0;
    if (!hasStructuredTrace || review.traceProvenance === 'unavailable') {
      return 'unavailable';
    }

    if (review.executionMode === 'agent') {
      return 'evidence-based';
    }
    if (review.traceProvenance) {
      return review.traceProvenance;
    }
    return 'best-effort';
  }

  /**
   * Render a provenance note for trace sections.
   * @param review The AI review result
   * @param colorized Whether terminal colors should be applied
   * @returns Rendered provenance note block
   */
  private formatTraceProvenanceNote(review: CodeReview, colorized: boolean): string {
    const provenance = this.resolveTraceProvenance(review);
    const executionMode = review.executionMode ?? 'standard';
    const modeLine = `Execution mode: ${executionMode}`;
    const line =
      provenance === 'evidence-based'
        ? 'Provenance: evidence-based (code-path trace backed by the execution backend)'
        : provenance === 'best-effort'
          ? 'Provenance: best-effort (code-path trace inferred from the diff and AI output)'
          : 'Provenance: unavailable (no concrete code-path trace could be inferred from the diff)';
    const rendered = [`  ${modeLine}`, `  ${line}`];

    if (!colorized) {
      return rendered.join('\n');
    }

    if (provenance === 'evidence-based') {
      return `${chalk.green(`  ${modeLine}`)}\n${chalk.green(`  ${line}`)}`;
    }

    if (provenance === 'best-effort') {
      return `${chalk.yellow(`  ${modeLine}`)}\n${chalk.yellow(`  ${line}`)}`;
    }

    return `${chalk.gray(`  ${modeLine}`)}\n${chalk.gray(`  ${line}`)}`;
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
    sectionLabel: 'call stack' | 'state transition'
  ): string[] {
    const provenance = this.resolveTraceProvenance(review);
    const provenanceNote = this.formatTraceProvenanceNote(review, colorized);

    if (provenance === 'evidence-based') {
      const evidenceLine = colorized
        ? chalk.green(`  Evidence: the ${sectionLabel} section is grounded in a code-path trace from the changed code.`)
        : `  Evidence: the ${sectionLabel} section is grounded in a code-path trace from the changed code.`;

      return [provenanceNote, evidenceLine];
    }

    if (provenance === 'unavailable') {
      const unavailableLine = colorized
        ? chalk.gray(
            `  Trace unavailable: no concrete code-path trace could be inferred for the ${sectionLabel} section.`
          )
        : `  Trace unavailable: no concrete code-path trace could be inferred for the ${sectionLabel} section.`;

      return [provenanceNote, unavailableLine];
    }

    const bestEffortText =
      sectionLabel === 'call stack'
        ? 'Best effort: call stack is inferred from the changed code and AI output.'
        : 'Best effort: state transitions are inferred from the changed code and AI output.';
    const hindranceText =
      sectionLabel === 'call stack'
        ? 'Hindrance: there is no runtime execution trace backend in this path.'
        : 'Hindrance: the review pipeline does not emit a machine-verified state trace.';

    return [provenanceNote, this.formatBestEffortNote(bestEffortText, hindranceText, colorized)];
  }

  /**
   * Post the AI review as a pull request comment when the adapter supports it.
   * @param target Review target metadata
   * @param review The AI review result
   */
  private async postReviewComment(target: ReviewTarget, review: CodeReview): Promise<void> {
    const commentBody = this.formatReviewAsComment(review);
    const adapterName = target.adapterName ?? this.resolveAdapterNameForPullRequestUrl(target.commentRef ?? '');

    if (!adapterName) {
      console.log(chalk.yellow(`⚠️ --comment skipped for ${target.title}: no supported PR adapter was resolved`));
      return;
    }

    let adapter: any;
    try {
      adapter = this.issueTrackerService.getAdapter(adapterName);
    } catch (error: any) {
      console.log(chalk.yellow(`⚠️ --comment skipped for ${target.title}: ${error.message}`));
      return;
    }
    if (!adapter.createComment) {
      console.log(
        chalk.yellow(`⚠️ --comment skipped for ${target.title}: comment API is not supported by ${adapterName}`)
      );
      return;
    }

    try {
      await adapter.createComment(target.commentRef ?? target.title, commentBody);
    } catch (error: any) {
      console.log(chalk.yellow(`⚠️ --comment skipped for ${target.title}: ${error.message}`));
      return;
    }

    const inlineIssues: CodeIssue[] = (review.issues ?? []).filter(
      (issue: CodeIssue) =>
        (issue.severity === 'error' || issue.severity === 'warning') &&
        issue.file != null &&
        issue.line != null &&
        issue.line > 0
    );

    if (inlineIssues.length > 0 && adapter.createInlineComment) {
      console.log(chalk.cyan(`💬 Posting ${inlineIssues.length} inline comment(s) to ${adapterName}...\n`));

      for (const issue of inlineIssues) {
        try {
          await adapter.createInlineComment(target.commentRef ?? target.title, issue.file!, issue.line!, issue.message);
        } catch (error: any) {
          console.log(chalk.yellow(`⚠️ Inline comment skipped (${issue.file}:${issue.line}): ${error.message}`));
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
    const presentation = buildCodeReviewPresentation(review);
    const lines: string[] = ['## AI Code Review', ''];
    lines.push(`**Summary:** ${review.summary}`);
    lines.push('');
    lines.push('### Issues');

    if (presentation.issueRows.length > 0) {
      for (const row of presentation.issueRows) {
        const { issue, suggestion } = row;
        const location = issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : '';
        lines.push(`- [${issue.severity}] ${issue.message}${location}`);
        if (suggestion) {
          lines.push(`  Suggestion: ${suggestion}`);
        }
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
    if (presentation.unmatchedSuggestions.length > 0) {
      lines.push('### Suggestions');
      for (const suggestion of presentation.unmatchedSuggestions) {
        lines.push(`- ${suggestion}`);
      }
      lines.push('');
    }

    lines.push(`**Approval Status:** ${review.approved ? '✓ Approved' : '✗ Changes needed'}`);

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

      sections.push(repoDirs.length > 1 ? `## Repository: ${path.basename(repoDir)}\n\n${diff}` : diff);
    }

    return sections.join('\n\n');
  }

  /**
   * Review pull request from URL
   */
  private async reviewPullRequest(url: string): Promise<string> {
    // Determine platform from URL
    if (url.includes('github.com')) {
      const adapter = this.issueTrackerService.getAdapter('github');
      return await adapter.getPullRequestDiff!(url);
    } else if (url.includes('bitbucket.org')) {
      const adapter = this.issueTrackerService.getAdapter('bitbucket');
      return await adapter.getPullRequestDiff!(url);
    } else {
      throw new Error('Unsupported PR URL. Only GitHub and BitBucket are supported.');
    }
  }

  private buildRepoContext(repoDirs: string[], label: string): string {
    const repoDescriptions = repoDirs.map(repoDir => `${path.basename(repoDir)} (${repoDir})`).join(', ');
    return `${label}: ${repoDescriptions}`;
  }

  /**
   * Render a concise absolute repository scope for review headers.
   * @param repoDirs Resolved repository directories being reviewed
   * @returns Human-readable repository scope string
   */
  private formatRepoScope(repoDirs: string[]): string {
    return repoDirs.map(repoDir => path.resolve(repoDir)).join(', ');
  }

  /**
   * Discover all pull requests associated with a ticket across registered
   * adapters that have explicit credentials configured in wf.config.*.
   * @param ticketKey Ticket key to search for
   * @param repoInputs Raw repo arguments supplied on the command line
   * @returns Stable list of PR metadata objects
   */
  private async discoverTicketPullRequests(
    ticketKey: string,
    repoInputs: string[]
  ): Promise<PullRequestDiscoveryResult> {
    const adapters = [...this.issueTrackerService.getPullRequestDiscoveryAdapters().entries()].sort(
      ([leftName], [rightName]) => leftName.localeCompare(rightName)
    );

    const repoHints = this.resolveTicketDiscoveryRepoHints(repoInputs);

    const discovered = new Map<string, DiscoveredPullRequestTarget>();
    let attemptedLookupCount = 0;
    const missingRepoScopeErrors: string[] = [];

    for (const repoHint of repoHints) {
      for (const [adapterName, adapter] of adapters) {
        let pullRequestUrls: string[] = [];
        try {
          pullRequestUrls = await adapter.findPullRequestsByTicketKey!(ticketKey, repoHint);
        } catch (error: any) {
          if (this.isMissingPullRequestRepoScopeError(error)) {
            missingRepoScopeErrors.push(error.message);
          }
          console.log(
            chalk.yellow(
              `⚠️ PR discovery skipped for ${adapterName}${repoHint ? ` (${repoHint})` : ''}: ${error.message}`
            )
          );
          continue;
        }

        attemptedLookupCount += 1;

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
            repoDir: repoHint ? (this.resolveExistingLocalRepoDir(repoHint) ?? undefined) : undefined,
          });
        }
      }
    }

    const pullRequests = [...discovered.values()].sort((left, right) => {
      const adapterComparison = left.adapterName.localeCompare(right.adapterName);
      if (adapterComparison !== 0) {
        return adapterComparison;
      }

      const numberComparison =
        this.extractPullRequestNumber(left.commentRef) - this.extractPullRequestNumber(right.commentRef);
      if (numberComparison !== 0) {
        return numberComparison;
      }

      return left.commentRef.localeCompare(right.commentRef);
    });

    return {
      pullRequests,
      attemptedLookupCount,
      missingRepoScopeErrors,
    };
  }

  /**
   * Resolve ticket PR discovery hints.
   * Uses explicit --repos values when supplied; otherwise infers the current
   * repository name from cwd to avoid adapter calls with an undefined repo.
   * @param repoInputs Raw --repos values
   * @returns Stable repo hints for adapter discovery
   */
  private resolveTicketDiscoveryRepoHints(repoInputs: string[]): string[] {
    if (repoInputs.length > 0) {
      return repoInputs.map(repo => this.normalizeRepoHint(repo));
    }

    const fallbackRepo = this.inferCurrentRepositoryName();
    return fallbackRepo ? [fallbackRepo] : [];
  }

  /**
   * Infer the current repository name from the working directory.
   * @returns Basename of cwd, or null when unavailable
   */
  private inferCurrentRepositoryName(): string | null {
    const repoName = path.basename(process.cwd()).trim();
    return repoName.length > 0 ? repoName : null;
  }

  /**
   * Resolve a local repository directory for remote PR review context.
   * Prefers explicit --repos values and falls back to the current directory
   * only when no repo input is available.
   * @param repoInputs Raw --repos values
   * @returns Existing local repo directory or undefined
   */
  private resolveLocalRepoDirForReview(repoInputs: string[]): string | undefined {
    if (repoInputs.length > 0) {
      return this.resolveExistingLocalRepoDir(repoInputs[0]) ?? undefined;
    }

    return process.cwd();
  }

  /**
   * Detect repo-scope precondition errors from PR discovery adapters.
   * @param error Unknown adapter failure
   * @returns True when the adapter needs an explicit repository or default repo
   */
  private isMissingPullRequestRepoScopeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';

    return [
      'No BitBucket repository specified.',
      'No GitHub repository specified and no default repository configured.',
    ].some(pattern => message.includes(pattern));
  }

  /**
   * Ask the user how ticket review should proceed when no pull request is found
   * and local fallback is still valid for the selected repositories.
   * Falls back to returning without review when the session is non-interactive.
   * @returns The selected fallback action
   */
  private async promptTicketFallbackAction(): Promise<'local' | 'return'> {
    if (!this.isInteractiveSession()) {
      console.log(chalk.yellow('⚠️ Non-interactive session; returning without local review'));
      return 'return';
    }

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'decision',
        message: 'No pull request was found. What would you like to do?',
        prefix: ' ',
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
   * Launch an interactive follow-up chat about the review output.
   * @param review - The code review result
   * @param reviewContext - Context string used during the review
   * @param repoDir - Repository directory for conversation persistence
   */
  private async startInteractiveChat(review: CodeReview, reviewContext: string, repoDir: string): Promise<void> {
    const context: ConversationContext = {
      ticketKey: 'review',
      stage: 'review',
      stageOutput: review,
      repoDir,
      workflowState: {
        ticketContent: reviewContext,
        review,
      },
    };

    let conversation = await this.conversationService.loadConversation('review', repoDir);
    if (!conversation) {
      conversation = await this.conversationService.createConversation('review', context);
    }

    const systemPrompt = this.buildChatSystemPrompt(review, reviewContext);

    await this.conversationService.startChatSession(conversation.conversationId, {
      systemPrompt,
      maxTurns: 20,
      exitCommands: ['exit', 'quit', 'continue'],
      stage: 'review',
      repoDir,
    });
  }

  /**
   * Build a system prompt scoped to the review output for the interactive chat.
   * @param review - The code review result
   * @param reviewContext - Context string describing what was reviewed
   * @returns System prompt string
   */
  private buildChatSystemPrompt(review: CodeReview, reviewContext: string): string {
    const issuesText =
      review.issues.length > 0
        ? review.issues
            .map(
              issue =>
                `  [${issue.severity}] ${issue.message}${issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : ''}`
            )
            .join('\n')
        : '  No issues found';

    const suggestionsText =
      review.suggestions.length > 0 ? review.suggestions.map(s => `  - ${s}`).join('\n') : '  No suggestions';

    return `You are a code reviewer discussing your findings on the changes described below.

Review Context:
${reviewContext}

Review Verdict: ${review.approved ? 'APPROVED' : 'NEEDS WORK'}

Summary:
${review.summary}

Issues Found:
${issuesText}

Suggestions:
${suggestionsText}

Answer questions about the review, explain why specific issues were raised, suggest concrete fixes, or help the developer decide which items to address first. Reference file paths and line numbers when relevant.`;
  }

  /**
   * Normalize a repo hint so PR discovery can reuse local repo names.
   * @param repo Raw repo argument
   * @returns PR lookup hint
   */
  private normalizeRepoHint(repo: string): string {
    if (path.isAbsolute(repo) || repo.includes(path.sep) || repo.startsWith('.')) {
      return path.basename(repo);
    }

    return repo;
  }

  /**
   * Resolve repository directories for local review operations.
   * @param repoInputs Raw `--repos` values
   * @returns Existing repo directories or cwd fallback when no repo was supplied
   */
  private resolveLocalReviewRepoDirs(repoInputs: string[]): string[] {
    return repoInputs.length ? repoInputs.map(repo => resolveRepoBasePath(repo)) : [process.cwd()];
  }

  /**
   * Find repo inputs that do not resolve to a real local path.
   * @param repoInputs Raw `--repos` values
   * @returns Repo inputs that would fall back to cwd
   */
  private findUnresolvedLocalRepoInputs(repoInputs: string[]): string[] {
    return repoInputs.filter(repo => !this.canResolveRepoLocally(repo));
  }

  /**
   * Resolve the base directory used for relative output paths.
   * Ticket review prefers an existing local repo when one is available, but
   * falls back silently to cwd for remote-only review flows.
   * @param source Review source
   * @param repoInputs Raw `--repos` values
   * @returns Base directory for relative output files
   */
  private resolveOutputBaseDir(source: string | undefined, repoInputs: string[]): string {
    if (source && this.isTicketKey(source)) {
      const firstLocalRepoDir = repoInputs
        .map(repo => this.resolveExistingLocalRepoDir(repo))
        .find(repoDir => repoDir != null);
      return firstLocalRepoDir ?? process.cwd();
    }

    const repoDirs = this.resolveLocalReviewRepoDirs(repoInputs);
    return repoDirs[0] ?? process.cwd();
  }

  /**
   * Determine whether a repo input maps to an existing local directory.
   * Mirrors resolveRepoBasePath lookup without accepting cwd fallback.
   * @param repo Repository name or path
   * @returns True when the repo resolves locally
   */
  private canResolveRepoLocally(repo: string): boolean {
    return this.resolveExistingLocalRepoDir(repo) != null;
  }

  /**
   * Resolve a repo input to an existing local directory without warning.
   * @param repo Repository name or path
   * @returns Absolute local directory or null when unresolved
   */
  private resolveExistingLocalRepoDir(repo: string): string | null {
    const resolvePath = (candidate: string): string | null => {
      if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
        return candidate;
      }

      const relPath = path.resolve(process.cwd(), candidate);
      if (fs.existsSync(relPath)) {
        return relPath;
      }

      const siblingPath = path.resolve(process.cwd(), '..', candidate);
      if (fs.existsSync(siblingPath)) {
        return siblingPath;
      }

      return null;
    };

    const repoDir = resolvePath(repo);
    if (repoDir) {
      return repoDir;
    }

    const repoSegments = repo.split(/\//).filter(Boolean);
    const localRepoName = repoSegments.length > 1 ? repoSegments[1] : null;
    return localRepoName ? resolvePath(localRepoName) : null;
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
  private formatBestEffortNote(bestEffortText: string, hindranceText: string, colorized: boolean): string {
    if (!colorized) {
      return `  ${bestEffortText}\n  ${hindranceText}`;
    }

    return [chalk.yellow(`  ${bestEffortText}`), chalk.gray(`  ${hindranceText}`)].join('\n');
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
   * Apply muted formatting to a single informational line.
   * @param line Plain text line
   * @returns Muted line
   */
  private colorizeMutedLine(line: string): string {
    return chalk.gray(line);
  }

  /**
   * Colorize a structured trace line for terminal output.
   * @param line Plain text trace line
   * @returns Pretty-printed and colorized text
   */
  private colorizeTraceLine(line: string): string {
    if (!line.trim()) {
      return line;
    }

    const branchMatch = line.match(/^(\s*)(├─|└─)\s*(.*)$/);
    if (branchMatch) {
      const [, indent, branch, rest] = branchMatch;
      return `${indent}${this.colorizeBranch(branch)} ${chalk.gray(rest)}`;
    }

    const labelMatch = line.match(/^(\s*)(from|to|captured|changes):\s*(.*)$/);
    if (labelMatch) {
      const [, indent, label, rest] = labelMatch;
      return `${indent}${chalk.cyan(`${label}:`)} ${rest ? chalk.gray(rest) : ''}`.trimEnd();
    }

    const keyValueMatch = line.match(/^(\s*)(.+?)\s*=\s*(.*)$/);
    if (keyValueMatch) {
      const [, indent, key, rest] = keyValueMatch;
      return `${indent}${chalk.cyan(key)} = ${chalk.gray(rest)}`;
    }

    return chalk.gray(line);
  }

  /**
   * Format the call stack as a tree-like visual block.
   * @param review The AI review result
   * @returns Tree-like text block
   */
  private formatCallStackInline(review: CodeReview): string {
    const lines = this.formatTraceSectionNotes(review, true, 'call stack');
    const callStack = formatReviewCallStack(review.callStack);

    if (!callStack.length) {
      lines.push(this.colorizeMutedLine('  (no structured call stack was returned)'));
      return lines.join('\n');
    }

    lines.push(...callStack.map(line => `  ${this.colorizeTraceLine(line)}`));

    return lines.join('\n');
  }

  /**
   * Format the call stack as plain text for markdown artifacts.
   * @param review The AI review result
   * @returns Plain-text tree-like block
   */
  private formatCallStackPlain(review: CodeReview): string {
    const lines = this.formatTraceSectionNotes(review, false, 'call stack');
    const callStack = formatReviewCallStack(review.callStack);

    if (!callStack.length) {
      lines.push('  (no structured call stack was returned)');
      return lines.join('\n');
    }

    lines.push(...callStack.map(line => `  ${line}`));

    return lines.join('\n');
  }

  /**
   * Format the state transition as a frame-aligned visual block.
   * @param review The AI review result
   * @returns Pretty-printed trace block
   */
  private formatStateTransitionInline(review: CodeReview): string {
    const lines = this.formatTraceSectionNotes(review, true, 'state transition');
    const stateTransition = formatReviewStateTransition(review.stateTransition);

    if (!stateTransition.length) {
      lines.push(this.colorizeMutedLine('  (no structured state transition was returned)'));
      return lines.join('\n');
    }

    lines.push(...stateTransition.map(line => `  ${this.colorizeTraceLine(line)}`));
    return lines.join('\n');
  }

  /**
   * Format the state transition as plain text for markdown artifacts.
   * @param review The AI review result
   * @returns Plain-text trace block
   */
  private formatStateTransitionPlain(review: CodeReview): string {
    const lines = this.formatTraceSectionNotes(review, false, 'state transition');
    const stateTransition = formatReviewStateTransition(review.stateTransition);

    if (!stateTransition.length) {
      lines.push('  (no structured state transition was returned)');
      return lines.join('\n');
    }

    lines.push(...stateTransition.map(line => `  ${line}`));
    return lines.join('\n');
  }

  /**
   * Display review results
   */
  private displayReview(review: CodeReview, heading?: string): void {
    const presentation = buildCodeReviewPresentation(review);
    if (heading) {
      console.log(chalk.bold.cyan(`\n${heading}\n`));
    }

    console.log(chalk.bold('Summary:'));
    console.log(chalk.bold.cyan('  ' + review.summary));

    if (presentation.issueRows.length > 0) {
      console.log(chalk.bold('\nIssues Found:'));
      presentation.issueRows.forEach(row => {
        const { issue, suggestion } = row;
        const severityColor =
          issue.severity === 'error' ? chalk.red : issue.severity === 'warning' ? chalk.yellow : chalk.blue;
        console.log(severityColor(`  [${issue.severity.toUpperCase()}] ${issue.message}`));
        if (issue.file) {
          console.log(chalk.gray(`    File: ${issue.file}${issue.line ? `:${issue.line}` : ''}`));
        }
        if (suggestion) {
          console.log(chalk.cyan(`    Suggestion: ${suggestion}`));
        }
      });
    } else {
      console.log(chalk.green('\n✓ No issues found'));
    }

    console.log(chalk.bold('\nCall Stack:'));
    console.log(this.formatCallStackInline(review));

    console.log(chalk.bold('\nState Transition:'));
    console.log(this.formatStateTransitionInline(review));

    if (presentation.unmatchedSuggestions.length > 0) {
      console.log(chalk.bold('\nSuggestions:'));
      presentation.unmatchedSuggestions.forEach((suggestion: string) => {
        console.log(chalk.cyan(`  💡 ${suggestion}`));
      });
    } else {
      console.log(chalk.green('\n✓ No suggestions'));
    }

    console.log(
      chalk.bold('\nApproval Status:'),
      review.approved ? chalk.green('✓ APPROVED') : chalk.red('✗ NOT APPROVED')
    );

    if (!review.approved) {
      console.log(chalk.yellow('\n⚠️ Address the issues above before proceeding'));
    }

    console.log();
  }

  /**
   * Format review as text for file output
   */
  private formatReviewAsText(reviewedTargets: ReviewedTarget[]): string {
    let text = `Code Review Report\n`;
    text += `Context: ${reviewedTargets.map(target => target.title).join(', ')}\n`;
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
   * Format review output in the requested serialization format.
   *
   * @param reviewedTargets Reviewed targets with analysis payloads
   * @param format Requested output format
   * @returns Serialized review output
   */
  private formatReviewOutput(reviewedTargets: ReviewedTarget[], format: OutputFormat): string {
    if (format === 'json') {
      return JSON.stringify(reviewedTargets, null, 2);
    }

    if (format === 'yaml' || format === 'yml') {
      return YAML.stringify(reviewedTargets);
    }

    return this.formatReviewAsText(reviewedTargets);
  }

  /**
   * Format a single review result as text.
   * @param review The AI review result
   * @returns Review block text
   */
  private formatReviewBlockText(review: CodeReview): string {
    const presentation = buildCodeReviewPresentation(review);
    let text = '';

    text += `SUMMARY:\n${review.summary}\n\n`;

    if (presentation.issueRows.length > 0) {
      text += `ISSUES FOUND (${presentation.issueRows.length}):\n`;
      presentation.issueRows.forEach((row, index: number) => {
        const { issue, suggestion } = row;
        text += `\n${index + 1}. [${issue.severity.toUpperCase()}] ${issue.message}\n`;
        if (issue.file) {
          text += `   File: ${issue.file}${issue.line ? `:${issue.line}` : ''}\n`;
        }
        if (suggestion) {
          text += `   Suggestion: ${suggestion}\n`;
        }
      });
      text += '\n';
    } else {
      text += 'ISSUES: None\n\n';
    }

    text += `CALL STACK:\n${this.formatCallStackPlain(review)}\n\n`;
    text += `STATE TRANSITION:\n${this.formatStateTransitionPlain(review)}\n\n`;

    if (presentation.unmatchedSuggestions.length > 0) {
      text += `SUGGESTIONS (${presentation.unmatchedSuggestions.length}):\n`;
      presentation.unmatchedSuggestions.forEach((suggestion: string, index: number) => {
        text += `${index + 1}. ${suggestion}\n`;
      });
      text += '\n';
    } else if (presentation.issueRows.length === 0) {
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
