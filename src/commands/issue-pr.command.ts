import { Command, CommandRunner, Option } from 'nest-commander';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { AiService } from '../integrations/ai/ai.service';
import { GitService } from '../integrations/git/git.service';
import { IssueTrackerFeature } from '../integrations/issue-trackers/issue-tracker-adapter.interface';
import { ErrorHandler } from '../shared/utils/error-handler';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

interface IssuePrOptions {
  action?: string;
  base?: string;
  dryRun?: boolean;
  tracker?: string;
  repos?: string[];
  silent?: boolean;
  title?: string;
}

const ISSUE_PR_EXAMPLES: CliExample[] = [
  {
    comment: 'Create a PR from a fix plan',
    command: 'wf issue:pr WBP-2971 --action fix',
  },
  {
    comment: 'Dry-run to preview PR title and body',
    command: 'wf issue:pr WBP-2971 --dry-run',
  },
];

const warnOnIgnoredRepos = (repos?: string[]): void => {
  if ((repos?.length ?? 0) > 1) {
    console.log(
      chalk.yellow(`⚠️ Only the first repository will be used for issue:pr. Ignoring: ${repos!.slice(1).join(', ')}`)
    );
  }
};

const VALID_ACTIONS = ['feature', 'fix', 'investigate'] as const;

/**
 * Command to create a pull request from a plan artifact.
 * Reads the plan JSON, builds a PR title and body, then calls the tracker adapter.
 */
@Command({
  name: 'issue:pr',
  description: 'Create a pull request from a plan artifact (auto-detects ticket from branch)',
  arguments: '[ticket-key]',
  options: { isDefault: false },
})
export class IssuePrCommand extends CommandRunner {
  constructor(
    private readonly issueTrackerService: IssueTrackerService,
    private readonly aiService: AiService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly gitService: GitService,
    private readonly configService: ConfigService
  ) {
    super();
  }

  async run(passedParams: string[], options?: IssuePrOptions): Promise<void> {
    if (!options?.silent) {
      printExamples(ISSUE_PR_EXAMPLES);
    }

    try {
      if (!options?.silent) {
        warnOnIgnoredRepos(options?.repos);
      }

      // Resolve ticket key from param or current branch
      let ticketKey: string | null = passedParams[0] || null;

      if (!ticketKey) {
        ticketKey = await this.detectTicketFromBranch();
      }

      if (options?.dryRun) {
        this.dryRunPreview.showHeader('issue:pr', ticketKey ?? undefined);
        console.log(
          chalk.gray(
            `   Would create PR for ticket: ${ticketKey ?? '<unknown>'}` + `  |  base: ${options?.base ?? 'main'}\n`
          )
        );
        this.dryRunPreview.showSummary({
          apiCallCount: 1,
          fileCreatedCount: 0,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          terminalOutputLines: ['PR URL: <would be printed here>'],
        });
        this.dryRunPreview.showValidationResult();
        return;
      }

      if (!ticketKey) {
        console.error(
          chalk.red('Error: Could not determine ticket key. Pass it as an argument or run from a ticket branch.')
        );
        process.exit(1);
      }

      const trackerName = options?.tracker || this.configService.get<string>('tracker') || 'github';

      const adapter = this.issueTrackerService.getAdapter(trackerName);

      if (!adapter.supports(IssueTrackerFeature.CREATE_PULL_REQUEST)) {
        console.error(chalk.red(`Error: PR creation is not supported for platform '${trackerName}'.`));
        console.log(chalk.gray('Supported trackers: github'));
        process.exit(1);
      }

      // Locate plan artifact
      const repoBaseDir = resolveRepoBasePath(options?.repos?.[0]);
      const trackerDir = resolveArtifactDir(repoBaseDir, trackerName);

      const planPath = this.findPlanArtifact(trackerDir, ticketKey, options?.action);

      if (!planPath) {
        console.error(chalk.red(`Error: No plan artifact found for ticket '${ticketKey}' under ${trackerDir}.`));
        console.log(chalk.gray(`Run 'wf issue:plan ${ticketKey} --action <feature|fix|investigate>' first.`));
        process.exit(1);
      }

      // Parse plan artifact
      const planContent = fs.readFileSync(planPath, 'utf-8');
      const plan = JSON.parse(planContent) as {
        summary?: string;
        action?: string;
        steps?: string[];
      };

      // Resolve source branch
      let head: string;
      try {
        const branchInfo = await this.gitService.getBranchInfo();
        head = branchInfo.current;
      } catch {
        head = ticketKey.toLowerCase();
      }

      const base = options?.base ?? 'main';

      const title = options?.title ? options.title : `[${ticketKey}] ${plan.summary ?? ticketKey}`;

      const body = this.buildPrBody(ticketKey, plan, planPath);

      const repo = options?.repos?.[0];

      if (!options?.silent) {
        console.log(chalk.bold.cyan('\n🔀 Creating Pull Request\n'));
        console.log(chalk.gray(`  Ticket : ${ticketKey}`));
        console.log(chalk.gray(`  Head   : ${head}`));
        console.log(chalk.gray(`  Base   : ${base}`));
        console.log(chalk.gray(`  Title  : ${title}\n`));
      }

      const prUrl = await adapter.createPullRequest!({
        title,
        body,
        head,
        base,
        repo,
      });

      if (options?.silent) {
        console.log(prUrl);
      } else {
        console.log(chalk.bold.cyan(`\n✅ Pull request created: ${prUrl}\n`));
      }
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
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
    const candidates: string[] = action ? [action, ...VALID_ACTIONS.filter(a => a !== action)] : [...VALID_ACTIONS];

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
    const lines: string[] = [];

    lines.push(`## ${ticketKey}`);
    lines.push('');

    if (plan.summary) {
      lines.push(plan.summary);
      lines.push('');
    }

    if (plan.action) {
      lines.push(`**Type:** ${plan.action}`);
      lines.push('');
    }

    if (plan.steps?.length) {
      lines.push('## Implementation steps');
      lines.push('');
      for (const step of plan.steps) {
        lines.push(`- ${step}`);
      }
      lines.push('');
    }

    lines.push(`---\n*Generated from plan artifact: \`${path.basename(planPath)}\`*`);

    return lines.join('\n');
  }

  /**
   * Detect ticket key from current branch name.
   * Supports formats like: feature/WBP-2971-description, WBP-2971, etc.
   *
   * @returns Ticket key in uppercase, or null if not found
   */
  private async detectTicketFromBranch(): Promise<string | null> {
    try {
      const branchInfo = await this.gitService.getBranchInfo();
      const match = branchInfo.current.match(/([A-Z]+-\d+)/i);
      return match ? match[1].toUpperCase() : null;
    } catch {
      return null;
    }
  }
}
