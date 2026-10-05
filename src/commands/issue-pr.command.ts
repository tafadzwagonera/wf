import { Command, CommandRunner, Option } from 'nest-commander';
import { ConfigService } from '@nestjs/config';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { GitService } from '../integrations/git/git.service';
import { IssueTrackerFeature } from '../integrations/issue-trackers/issue-tracker-adapter.interface';
import { ValidationError, FileSystemError } from '../shared/utils/errors';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import { printCommandHeader } from '../shared/utils/command-header.helper';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface IssuePrOptions {
  action?: string;
  base?: string;
  dryRun?: boolean;
  tracker?: string;
  repos?: string[];
  silent?: boolean;
  title?: string;
}
const warnOnIgnoredRepos = (repos?: string[]): void => {
  if ((repos?.length ?? 0) > 1) {
    console.log(
      chalk.yellow(`⚠ Only the first repository will be used for issue:pr. Ignoring: ${(repos ?? []).slice(1).join(', ')}`)
    );
  }
};

const validActions = ['feature', 'fix', 'investigate'] as const;

/**
 * Command to create a pull request from a plan artifact.
 * Reads the plan JSON, builds a PR title and body, then calls the tracker adapter.
 */
@Command({
  name: 'issue:pr',
  description: 'Create a pull request from a plan artifact (auto-detects ticket from branch).',
  arguments: '[ticket-key]',
  options: { isDefault: false },
})
export class IssuePrCommand extends CommandRunner {
  constructor(
    private readonly issueTrackerService: IssueTrackerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly gitService: GitService,
    private readonly configService: ConfigService
  ) {
    super();
  }

  async run(passedParams: string[], options?: IssuePrOptions): Promise<void> {
    if (!options?.silent) {
      printCommandHeader('issue:pr');
      warnOnIgnoredRepos(options?.repos);
    }

    await executeAsyncWithCatch({ fn: async () => {
      const ticketKey = passedParams[0] || await this.detectTicketFromBranch();

      if (options?.dryRun) return this.previewDryRun(ticketKey, options);

      await this.createPullRequest(ticketKey, options);
    } });
  }

  private previewDryRun(ticketKey: string | null, options?: IssuePrOptions): void {
    this.dryRunPreview.showHeader('issue:pr', ticketKey ?? undefined);
    console.log(chalk.gray(`   Would create PR for ticket: ${ticketKey ?? '<unknown>'}  |  base: ${options?.base ?? 'main'}\n`));
    this.dryRunPreview.showSummary({
      apiCallCount: 1, fileCreatedCount: 0, fileModifiedCount: 0, gitOperationCount: 0,
      terminalOutputLines: ['PR URL: <would be printed here>'],
    });
    this.dryRunPreview.showValidationResult();
  }

  private async createPullRequest(ticketKey: string | null, options?: IssuePrOptions): Promise<void> {
    if (!ticketKey) {
      throw new ValidationError('Could not determine ticket key. Pass it as an argument or run from a ticket branch.');
    }

    const { adapter, trackerDir } = this.resolveTrackerContext(options);
    const { plan, planPath } = this.loadPlan(trackerDir, ticketKey, options?.action);
    const prParams = await this.buildPrParams(ticketKey, plan, planPath, options);

    if (!options?.silent) this.printPrHeader(ticketKey, prParams.head, prParams.base, prParams.title);

    if (!adapter.createPullRequest) {
      throw new ValidationError('The active tracker adapter does not support pull request creation.');
    }
    const prUrl = await adapter.createPullRequest(prParams);
    console.log(options?.silent ? prUrl : chalk.bold.cyan(`\n✔ Pull request created: ${prUrl}\n`));
  }

  private async buildPrParams(ticketKey: string, plan: any, planPath: string, options?: IssuePrOptions) {
    const branchInfo = await this.gitService.getBranchInfo().catch(() => null);
    return {
      head: branchInfo?.current ?? ticketKey.toLowerCase(),
      base: options?.base ?? 'main',
      title: options?.title ?? `[${ticketKey}] ${plan.summary ?? ticketKey}`,
      body: this.buildPrBody(ticketKey, plan, planPath),
      repo: options?.repos?.[0],
    };
  }

  private resolveTrackerContext(options?: IssuePrOptions) {
    const trackerName = options?.tracker || this.configService.get<string>('tracker') || 'github';
    const adapter = this.issueTrackerService.getAdapter(trackerName);
    if (!adapter.supports(IssueTrackerFeature.CREATE_PULL_REQUEST)) {
      throw new ValidationError(`PR creation is not supported for platform '${trackerName}'. Supported trackers: github`);
    }
    const repoBaseDir = resolveRepoBasePath(options?.repos?.[0]);
    const trackerDir = resolveArtifactDir(repoBaseDir, trackerName);
    return { adapter, trackerDir };
  }

  private loadPlan(trackerDir: string, ticketKey: string, action?: string) {
    const planPath = this.findPlanArtifact(trackerDir, ticketKey, action);
    if (!planPath) {
      throw new FileSystemError(
        `No plan artifact found for ticket '${ticketKey}' under ${trackerDir}.\n`
        + `Run 'wf issue:plan ${ticketKey} --action <feature|fix|investigate>' first.`
      );
    }
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as { summary?: string; action?: string; steps?: string[] };
    return { plan, planPath };
  }

  private printPrHeader(ticketKey: string, head: string, base: string, title: string): void {
    console.log(chalk.bold.cyan('\n🔀 Creating Pull Request\n'));
    console.log(chalk.gray(`  Ticket : ${ticketKey}`));
    console.log(chalk.gray(`  Head   : ${head}`));
    console.log(chalk.gray(`  Base   : ${base}`));
    console.log(chalk.gray(`  Title  : ${title}\n`));
  }

  @Option({
    flags: '-a, --action <action>',
    description: 'Resolution action type (feature|fix|investigate)',
  })
  parseAction(val: string): string {
    return val;
  }

  @Option({
    flags: '-b, --base <base>',
    description: 'Target branch for the PR (default: main)',
  })
  parseBase(val: string): string {
    return val;
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the PR creation without making changes',
  })
  parseDryRun(): boolean {
    return true;
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
    flags: '-s, --silent',
    description: 'Suppress decorative output and interactive prompts. Emits only the PR URL for piping',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '-t, --title <title>',
    description: 'Override the PR title',
  })
  parseTitle(val: string): string {
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
   * Find a plan artifact on disk for the given ticket key.
   * If action is provided, looks for that specific variant first.
   * Otherwise tries all valid action types.
   *
   * @param trackerDir - Directory containing artifacts
   * @param ticketKey - Ticket identifier (e.g. "WBP-2971")
   * @param action - Optional action type to narrow the search
   * @returns Absolute path to the plan file, or null if not found
   */
  private findPlanArtifact(trackerDir: string, ticketKey: string, action?: string): string | null {
    const candidates: string[] = action ? [action, ...validActions.filter(a => a !== action)] : [...validActions];

    for (const a of candidates) {
      const candidate = path.join(trackerDir, `${ticketKey}-plan-${a}.json`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Build markdown PR body from plan artifact content.
   *
   * @param ticketKey - Ticket identifier
   * @param plan - Parsed plan object
   * @param planPath - Path to the plan file (used for attribution)
   * @returns Markdown string suitable as a PR body
   */
  private buildPrBody(
    ticketKey: string,
    plan: { summary?: string; action?: string; steps?: string[] },
    planPath: string
  ): string {
    const lines: string[] = ['## ' + ticketKey, ''];

    if (plan.summary) lines.push(plan.summary, '');
    if (plan.action) lines.push('**Type:** ' + plan.action, '');

    if (plan.steps?.length) {
      lines.push('## Implementation steps', '', ...plan.steps.map(s => '- ' + s), '');
    }

    lines.push('---\n*Generated from plan artifact: `' + path.basename(planPath) + '`*');
    return lines.join('\n');
  }

  /**
   * Detect ticket key from current branch name.
   * Supports formats like: feature/WBP-2971-description, WBP-2971, etc.
   *
   * @returns Ticket key in uppercase, or null if not found
   */
  private async detectTicketFromBranch(): Promise<string | null> {
    const branchInfo = await this.gitService.getBranchInfo().catch(() => null);
    if (!branchInfo) return null;

    const match = new RegExp(/([A-Z]+-\d+)/i).exec(branchInfo.current);
    return match ? match[1].toUpperCase() : null;
  }
}
