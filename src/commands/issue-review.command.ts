import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import inquirer from 'inquirer';
import { ensureWfHome } from '../shared/utils/ensure-wf-home';
import {
  AiService,
  CodeIssue,
  CodeReview,
  REVIEW_VERDICT_APPROVED,
  REVIEW_VERDICT_CHANGES_REQUESTED,
} from '../integrations/ai/ai.service';
import { buildCodeReviewPresentation } from '../review/code-review-post-processing';
import { formatReviewCallStack, formatReviewStateTransition } from '../integrations/ai/review-trace';
import { ReviewPresenter } from '../shared/presentation/review-presenter.service';
import { GitService } from '../integrations/git/git.service';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ValidationError, ExecutionError, FileSystemError, GitError, isAiProviderErrorLike } from '../shared/utils/errors';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import { UniversalTicket } from '../common/dto/universal-ticket.dto';
import { resolveArtifactDir, resolveCustomArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import { printCommandHeader } from '../shared/utils/command-header.helper';
import { ReviewStageService } from '../workflows/stages/review-stage.service';
import { ConversationService } from '../integrations/ai/conversation/conversation.service';
import { ConversationContext } from '../shared/types/conversation.types';
import { deriveReviewArtifactPath } from '../shared/utils/plan-artifact';
import { retryOnTransient } from '../shared/utils/retry-on-transient';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';
import { runSonarScanForReview } from '../review/sonar-scanner';
import { buildPreReviewContext } from '../shared/utils/build-pre-review-context';
import type { PlanArtifactFormat as OutputFormat } from '../shared/types/plan-artifact.types';

interface IssueReviewOptions {
  format?: OutputFormat;
  force?: boolean;
  output?: string;
  dryRun?: boolean;
  comment?: boolean;
  ticketKey?: string;
  tracker?: string;
  repos?: string[];
  criteria?: string;
  replaceCriteria?: string;
  silent?: boolean;
  sessionId?: string;
  sonar?: boolean;
  skipVerification?: boolean;
  estimatedComplexity?: string;
  passCount?: number;
  resumeSessionId?: string;
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
/**
 * Parse a markdown criteria file into an array of guideline strings.
 * Strips leading bullet/number markers and blank lines.
 * @param filePath Absolute or relative path to the criteria markdown file
 * @returns Array of non-empty guideline strings
 */
const loadCriteriaFromFile = (filePath: string): string[] => {
  const resolved = path.resolve(filePath);

  if (path.extname(resolved).toLowerCase() !== '.md') {
    throw new ValidationError(`Criteria file must be a Markdown (.md) file: ${filePath}`);
  }

  if (!fs.existsSync(resolved)) {
    throw new FileSystemError(`Criteria file not found: ${resolved}`);
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
    'AI-powered code review of local changes, ticket-associated pull requests, or PR diffs. '
    + 'Each review includes nested trace provenance, issue-local suggestions, and diff-aligned inline comment anchors. '
    + 'Reviews are enriched with detected repo conventions (linter, formatter, language, TypeScript config) and a verification summary; for PR-backed reviews the verification pipeline (lint, typecheck, test) runs live in a disposable git worktree, leaving the target repository untouched. Use `--skip-verification` to bypass it. '
    + 'Blank or blocked AI review responses fail fast with provider-aware diagnostics instead of generic parse errors. '
    + 'SonarScanner only runs when `stages.review.sonar` is `true` and `sonar-project.properties` exists; missing repo directory surfaces as a terminal error, while scanner execution failures are logged and review continues. '
    + 'Use `--sonar` to force SonarScanner on, overriding `stages.review.sonar` config. '
    + 'CLI-backed review sessions also send a final human-readable summary so manual provider resume replays readable text instead of raw JSON.',
  arguments: '[pr-url]',
  options: { isDefault: false },
})
export class IssueReviewCommand extends CommandRunner {
  // eslint-disable-next-line max-params
  constructor(
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly gitService: GitService,
    private readonly issueTrackerService: IssueTrackerService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly reviewStageService: ReviewStageService,
    private readonly conversationService: ConversationService,
    private readonly reviewPresenter: ReviewPresenter
  ) {
    super();
  }

  async run(passedParams: string[], options?: IssueReviewOptions): Promise<void> {
    if (!options?.silent) {
      printCommandHeader('issue:review');
    }

    const source = passedParams[0];
    const repoInputs = options?.repos?.length ? options.repos : [];

    await executeAsyncWithCatch({ fn: async () => {
      this.validateReviewInputs(source, options);
      await ensureWfHome();
      await this.executeReviewWorkflow(source, repoInputs, options);
    } });
  }

  private async executeReviewWorkflow(
    source: string | undefined, repoInputs: string[], options?: IssueReviewOptions
  ): Promise<void> {
    const criteriaPath = options?.replaceCriteria ?? options?.criteria;
    const extraCriteria: string[] | null = criteriaPath ? loadCriteriaFromFile(criteriaPath) : null;

    if (options?.dryRun) {
      return this.previewReviewDryRun(source, repoInputs, options);
    }

    await this.runLiveReview(source, repoInputs, extraCriteria, options);
  }

  private previewReviewDryRun(
    source: string | undefined, repoInputs: string[], options?: IssueReviewOptions
  ): void {
    const repoDirs = this.resolveLocalReviewRepoDirs(repoInputs);
    this.dryRunPreview.showHeader('issue:review', source || 'current repo (' + this.formatRepoScope(repoDirs) + ')');

    const ctx = this.resolveReviewDryRunContext(source, repoInputs, options);
    this.previewReviewSourceApis(source, repoDirs, ctx, options);
    if (ctx.shouldPreview) this.previewAiReviewCall();
    if (ctx.willPostComment && ctx.shouldPreview) this.previewCommentPost();
    const fileCount = this.previewReviewOutputFiles(ctx, repoInputs, options);
    this.showReviewDryRunSummary(source, ctx, fileCount, options);
  }

  private resolveReviewDryRunContext(source: string | undefined, repoInputs: string[], options?: IssueReviewOptions) {
    const ticketKey = options?.ticketKey;
    const adapter = ticketKey ? this.resolveTicketAdapter(options?.tracker) : null;
    const reviewPath = ticketKey && adapter
      ? this.resolveTicketReviewArtifactPath(ticketKey, repoInputs, adapter.getTrackerName())
      : undefined;
    const exists = reviewPath ? fs.existsSync(reviewPath) : false;
    const shouldPreview = !ticketKey || options?.force || !reviewPath || !exists;
    const willPostComment = Boolean(options?.comment && source);
    const outputFormat = options?.format
      ?? (this.configService.get<string>('stages.review.outputFormat') as OutputFormat | undefined) ?? 'md';
    return { reviewPath, exists, shouldPreview, willPostComment, outputFormat };
  }

  private previewReviewSourceApis(
    source: string | undefined, repoDirs: string[],
    ctx: ReturnType<IssueReviewCommand['resolveReviewDryRunContext']>, options?: IssueReviewOptions
  ): void {
    if (!source && !options?.ticketKey) {
      console.log(chalk.gray('   Repository: ' + this.formatRepoScope(repoDirs) + '\n'));
      return;
    }
    if (options?.ticketKey) {
      this.previewTicketReviewApis(options, ctx);
      return;
    }
    if (source && this.isUrl(source)) {
      this.dryRunPreview.previewApiCall({
        method: 'GET', endpoint: source,
        platform: source.includes('github') ? 'GitHub' : 'Bitbucket',
        description: 'Fetch pull request diff', estimatedResponse: '200 OK — diff content',
      });
    }
  }

  private previewTicketReviewApis(
    options: IssueReviewOptions,
    ctx: ReturnType<IssueReviewCommand['resolveReviewDryRunContext']>
  ): void {
    if (this.previewCachedReviewArtifact(options, ctx)) return;

    this.dryRunPreview.previewApiCall({
      method: 'GET', endpoint: '/rest/api/3/issue/' + options.ticketKey, platform: 'Jira',
      description: 'Fetch ticket details for review context',
      estimatedResponse: '200 OK — ticket title and description',
    });
    this.dryRunPreview.previewApiCall({
      method: 'GET', endpoint: '<ticket-associated pull requests>',
      platform: 'Primary platform adapters',
      description: 'Discover associated open pull requests for the ticket',
      estimatedResponse: '200 OK — 0..n pull request URLs',
    });
  }

  private previewCachedReviewArtifact(
    options: IssueReviewOptions,
    ctx: ReturnType<IssueReviewCommand['resolveReviewDryRunContext']>
  ): boolean {
    if (options?.force || !ctx.reviewPath || !ctx.exists) return false;

    this.dryRunPreview.previewFileRead({
      filePath: ctx.reviewPath, exists: true,
      sizeInKb: (fs.statSync(ctx.reviewPath).size / 1024).toFixed(2),
    });
    this.dryRunPreview.showSkipped('artifact exists');
    return true;
  }

  private previewAiReviewCall(): void {
    this.dryRunPreview.previewApiCall({
      method: 'POST', endpoint: this.aiService.getProviderEndpoint('review'), platform: this.aiService.getProviderDisplayName('review'),
      description: 'Perform AI-powered code review',
      estimatedResponse: '{\n  "summary": "<review summary>",\n  "approved": true,\n  "issues": [],\n  "suggestions": ["..."]\n}',
    });
  }

  private previewCommentPost(): void {
    this.dryRunPreview.previewApiCall({
      method: 'POST', endpoint: '<pull-request comments endpoint>',
      platform: 'Supported PR platforms',
      description: 'Post review summary as a PR comment', estimatedResponse: '201 Created',
    });
  }

  private previewReviewOutputFiles(
    ctx: ReturnType<IssueReviewCommand['resolveReviewDryRunContext']>,
    repoInputs: string[], options?: IssueReviewOptions
  ): number {
    let count = 0;
    if (options?.ticketKey && ctx.reviewPath && ctx.shouldPreview) {
      this.dryRunPreview.previewFileWrite({
        filePath: ctx.reviewPath, operation: ctx.exists ? 'overwrite' : 'create',
        sizeEstimate: '2–5 KB', format: 'md',
        contentPreview: 'Code Review Report\nContext: <source>\n\n## Summary\n<AI review summary>',
      });
      count++;
    }
    if (options?.output) {
      this.previewCustomOutputFile(options.output, ctx.outputFormat, repoInputs, !!options?.ticketKey);
      count++;
    }
    return count;
  }

  private previewCustomOutputFile(
    output: string, format: OutputFormat, repoInputs: string[], isTicketMode: boolean
  ): void {
    const baseDir = this.resolveOutputBaseDir(isTicketMode, repoInputs);
    const outPath = this.resolveOutputPath(output, baseDir);
    this.dryRunPreview.previewFileWrite({
      filePath: outPath, operation: 'create', sizeEstimate: '2–5 KB', format,
      contentPreview: 'Code Review Report\nContext: <source>\n\n## Summary\n<AI review summary>'
        + '\n\n## Approval Status\n✔ Approved',
    });
  }

  private showReviewDryRunSummary(
    source: string | undefined,
    ctx: ReturnType<IssueReviewCommand['resolveReviewDryRunContext']>,
    fileCreatedCount: number, options?: IssueReviewOptions
  ): void {
    const isPrUrl = Boolean(source && this.isUrl(source));
    this.dryRunPreview.showSummary({
      apiCallCount: ctx.shouldPreview
        ? this.estimateDryRunApiCalls(!!options?.ticketKey, isPrUrl, ctx.willPostComment)
        : 0,
      fileCreatedCount, fileModifiedCount: 0, gitOperationCount: 0,
      terminalOutputLines: [
        '✔ Code review complete', '', 'Summary: <AI-generated review summary>', '',
        '✔ No issues found', '', 'Call Stack: code-path trace or unavailable',
        'State Transition: code-path trace or unavailable', '',
        'Approval Status: ✔ ' + REVIEW_VERDICT_APPROVED,
      ],
    });
    this.dryRunPreview.showValidationResult();
  }

  private async runLiveReview(
    source: string | undefined, repoInputs: string[],
    extraCriteria: string[] | null, options?: IssueReviewOptions
  ): Promise<void> {
    const result = await this.buildReviewTargets(source, repoInputs, options);
    if (result.earlyExit) return;

    const reviewable = result.targets.filter(t => t.diff.trim().length > 0);
    if (reviewable.length === 0) {
      this.printNoChangesWarning(options);
      return;
    }
    if (!options?.silent) console.log(chalk.cyan('🤖 Analyzing changes with AI...\n'));

    const reviewed = await this.executeReviews(reviewable, extraCriteria, options);
    this.cacheReviewArtifact(result.reviewPath, reviewed, options);
    await this.offerInteractiveChat(reviewed, options);
    if (!options?.silent) console.log(chalk.green('✔ Code review complete\n'));
    this.saveReviewOutput(reviewed, repoInputs, options);
  }

  private async buildReviewTargets(
    source: string | undefined, repoInputs: string[], options?: IssueReviewOptions
  ): Promise<{ targets: ReviewTarget[]; reviewPath?: string; earlyExit?: boolean }> {
    if (!source && !options?.ticketKey) {
      return { targets: [await this.buildLocalRepoTarget(repoInputs, options)] };
    }
    if (source && this.isUrl(source)) {
      return { targets: [await this.buildPrUrlTarget(source, repoInputs, options)] };
    }
    if (options?.ticketKey) {
      return this.buildTicketReviewTargets(repoInputs, options);
    }
    throw new ValidationError(
      'Invalid source: ' + source + '. Pass a PR URL or use --ticket-key <key>.'
    );
  }

  private async buildLocalRepoTarget(
    repoInputs: string[], options?: IssueReviewOptions
  ): Promise<ReviewTarget> {
    const repoDirs = this.resolveLocalReviewRepoDirs(repoInputs);
    if (!options?.silent) {
      console.log(chalk.gray('  Repository: ' + this.formatRepoScope(repoDirs) + '\n'));
      console.log(chalk.bold.cyan('\n🔍 Reviewing Current Repository Changes\n'));
    }
    const diff = await this.reviewRepoSet(repoDirs);
    return {
      title: 'Current repository changes (' + this.formatRepoScope(repoDirs) + ')',
      diff,
      context: this.buildRepoContext(repoDirs, 'current repository changes'),
      repoDir: repoDirs[0],
    };
  }

  private async buildPrUrlTarget(
    source: string, repoInputs: string[], options?: IssueReviewOptions
  ): Promise<ReviewTarget> {
    if (!options?.silent) {
      console.log(chalk.bold.cyan('\n🔍 Reviewing Pull Request\n'));
      console.log(chalk.gray('  URL: ' + source + '\n'));
    }
    return {
      title: this.formatPullRequestTitle(source),
      diff: await this.reviewPullRequest(source),
      context: 'pull request: ' + source,
      repoDir: this.resolveLocalRepoDirForReview(repoInputs),
      adapterName: this.resolveAdapterNameForPullRequestUrl(source),
      commentRef: source,
    };
  }

  private async buildTicketReviewTargets(
    repoInputs: string[], options: IssueReviewOptions
  ): Promise<{ targets: ReviewTarget[]; reviewPath: string; earlyExit?: boolean }> {
    if (!options?.silent) {
      console.log(chalk.bold.cyan('\n🔍 Reviewing Changes for Ticket: ' + options.ticketKey + '\n'));
    }
    const adapter = this.resolveTicketAdapter(options?.tracker);
    const reviewPath = this.resolveTicketReviewArtifactPath(
      options.ticketKey || '', repoInputs, adapter.getTrackerName()
    );
    if (this.serveCachedReview(reviewPath, repoInputs, options)) {
      return { targets: [], reviewPath, earlyExit: true };
    }
    const ticket = await this.fetchTicketForReview(options.ticketKey || '', adapter, options);
    const ticketCtx = this.buildTicketContext(ticket);
    const targets = await this.collectTicketTargets(options.ticketKey || '', ticketCtx, repoInputs, options);
    if (!targets) return { targets: [], reviewPath, earlyExit: true };
    return { targets, reviewPath };
  }

  private serveCachedReview(
    reviewPath: string, repoInputs: string[], options: IssueReviewOptions
  ): boolean {
    const exists = fs.existsSync(reviewPath);
    if (options?.force || !exists) {
      if (options?.force && exists && !options?.silent) {
        this.logger.info('Forcing recreation of review artifact...');
      }
      return false;
    }
    if (!options?.silent) {
      console.log(chalk.gray('  Review artifact exists: ' + reviewPath));
      console.log(chalk.gray('  Use --force to regenerate.\n'));
    }
    this.exportCachedReview(reviewPath, repoInputs, options);
    return true;
  }

  private exportCachedReview(
    reviewPath: string, repoInputs: string[], options: IssueReviewOptions
  ): void {
    if (options?.output) {
      const baseDir = this.resolveOutputBaseDir(true, repoInputs);
      const outputPath = this.resolveOutputPath(options.output, baseDir);
      fs.writeFileSync(outputPath, fs.readFileSync(reviewPath, 'utf-8'));
      const msg = options?.silent ? outputPath : chalk.green('\n✔ Review saved to: ' + outputPath + '\n');
      console.log(msg);
      return;
    }
    if (options?.silent) console.log(reviewPath);
  }

  private async fetchTicketForReview(
    ticketKey: string, adapter: ReturnType<IssueReviewCommand['resolveTicketAdapter']>,
    options?: IssueReviewOptions
  ): Promise<UniversalTicket> {
    if (!options?.silent) {
      console.log(chalk.gray('  Fetching ticket ' + ticketKey + ' from ' + adapter.getTrackerName() + '...\n'));
    }
    const ticket = await adapter.getTicket(ticketKey);
    if (!ticket) throw new ExecutionError('Ticket lookup failed for ' + ticketKey);
    return ticket;
  }

  private async collectTicketTargets(
    ticketKey: string, ticketCtx: string, repoInputs: string[], options?: IssueReviewOptions
  ): Promise<ReviewTarget[] | null> {
    const discovery = await this.discoverTicketPullRequests(ticketKey, repoInputs);
    this.validatePrDiscovery(ticketKey, discovery, repoInputs);
    if (discovery.pullRequests.length > 0) {
      return this.reviewDiscoveredPrs(discovery.pullRequests, ticketKey, ticketCtx, options);
    }
    return this.fallbackToLocalReview(ticketKey, ticketCtx, repoInputs, options);
  }

  private validatePrDiscovery(
    ticketKey: string, discovery: PullRequestDiscoveryResult, repoInputs: string[]
  ): void {
    if (discovery.pullRequests.length > 0 || discovery.attemptedLookupCount > 0) return;
    if (discovery.missingRepoScopeErrors.length === 0 || repoInputs.length > 0) return;
    throw new ValidationError(
      'Pull request discovery for ticket ' + ticketKey + ' requires a repository.'
      + ' Pass --repos <repo> so wf can search the correct remote repository'
      + ' instead of guessing from the current directory.'
    );
  }

  private async reviewDiscoveredPrs(
    pullRequests: DiscoveredPullRequestTarget[], ticketKey: string,
    ticketCtx: string, options?: IssueReviewOptions
  ): Promise<ReviewTarget[]> {
    if (!options?.silent) {
      console.log(chalk.gray('  Found ' + pullRequests.length + ' open pull request(s) for ' + ticketKey + '\n'));
    }
    const targets: ReviewTarget[] = [];
    for (const pr of pullRequests) {
      await this.tryAddPrReviewTarget(targets, pr, ticketCtx);
    }
    return targets;
  }

  private async tryAddPrReviewTarget(
    targets: ReviewTarget[], pr: DiscoveredPullRequestTarget, ticketCtx: string
  ): Promise<void> {
    try {
      const diff = await this.reviewPullRequest(pr.commentRef);
      targets.push({
        title: pr.title, diff, context: ticketCtx + '\n\n' + pr.context,
        repoDir: pr.repoDir, adapterName: pr.adapterName, commentRef: pr.commentRef,
      });
    } catch (error: any) {
      console.log(chalk.yellow('⚠ Skipping ' + pr.title + ': ' + error.message));
    }
  }

  private async fallbackToLocalReview(
    ticketKey: string, ticketCtx: string, repoInputs: string[], options?: IssueReviewOptions
  ): Promise<ReviewTarget[] | null> {
    this.validateRepoInputsResolvable(repoInputs);
    if (!options?.silent) {
      console.log(chalk.yellow('⚠ No open pull requests were found for ticket ' + ticketKey));
      const decision = await this.promptTicketFallbackAction();
      if (decision === 'return') return null;
    }
    const repoDirs = this.resolveLocalReviewRepoDirs(repoInputs);
    if (!options?.silent) {
      console.log(chalk.gray('  Repository: ' + this.formatRepoScope(repoDirs) + '\n'));
    }
    const diff = await this.reviewRepoSet(repoDirs);
    return [{
      title: 'Local repository changes (' + this.formatRepoScope(repoDirs) + ')',
      diff, context: ticketCtx + '\n\n' + this.buildRepoContext(repoDirs, 'repositories under review'),
      repoDir: repoDirs[0],
    }];
  }

  private validateRepoInputsResolvable(repoInputs: string[]): void {
    const unresolved = repoInputs.length > 0 ? this.findUnresolvedLocalRepoInputs(repoInputs) : [];
    if (unresolved.length === 0) return;
    const list = unresolved.map(r => "'" + r + "'").join(', ');
    throw new ValidationError(
      'Repository ' + list + ' was provided for ticket review but was not found'
      + ' as a local path or sibling directory.'
      + ' Check out the repository locally before falling back to local review.'
    );
  }

  private printNoChangesWarning(options?: IssueReviewOptions): void {
    if (options?.silent) return;
    console.log(chalk.yellow('⚠ No changes to review'));
    console.log(chalk.gray('Make sure you have changes to review (commits, staged, or unstaged)\n'));
  }

  private async executeReviews(targets: ReviewTarget[],
    extraCriteria: string[] | null, options?: IssueReviewOptions): Promise<ReviewedTarget[]> {
    const reviewed: ReviewedTarget[] = [];
    for (const target of targets) {
      try {
        const review = await this.reviewSingleTarget(target, extraCriteria, options);
        reviewed.push({ ...target, review });
        if (!options?.silent) this.displayReview(review, target.title);
        if (options?.comment) await this.postReviewComment(target, review);
      } catch (error) {
        this.handleReviewParseError(error, options);
      }
    }
    return reviewed;
  }

  private async reviewSingleTarget(
    target: ReviewTarget, extraCriteria: string[] | null, options?: IssueReviewOptions
  ): Promise<CodeReview> {
    const onProgress = options?.silent ? undefined : (line: string) => console.log(chalk.gray(line));
    await this.resolveSonarOutputForTarget(target, options, onProgress);
    const context = await buildPreReviewContext(target, {
      ticketKey: options?.ticketKey,
      silent: options?.silent,
      skipVerification: options?.skipVerification,
    });
    const { review } = await this.reviewStageService.reviewDiff(target.diff, {
      context, extraCriteria: extraCriteria ?? undefined,
      replaceCriteria: Boolean(options?.replaceCriteria),
      repoDir: target.repoDir, resumeProviderSessionId: options?.sessionId, onProgress });
    return review;
  }

  private async resolveSonarOutputForTarget(
    target: ReviewTarget, options?: IssueReviewOptions, onProgress?: (line: string) => void
  ): Promise<void> {
    const configEnabled = this.configService.get<boolean>('stages.review.sonar') === true;
    if (!options?.sonar && !configEnabled) return;
    await runSonarScanForReview({ repoDir: target.repoDir, onProgress });
  }

  private handleReviewParseError(error: unknown, options?: IssueReviewOptions): void {
    if (!isAiProviderErrorLike(error) || error.category !== 'parse') throw error;
    this.logger.warn('Review target skipped — parse error: ' + (error.message ?? 'unknown'));
    if (options?.silent) return;
    console.log(chalk.yellow('\n⚠ Review JSON could not be fully validated. Dumping raw payload for manual inspection.\n'));
    console.log(error.details?.response ?? '');
  }

  private cacheReviewArtifact(
    reviewPath: string | undefined, reviewed: ReviewedTarget[], options?: IssueReviewOptions
  ): void {
    if (!options?.ticketKey || !reviewPath || reviewed.length === 0) return;
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    fs.writeFileSync(reviewPath, this.formatReviewOutput(reviewed, 'md'));
    if (!options?.silent) console.log(chalk.gray('  Cached to: ' + reviewPath));
  }

  private async offerInteractiveChat(
    reviewed: ReviewedTarget[], options?: IssueReviewOptions
  ): Promise<void> {
    if (options?.silent || !this.isInteractiveSession() || reviewed.length === 0) return;
    const { startChat } = await inquirer.prompt([{
      type: 'confirm', name: 'startChat',
      message: 'Would you like to discuss the review?', prefix: ' ', default: false,
    }]);
    if (!startChat) return;
    const last = reviewed.at(-1);
    if (!last) return;
    await this.startInteractiveChat(last.review, last.context, last.repoDir ?? process.cwd(), options?.sessionId);
  }

  private saveReviewOutput(
    reviewed: ReviewedTarget[], repoInputs: string[], options?: IssueReviewOptions
  ): void {
    if (!options?.output) return;
    const format = options?.format
      ?? (this.configService.get<string>('stages.review.outputFormat') as OutputFormat | undefined)
      ?? 'md';
    const baseDir = this.resolveOutputBaseDir(!!options?.ticketKey, repoInputs);
    const outputPath = this.resolveOutputPath(options.output, baseDir);
    fs.writeFileSync(outputPath, this.formatReviewOutput(reviewed, format));
    const msg = options?.silent ? outputPath : chalk.green('\n✔ Review saved to: ' + outputPath + '\n');
    console.log(msg);
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
    flags: '--force',
    description: 'Force recreate review artifacts, ignoring any cached files',
  })
  parseForce(): boolean {
    return true;
  }

  @Option({
    flags: '-f, --format <format>',
    description: 'Output format (json|md|yaml|yml) - default: md',
  })
  parseFormat(format: string): OutputFormat {
    const validFormats: OutputFormat[] = ['json', 'md', 'yaml', 'yml'];
    if (!validFormats.includes(format as OutputFormat)) {
      throw new ValidationError(`Invalid format: ${format}. Valid formats: ${validFormats.join(', ')}`);
    }
    return format as OutputFormat;
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
    flags: '--skip-verification',
    description: 'Skip pre-review verification (lint, typecheck, test) in the target repository',
  })
  parseSkipVerification(): boolean {
    return true;
  }

  @Option({
    flags: '--sonar',
    description: 'Enable SonarScanner static analysis, overriding stages.review.sonar config',
  })
  parseSonar(): boolean {
    return true;
  }

  @Option({
    flags: '-k, --ticket-key <key>',
    description: 'Ticket key to review (e.g. WBP-2971)',
  })
  parseTicketKey(val: string): string {
    return val;
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description:
      'Tracker (jira|github|bitbucket) used to resolve a ticket source; defaults to the configured primary tracker',
  })
  parseTracker(val: string): string {
    return val;
  }

  private validateReviewInputs(source: string | undefined, options?: IssueReviewOptions): void {
    if (source && options?.ticketKey) {
      throw new ValidationError('Provide either a PR URL or --ticket-key, not both');
    }
    if (source && fs.existsSync(source)) {
      throw new ValidationError(
        `Directory paths are not accepted as review sources. Use a PR URL or --ticket-key instead.`
      );
    }
    if (options?.criteria && options?.replaceCriteria) {
      throw new ValidationError('Cannot use --criteria and --replace-criteria together. Use one or the other.');
    }
  }

  private resolveTicketAdapter(tracker?: string) {
    return tracker ? this.issueTrackerService.getAdapter(tracker) : this.issueTrackerService.getDefaultAdapter();
  }

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
   * Post the AI review as a pull request comment when the adapter supports it.
   * @param target Review target metadata
   * @param review The AI review result
   */
  private async postReviewComment(target: ReviewTarget, review: CodeReview): Promise<void> {
    const adapter = this.resolveCommentAdapter(target);
    if (!adapter) return;

    const ref = target.commentRef ?? target.title;
    try {
      await adapter.createComment(ref, this.formatReviewAsComment(review));
    } catch (error: any) {
      console.log(chalk.yellow('⚠ --comment skipped for ' + target.title + ': ' + error.message));
      return;
    }
    await this.postInlineComments(adapter, ref, target.title, review);
  }

  private resolveCommentAdapter(target: ReviewTarget): any {
    const name = target.adapterName ?? this.resolveAdapterNameForPullRequestUrl(target.commentRef ?? '');
    if (!name) {
      console.log(chalk.yellow('⚠ --comment skipped for ' + target.title + ': no supported PR adapter was resolved'));
      return null;
    }
    try {
      const adapter = this.issueTrackerService.getAdapter(name);
      if (!adapter.createComment) {
        console.log(chalk.yellow('⚠ --comment skipped for ' + target.title + ': comment API is not supported by ' + name));
        return null;
      }
      return adapter;
    } catch (error: any) {
      console.log(chalk.yellow('⚠ --comment skipped for ' + target.title + ': ' + error.message));
      return null;
    }
  }

  private async postInlineComments(adapter: any, ref: string, title: string, review: CodeReview): Promise<void> {
    if (!adapter.createInlineComment) return;
    const issues = (review.issues ?? []).filter(
      (i: CodeIssue) => (i.severity === 'error' || i.severity === 'warning') && i.file != null && i.line != null && i.line > 0
    );
    if (issues.length === 0) return;
    console.log(chalk.cyan('💬 Posting ' + issues.length + ' inline comment(s) to ' + title + '...\n'));
    for (const issue of issues) {
      try {
        await adapter.createInlineComment(ref, issue.file || '', issue.line || 0, issue.message);
      } catch (error: any) {
        console.log(chalk.yellow('⚠ Inline comment skipped (' + issue.file + ':' + issue.line + '): ' + error.message));
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
    const verdict = review.approved
      ? '✔ ' + REVIEW_VERDICT_APPROVED
      : '✗ ' + REVIEW_VERDICT_CHANGES_REQUESTED;
    const lines: string[] = [
      '## AI Code Review', '',
      '**Summary:** ' + review.summary, '',
      '### Issues', ...this.formatCommentIssueRows(presentation.issueRows), '',
      '### Call Stack', this.formatCallStackPlain(review), '',
      '### State Transition', this.formatStateTransitionPlain(review), '',
      ...this.formatUnmatchedSuggestions(presentation.unmatchedSuggestions),
      '**Approval Status:** ' + verdict,
    ];
    return lines.join('\n');
  }

  private formatCommentIssueRows(rows: ReturnType<typeof buildCodeReviewPresentation>['issueRows']): string[] {
    if (rows.length === 0) return ['- None'];
    const lines: string[] = [];
    for (const { issue, suggestion } of rows) {
      const lineRef = issue.line ? ':' + issue.line : '';
      const loc = issue.file ? ' (' + issue.file + lineRef + ')' : '';
      lines.push('- [' + issue.severity + '] ' + issue.message + loc);
      if (suggestion) lines.push('  Suggestion: ' + suggestion);
    }
    return lines;
  }

  private formatUnmatchedSuggestions(suggestions: string[]): string[] {
    if (suggestions.length === 0) return [];
    return ['### Suggestions', ...suggestions.map(s => '- ' + s), ''];
  }

  /**
   * Review current repository changes
   */
  private async reviewCurrentRepo(repoDir: string): Promise<string> {
    const isRepo = await this.gitService.isGitRepository(repoDir);
    if (!isRepo) {
      throw new GitError(`Not a git repository: ${repoDir}`);
    }

    let diff = await this.gitService.getDiff(true, repoDir);
    if (!diff || diff.trim().length === 0) {
      diff = await this.gitService.getDiff(false, repoDir);
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
    const adapterName = this.resolveAdapterNameForPullRequestUrl(url);
    if (!adapterName) {
      throw new ValidationError('Unsupported PR URL. Only GitHub and BitBucket are supported.');
    }

    const adapter = this.issueTrackerService.getAdapter(adapterName);
    if (!adapter.getPullRequestDiff) {
      throw new ValidationError(`${adapterName} does not support retrieving PR diffs`);
    }
    return await adapter.getPullRequestDiff(url);
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
    ticketKey: string, repoInputs: string[]
  ): Promise<PullRequestDiscoveryResult> {
    const adapters = [...this.issueTrackerService.getPullRequestDiscoveryAdapters().entries()]
      .sort(([a], [b]) => a.localeCompare(b));
    const repoHints = this.resolveTicketDiscoveryRepoHints(repoInputs);
    const discovered = new Map<string, DiscoveredPullRequestTarget>();
    let attemptedLookupCount = 0;
    const missingRepoScopeErrors: string[] = [];

    for (const repoHint of repoHints) {
      for (const [adapterName, adapter] of adapters) {
        const result = await this.probeAdapterForPrs(adapter, adapterName, ticketKey, repoHint, missingRepoScopeErrors);
        if (!result) continue;
        attemptedLookupCount += 1;
        this.registerDiscoveredPrs(result, adapterName, repoHint, discovered);
      }
    }
    return { pullRequests: this.sortDiscoveredPrs(discovered), attemptedLookupCount, missingRepoScopeErrors };
  }

  private async probeAdapterForPrs(
    adapter: any, adapterName: string, ticketKey: string,
    repoHint: string, missingRepoScopeErrors: string[]
  ): Promise<string[] | null> {
    const scope = repoHint ? ' (' + repoHint + ')' : '';
    if (!adapter.findPullRequestsByTicketKey) {
      return null;
    }
    try {
      return await retryOnTransient(
        () => adapter.findPullRequestsByTicketKey(ticketKey, repoHint),
        { onRetry: error => this.logTransientError(error, adapterName, scope) },
      );
    } catch (error: unknown) {
      this.handlePrDiscoveryError(error, adapterName, scope, missingRepoScopeErrors);
      return null;
    }
  }

  private logTransientError(error: any, adapterName: string, scope: string): void {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.dim('⚠ Transient error for ' + adapterName + scope + ': ' + message + ' — retrying in 1s'));
  }

  private handlePrDiscoveryError(
    error: unknown, adapterName: string, scope: string, missingRepoScopeErrors: string[]
  ): void {
    if (this.isMissingPullRequestRepoScopeError(error)) missingRepoScopeErrors.push((error as Error).message);
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow('⚠ PR discovery skipped for ' + adapterName + scope + ': ' + message));
  }

  private registerDiscoveredPrs(
    urls: string[], adapterName: string, repoHint: string,
    discovered: Map<string, DiscoveredPullRequestTarget>
  ): void {
    const repoDir = repoHint ? (this.resolveExistingLocalRepoDir(repoHint) ?? undefined) : undefined;
    for (const url of urls) {
      const key = adapterName + ':' + url;
      if (discovered.has(key)) continue;
      discovered.set(key, {
        adapterName, commentRef: url,
        title: this.formatPullRequestTitle(url), context: 'pull request: ' + url, repoDir,
      });
    }
  }

  private sortDiscoveredPrs(discovered: Map<string, DiscoveredPullRequestTarget>): DiscoveredPullRequestTarget[] {
    return [...discovered.values()].sort((a, b) => {
      const byAdapter = a.adapterName.localeCompare(b.adapterName);
      if (byAdapter !== 0) return byAdapter;
      const byNumber = this.extractPullRequestNumber(a.commentRef) - this.extractPullRequestNumber(b.commentRef);
      if (byNumber !== 0) return byNumber;
      return a.commentRef.localeCompare(b.commentRef);
    });
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
    let message = '';
    if (error instanceof Error) message = error.message;
    if (typeof error === 'string') message = error;

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
      console.log(chalk.yellow('⚠ Non-interactive session; returning without local review'));
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
   * @param resumeProviderSessionId - Provider session ID to resume, if available
   */
  private async startInteractiveChat(
    review: CodeReview, reviewContext: string, repoDir: string, resumeProviderSessionId?: string
  ): Promise<void> {
    const context = this.buildChatConversationContext(review, reviewContext, repoDir);
    const conversation = await this.conversationService.loadConversation('review', repoDir)
      ?? await this.conversationService.createConversation('review', context);
    await this.conversationService.startChatSession(conversation.conversationId, {
      systemPrompt: this.buildChatSystemPrompt(review, reviewContext),
      maxTurns: 20, exitCommands: ['exit', 'quit', 'continue'],
      stage: 'review', repoDir,
      resumeProviderSessionId,
    });
  }

  private buildChatConversationContext(
    review: CodeReview, reviewContext: string, repoDir: string
  ): ConversationContext {
    return {
      ticketKey: 'review', stage: 'review', stageOutput: review, repoDir,
      workflowState: { ticketContent: reviewContext, review },
    };
  }

  /**
   * Build a system prompt scoped to the review output for the interactive chat.
   * @param review - The code review result
   * @param reviewContext - Context string describing what was reviewed
   * @returns System prompt string
   */
  private buildChatSystemPrompt(review: CodeReview, reviewContext: string): string {
    const verdict = review.approved ? REVIEW_VERDICT_APPROVED : REVIEW_VERDICT_CHANGES_REQUESTED;
    return [
      'You are a code reviewer discussing your findings on the changes described below.',
      '', 'Review Context:', reviewContext,
      '', 'Review Verdict: ' + verdict,
      '', 'Summary:', review.summary,
      '', 'Issues Found:', this.formatChatIssueLines(review.issues),
      '', 'Suggestions:', this.formatChatSuggestionLines(review.suggestions),
      '', 'Answer questions about the review, explain why specific issues were raised, suggest concrete fixes,',
      'or help the developer decide which items to address first. Reference file paths and line numbers when relevant.',
      '', 'Before flagging a naming, structural, or convention issue, check whether the pattern you\'re recommending',
      'actually exists in the codebase by reading the relevant files listed in the repository conventions.',
      'Do not assert that something diverges from an established pattern if you have only read the diff.',
    ].join('\n');
  }

  private formatChatIssueLines(issues: CodeIssue[]): string {
    if (issues.length === 0) return '  No issues found';
    return issues.map(i => {
      const lineRef = i.line ? ':' + i.line : '';
      const loc = i.file ? ' (' + i.file + lineRef + ')' : '';
      return '  [' + i.severity + '] ' + i.message + loc;
    }).join('\n');
  }

  private formatChatSuggestionLines(suggestions: string[]): string {
    if (suggestions.length === 0) return '  No suggestions';
    return suggestions.map(s => '  - ' + s).join('\n');
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
   * @param isTicketKeyMode Whether the review targets a ticket key
   * @param repoInputs Raw `--repos` values
   * @returns Base directory for relative output files
   */
  private resolveOutputBaseDir(isTicketKeyMode: boolean, repoInputs: string[]): string {
    if (isTicketKeyMode) {
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
    const resolved = this.resolveLocalPath(repo);
    if (resolved) return resolved;

    const segments = repo.split(/\//).filter(Boolean);
    const localName = segments.length > 1 ? segments[1] : null;
    return localName ? this.resolveLocalPath(localName) : null;
  }

  private resolveLocalPath(candidate: string): string | null {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;

    const relPath = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(relPath)) return relPath;

    const siblingPath = path.resolve(process.cwd(), '..', candidate);
    if (fs.existsSync(siblingPath)) return siblingPath;

    return null;
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
    const match = new RegExp(/\/pull\/(\d+)|\/pull-requests\/(\d+)/).exec(url);
    const value = match?.[1] ?? match?.[2];
    return value ? Number.parseInt(value, 10) : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Check if string is a URL
   */
  private isUrl(str: string): boolean {
    return str.startsWith('http://') || str.startsWith('https://');
  }

  /**
   * Estimate the number of API calls for a dry-run review preview.
   */
  private estimateDryRunApiCalls(isTicketKeyMode: boolean, isPrUrl: boolean, willPostComment: boolean): number {
    let count = 1;
    if (isTicketKeyMode || isPrUrl) count = 2;
    if (willPostComment) count++;
    return count;
  }

  /**
   * Format the call stack as plain text for markdown artifacts.
   * @param review The AI review result
   * @returns Plain-text tree-like block
   */
  private formatCallStackPlain(review: CodeReview): string {
    const lines = [...this.reviewPresenter.formatTraceSectionNotes(review, false, 'call stack')];
    const callStack = formatReviewCallStack(review.callStack);

    if (!callStack.length) {
      lines.push('  (no structured call stack was returned)');
      return lines.join('\n');
    }

    lines.push(...callStack.map(line => `  ${line}`));

    return lines.join('\n');
  }

  /**
   * Format the state transition as plain text for markdown artifacts.
   * @param review The AI review result
   * @returns Plain-text trace block
   */
  private formatStateTransitionPlain(review: CodeReview): string {
    const lines = [...this.reviewPresenter.formatTraceSectionNotes(review, false, 'state transition')];
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
   * @param review The AI review result
   * @param heading Optional heading to print before the review
   */
  private displayReview(review: CodeReview, heading?: string): void {
    if (heading) console.log(chalk.bold.cyan('\n' + heading + '\n'));
    this.reviewPresenter.displayReview(review);
  }

  /**
   * Format review as text for file output
   */
  private formatReviewAsText(reviewedTargets: ReviewedTarget[]): string {
    let text = `Code Review Report\n`;
    text += `Context: ${reviewedTargets.map(target => target.title).join(', ')}\n`;
    text += `Generated: ${new Date().toISOString()}\n`;
    text += `\n${'='.repeat(70)}\n\n`;

    for (const [index, target] of reviewedTargets.entries()) {
      if (index > 0) {
        text += `\n${'='.repeat(70)}\n\n`;
      }

      text += `TARGET: ${target.title}\n`;
      text += `Context: ${target.context}\n\n`;
      text += this.formatReviewBlockText(target.review);
    }

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
    const verdict = review.approved ? REVIEW_VERDICT_APPROVED : REVIEW_VERDICT_CHANGES_REQUESTED;
    return [
      'SUMMARY:\n' + review.summary, '',
      this.formatBlockIssues(presentation.issueRows),
      'CALL STACK:\n' + this.formatCallStackPlain(review), '',
      'STATE TRANSITION:\n' + this.formatStateTransitionPlain(review), '',
      this.formatBlockSuggestions(presentation.unmatchedSuggestions, presentation.issueRows.length),
      'APPROVAL STATUS: ' + verdict,
    ].filter(Boolean).join('\n') + '\n';
  }

  private formatBlockIssues(rows: ReturnType<typeof buildCodeReviewPresentation>['issueRows']): string {
    if (rows.length === 0) return 'ISSUES: None\n';
    const lines = ['ISSUES FOUND (' + rows.length + '):'];
    for (const [i, { issue, suggestion }] of rows.entries()) {
      const lineRef = issue.line ? ':' + issue.line : '';
      lines.push('', (i + 1) + '. [' + issue.severity + '] ' + issue.message);
      if (issue.file) lines.push('   File: ' + issue.file + lineRef);
      if (suggestion) lines.push('   Suggestion: ' + suggestion);
    }
    return lines.join('\n') + '\n';
  }

  private formatBlockSuggestions(suggestions: string[], issueCount: number): string {
    if (suggestions.length === 0) return issueCount === 0 ? 'SUGGESTIONS: None\n' : '';
    const items = suggestions.map((s, i) => (i + 1) + '. ' + s).join('\n');
    return 'SUGGESTIONS (' + suggestions.length + '):\n' + items + '\n';
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
