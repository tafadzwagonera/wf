import { Command, CommandRunner, Option } from 'nest-commander';
import { ConversationService } from '../integrations/ai/conversation/conversation.service';
import {
  ConversationContext,
  WorkflowStage as ConvWorkflowStage,
} from '../integrations/ai/conversation/interfaces';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ErrorHandler } from '../shared/utils/error-handler';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import {
  TicketArtifact,
  PlanArtifact,
  ReviewArtifact,
  ResolutionAction,
  ImplementerResult,
} from '../agents/interfaces';

enum WorkflowStage {
  FETCH = 'fetch',
  PLAN = 'plan',
  IMPLEMENT = 'implement',
  REVIEW = 'review',
  COMMIT = 'commit',
}

const STAGE_ORDER = [
  WorkflowStage.FETCH,
  WorkflowStage.PLAN,
  WorkflowStage.IMPLEMENT,
  WorkflowStage.REVIEW,
  WorkflowStage.COMMIT,
];

interface IssueAllOptions {
  from: string;
  to?: string;
  action?: string;
  platform?: string;
  interactive?: boolean;
  skipExisting?: boolean;
  repos: string[];
  dryRun?: boolean;
}

@Command({
  name: 'issue:all',
  description:
    'Complete workflow: fetch, plan, implement, review, and commit. Use --from and --to to control stage range.',
  arguments: '<ticket-key>',
  options: { isDefault: false },
})
export class IssueAllCommand extends CommandRunner {
  constructor(
    private conversationService: ConversationService,
    private logger: LoggerService,
    private configService: ConfigService,
    private dryRunPreview: DryRunPreviewService,
    private agents: AgentOrchestrator,
  ) {
    super();
  }

  @Option({
    flags: '--from <stage>',
    description:
      'Start from stage (fetch|plan|implement|review|commit) [REQUIRED]',
    required: true,
  })
  parseFrom(val: string): string {
    return val;
  }

  @Option({
    flags: '-a, --action <action>',
    description:
      'Resolution action type (feature|fix|investigate) - required for PLAN stage',
  })
  parseAction(val: string): string {
    return val;
  }

  @Option({
    flags: '--platform <platform>',
    description: 'Platform to use (jira|github|bitbucket)',
  })
  parsePlatform(val: string): string {
    return val;
  }

  @Option({
    flags: '--interactive',
    description: 'Enable interactive chat mode at key stages (plan, review)',
  })
  parseInteractive(): boolean {
    return true;
  }

  @Option({
    flags: '--to <stage>',
    description:
      'Stop at stage (fetch|plan|implement|review|commit) - defaults to commit',
  })
  parseTo(val: string): string {
    return val;
  }

  @Option({
    flags: '--skip-existing',
    description:
      'Skip stages with existing artifacts (ticket file, plan file, review file)',
  })
  parseSkipExisting(): boolean {
    return true;
  }

  @Option({
    flags: '-r, --repos <repos>',
    description:
      'Comma-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
    required: true,
  })
  parseRepos(val: string): string[] {
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the full workflow without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  async run(passedParams: string[], options?: IssueAllOptions): Promise<void> {
    const ticketKey = passedParams[0];

    if (!ticketKey) {
      console.error(chalk.red('Error: Ticket key is required'));
      console.log(
        chalk.gray(
          'Usage: wf issue:all <ticket-key> --from <stage> [--to <stage>] [options]',
        ),
      );
      console.log(
        chalk.gray(
          'Example: wf issue:all WBP-2971 --from fetch --to review --action fix\n',
        ),
      );
      process.exit(1);
    }

    if (!options?.from) {
      console.error(chalk.red('Error: --from option is required'));
      console.log(
        chalk.gray(
          'Usage: wf issue:all <ticket-key> --from <stage> [--to <stage>] [options]',
        ),
      );
      console.log(chalk.gray('Stages: fetch|plan|implement|review|commit'));
      console.log(
        chalk.gray(
          'Example: wf issue:all WBP-2971 --from fetch --to review --action fix\n',
        ),
      );
      process.exit(1);
    }

    try {
      // Parse stages first to determine if PLAN stage will run
      const fromStage = this.parseStage(options.from);
      const toStage = options.to
        ? this.parseStage(options.to)
        : WorkflowStage.COMMIT;
      const platformName =
        options?.platform ||
        this.configService.get<string>('platforms.primary') ||
        'jira';

      // Validate stage range
      const fromIndex = STAGE_ORDER.indexOf(fromStage);
      const toIndex = STAGE_ORDER.indexOf(toStage);
      if (fromIndex > toIndex) {
        throw new Error(
          `Invalid stage range: --from ${fromStage} --to ${toStage}. ` +
            `The --from stage must come before or equal the --to stage.`,
        );
      }

      const stagesToRun = this.getStagesToRun(fromStage, toStage);

      // Validate action only if PLAN stage will run
      let action: ResolutionAction | undefined;
      if (stagesToRun.includes(WorkflowStage.PLAN)) {
        if (!options?.action) {
          throw new Error(
            'Error: --action is required when running PLAN stage.\n' +
              'Specify: --action <feature|fix|investigate>',
          );
        }
        // Validate action
        const validActions: ResolutionAction[] = [
          'feature',
          'fix',
          'investigate',
        ];
        if (!validActions.includes(options.action as ResolutionAction)) {
          throw new Error(
            `Invalid action: ${options.action}. Must be one of: ${validActions.join(', ')}`,
          );
        }
        action = options.action as ResolutionAction;
      } else if (options?.action) {
        // Action provided but PLAN stage not running - validate it
        const validActions: ResolutionAction[] = [
          'feature',
          'fix',
          'investigate',
        ];
        if (!validActions.includes(options.action as ResolutionAction)) {
          throw new Error(
            `Invalid action: ${options.action}. Must be one of: ${validActions.join(', ')}`,
          );
        }
        action = options.action as ResolutionAction;
      }
      // If action not provided and PLAN stage not running, it will be auto-discovered later

      // Resolve base directory: use the first repo when provided,
      // otherwise fall back to the current working directory.
      const repoBaseDir = resolveRepoBasePath(options.repos[0]);

      if (options?.dryRun) {
        const platformDir = resolveArtifactDir(repoBaseDir, platformName);

        this.dryRunPreview.showHeader('issue:all', ticketKey);
        console.log(
          chalk.gray(
            `   Stages : ${fromStage} → ${toStage}  |  Platform: ${platformName}\n`,
          ),
        );

        let totalApiCalls = 0;
        let totalFilesCreated = 0;
        const terminalLines: string[] = [];

        for (const stage of stagesToRun) {
          this.dryRunPreview.showStageHeader(stage);

          if (stage === WorkflowStage.FETCH) {
            const ticketPath = path.join(platformDir, `${ticketKey}.md`);
            const artifactExists = fs.existsSync(ticketPath);

            if (options.skipExisting && artifactExists) {
              this.dryRunPreview.showSkipped('artifact exists');
            } else {
              this.dryRunPreview.previewApiCall({
                method: 'GET',
                endpoint: `/${platformName}/issues/${ticketKey}`,
                platform: platformName,
                description: `Fetch ticket ${ticketKey}`,
                estimatedResponse: '200 OK — ticket data',
              });
              this.dryRunPreview.previewFileWrite({
                filePath: ticketPath,
                operation: artifactExists ? 'overwrite' : 'create',
                sizeEstimate: '1–5 KB',
                format: 'markdown',
                contentPreview: buildTicketMarkdownPreview(ticketKey),
              });
              totalApiCalls++;
              totalFilesCreated++;
              terminalLines.push(
                `✓ Ticket fetched and saved to: ${ticketPath}`,
              );
            }
          } else if (stage === WorkflowStage.PLAN) {
            const planPath = action
              ? path.join(platformDir, `${ticketKey}-plan-${action}.json`)
              : path.join(platformDir, `${ticketKey}-plan-feature.json`);
            const artifactExists = fs.existsSync(planPath);

            if (options.skipExisting && artifactExists) {
              this.dryRunPreview.showSkipped('artifact exists');
            } else {
              this.dryRunPreview.previewApiCall({
                method: 'POST',
                endpoint: '/v1/messages',
                platform: 'Anthropic Claude',
                description: `Generate ${action || 'feature'} plan`,
                estimatedResponse: [
                  '{',
                  `  "action": "${action || 'feature'}",`,
                  '  "estimatedComplexity": "medium",',
                  '  "steps": ["<step 1>", "..."],',
                  '  "filesAffected": ["<file>", "..."]',
                  '}',
                ].join('\n'),
              });
              this.dryRunPreview.previewFileWrite({
                filePath: planPath,
                operation: artifactExists ? 'overwrite' : 'create',
                sizeEstimate: '2–8 KB',
                format: 'json',
                contentPreview: [
                  '{',
                  `  "action": "${action || 'feature'}",`,
                  '  "estimatedComplexity": "medium",',
                  '  "summary": "<summary>",',
                  '  "steps": [',
                  '    "<step 1>",',
                  '    "<step 2>",',
                  '    ...',
                  '  ]',
                  '}',
                ].join('\n'),
              });
              totalApiCalls++;
              totalFilesCreated++;
              terminalLines.push(`✓ Plan saved to: ${planPath}`);
            }
          } else if (stage === WorkflowStage.IMPLEMENT) {
            if (action === 'investigate') {
              const findingsPath = path.join(
                platformDir,
                `${ticketKey}-plan-investigate-findings-and-recommendations.json`,
              );
              this.dryRunPreview.previewApiCall({
                method: 'POST',
                endpoint: '/v1/messages',
                platform: 'Anthropic Claude',
                description:
                  'Generate investigation findings and recommendations',
                estimatedResponse: [
                  '{',
                  '  "action": "investigate",',
                  '  "summary": "<investigation summary>",',
                  '  "findings": ["<finding 1>", "..."],',
                  '  "recommendations": ["<recommendation 1>", "..."],',
                  '  "conclusion": "<conclusion>"',
                  '}',
                ].join('\n'),
              });
              this.dryRunPreview.previewFileWrite({
                filePath: findingsPath,
                operation: fs.existsSync(findingsPath) ? 'overwrite' : 'create',
                sizeEstimate: '2–6 KB',
                format: 'json',
                contentPreview: [
                  '{',
                  '  "action": "investigate",',
                  '  "summary": "<summary>",',
                  '  "findings": ["<finding>"],',
                  '  "recommendations": ["<recommendation>"],',
                  '  "conclusion": "<conclusion>"',
                  '}',
                ].join('\n'),
              });
              totalApiCalls++;
              totalFilesCreated++;
              terminalLines.push(
                '✓ Investigation findings saved to: ' + findingsPath,
              );
            } else {
              this.dryRunPreview.showNoSideEffects();
              console.log(
                chalk.gray(
                  '     Displays: branch name, implementation steps, affected files',
                ),
              );
            }
          } else if (stage === WorkflowStage.REVIEW) {
            if (action === 'investigate') {
              this.dryRunPreview.showSkipped(
                'investigation workflow ends at IMPLEMENT stage',
              );
              continue;
            }
            const reviewPath = path.join(platformDir, `${ticketKey}-review.md`);
            const artifactExists = fs.existsSync(reviewPath);

            if (options.skipExisting && artifactExists) {
              this.dryRunPreview.showSkipped('artifact exists');
            } else {
              this.dryRunPreview.previewApiCall({
                method: 'POST',
                endpoint: '/v1/messages',
                platform: 'Anthropic Claude',
                description: 'Review code changes (git diff)',
                estimatedResponse: [
                  '{',
                  '  "summary": "<review summary>",',
                  '  "approved": true,',
                  '  "issues": [],',
                  '  "suggestions": ["..."]',
                  '}',
                ].join('\n'),
              });
              this.dryRunPreview.previewFileWrite({
                filePath: reviewPath,
                operation: artifactExists ? 'overwrite' : 'create',
                sizeEstimate: '2–5 KB',
                format: 'markdown',
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
              totalApiCalls++;
              totalFilesCreated++;
              terminalLines.push('✓ Review complete');
              terminalLines.push('  Summary: <AI review summary>');
              terminalLines.push('  Status: ✓ Approved');
            }
          } else if (stage === WorkflowStage.COMMIT) {
            if (action === 'investigate') {
              this.dryRunPreview.showSkipped(
                'investigation workflow ends at IMPLEMENT stage',
              );
              continue;
            }
            this.dryRunPreview.showNoSideEffects();
            console.log(
              chalk.gray(
                '     Displays: commit commands — user confirms before execution',
              ),
            );
            // Optimistic preview — live path may emit 'No changes to commit' if diff is empty
            terminalLines.push('✓ Commit message generated');
            terminalLines.push(`  Message: ${ticketKey}: <AI-generated>`);
          }
        }

        this.dryRunPreview.showSummary({
          apiCallCount: totalApiCalls,
          fileCreatedCount: totalFilesCreated,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          terminalOutputLines: terminalLines,
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      console.log(chalk.bold.cyan('\n🚀 Complete Issue Workflow'));
      console.log(chalk.gray('═'.repeat(70)));
      console.log(chalk.gray(`Ticket: ${ticketKey}`));
      console.log(chalk.gray(`Platform: ${platformName}`));
      if (action) {
        console.log(chalk.gray(`Action: ${action}`));
      }
      console.log(chalk.gray(`Stages: ${fromStage} → ${toStage}\n`));

      let ticketArtifact!: TicketArtifact;
      let planArtifact: PlanArtifact | undefined;
      let reviewArtifact: ReviewArtifact | null = null;

      // STAGE 1: FETCH
      if (stagesToRun.includes(WorkflowStage.FETCH)) {
        ticketArtifact = await this.agents.fetcher.execute(ticketKey, {
          platformName,
          repo: options?.repos?.[0],
          skipExisting: options?.skipExisting,
          baseDir: repoBaseDir,
        });
      } else {
        ticketArtifact = this.agents.fetcher.loadFromDisk(
          ticketKey,
          platformName,
          repoBaseDir,
        );
      }

      // STAGE 2: PLAN
      if (stagesToRun.includes(WorkflowStage.PLAN)) {
        planArtifact = await this.agents.planner.execute(ticketArtifact, {
          action: action!,
          skipExisting: options?.skipExisting,
          affectedRepositories: options?.repos,
        });

        if (options?.interactive && !planArtifact.fromCache) {
          await this.startInteractiveChat(
            ticketKey,
            'plan' as ConvWorkflowStage,
            {
              ticketContent: ticketArtifact.content,
              plan: planArtifact.plan,
            },
          );
        }
      }

      // Load plan for IMPLEMENT or REVIEW stages when PLAN stage was skipped
      if (
        stagesToRun.some((s) =>
          [WorkflowStage.IMPLEMENT, WorkflowStage.REVIEW].includes(s),
        ) &&
        !planArtifact
      ) {
        planArtifact = this.agents.planner.loadFromDisk(
          ticketArtifact.path,
          action,
        );
        if (planArtifact.action !== action) action = planArtifact.action;
      }

      const repoList: (string | undefined)[] = options.repos?.length
        ? options.repos
        : [undefined];

      for (const repo of repoList) {
        const repoDir = resolveRepoBasePath(repo);

        if (repoList.length > 1) {
          console.log(
            chalk.bold.cyan(`\n── Repo: ${repo ?? 'current directory'} ──`),
          );
        }

        // STAGE 3: IMPLEMENT
        let implementerResult: ImplementerResult | undefined;
        if (stagesToRun.includes(WorkflowStage.IMPLEMENT) && planArtifact) {
          implementerResult = await this.agents.implementer.execute(
            ticketArtifact,
            planArtifact,
            { platformName, repoDir },
          );

          // Investigation workflows end at the IMPLEMENT stage
          if (implementerResult.type === 'investigation') {
            console.log(
              chalk.bold.green(
                '\n✓ Investigation workflow complete — no further stages will run',
              ),
            );
            return;
          }
        }

        // STAGE 4: REVIEW
        if (
          stagesToRun.includes(WorkflowStage.REVIEW) &&
          planArtifact?.action !== 'investigate'
        ) {
          reviewArtifact = await this.agents.reviewer.execute(ticketArtifact, {
            skipExisting: options?.skipExisting,
            repoDir,
          });

          if (reviewArtifact) {
            console.log(chalk.bold('\n  Status:'));
            if (reviewArtifact.approved) {
              console.log(
                chalk.white(
                  '    Changes approved - proceeding to commit stage',
                ),
              );
            } else {
              console.log(
                chalk.yellow(
                  '    ⚠ Review found issues - address before committing',
                ),
              );
              console.log(
                chalk.white(
                  '    Commit stage will still execute (you can skip it if needed)',
                ),
              );
            }

            if (options?.interactive) {
              await this.startInteractiveChat(
                ticketKey,
                'review' as ConvWorkflowStage,
                {
                  ticketContent: ticketArtifact.content,
                  plan: planArtifact?.plan,
                  review: reviewArtifact.review,
                },
              );
            }
          }
        }

        // STAGE 5: COMMIT
        if (
          stagesToRun.includes(WorkflowStage.COMMIT) &&
          planArtifact?.action !== 'investigate'
        ) {
          await this.agents.committer.execute(
            ticketKey,
            repoDir,
            planArtifact?.plan?.summary,
          );
        }
      }

      // Summary
      console.log(chalk.bold.green('\n✅ Workflow Complete!'));
      console.log(chalk.gray('═'.repeat(70)));
      console.log(chalk.bold.cyan('\n🎯 Done!\n'));
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  private parseStage(stage: string): WorkflowStage {
    const normalized = stage.toLowerCase();
    if (!Object.values(WorkflowStage).includes(normalized as WorkflowStage)) {
      throw new Error(
        `Invalid stage: ${stage}. Must be one of: ${Object.values(WorkflowStage).join(', ')}`,
      );
    }
    return normalized as WorkflowStage;
  }

  private getStagesToRun(
    from: WorkflowStage,
    to: WorkflowStage,
  ): WorkflowStage[] {
    const fromIndex = STAGE_ORDER.indexOf(from);
    const toIndex = STAGE_ORDER.indexOf(to);

    if (fromIndex > toIndex) {
      throw new Error(
        `Invalid stage range: --from ${from} --to ${to}. 'from' must come before 'to'.`,
      );
    }

    return STAGE_ORDER.slice(fromIndex, toIndex + 1);
  }

  /**
   * Check if artifact exists for a stage
   */
  private checkArtifactExists(
    stage: WorkflowStage,
    ticketKey: string,
    platformName: string,
    action?: ResolutionAction,
    baseDir: string = process.cwd(),
  ): { exists: boolean; path: string } {
    const platformDir = resolveArtifactDir(baseDir, platformName);

    switch (stage) {
      case WorkflowStage.FETCH: {
        const ticketPath = path.join(platformDir, `${ticketKey}.md`);
        return { exists: fs.existsSync(ticketPath), path: ticketPath };
      }

      case WorkflowStage.PLAN:
        if (!action) {
          // Try to find any plan file
          const actions: ResolutionAction[] = ['feature', 'fix', 'investigate'];
          for (const a of actions) {
            const planPath = path.join(
              platformDir,
              `${ticketKey}-plan-${a}.json`,
            );
            if (fs.existsSync(planPath)) {
              return { exists: true, path: planPath };
            }
          }
          return { exists: false, path: '' };
        } else {
          const planPath = path.join(
            platformDir,
            `${ticketKey}-plan-${action}.json`,
          );
          return { exists: fs.existsSync(planPath), path: planPath };
        }

      case WorkflowStage.REVIEW: {
        const reviewPath = path.join(platformDir, `${ticketKey}-review.md`);
        return { exists: fs.existsSync(reviewPath), path: reviewPath };
      }

      default:
        return { exists: false, path: '' };
    }
  }

  /**
   * Start interactive chat session
   *
   * @param ticketKey - Ticket identifier
   * @param stage - Current workflow stage
   * @param workflowState - State data including ticket content, plan, review
   */
  // workflowState is intentionally typed `any` — it carries heterogeneous stage outputs
  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
  private async startInteractiveChat(
    ticketKey: string,
    stage: ConvWorkflowStage,
    workflowState: any,
  ): Promise<void> {
    console.log(chalk.bold.cyan('\n💬 Interactive Chat Mode'));
    console.log(chalk.gray('─'.repeat(70)));
    console.log(
      chalk.gray(
        'You can now discuss the output with Claude. Type "exit" to continue.',
      ),
    );

    const context: ConversationContext = {
      ticketKey,
      stage,
      stageOutput: stage === 'plan' ? workflowState.plan : workflowState.review,
      workflowState: {
        ticketContent: workflowState.ticketContent,
        plan: workflowState.plan,
        review: workflowState.review,
      },
    };

    // Load or create conversation
    let conversation =
      await this.conversationService.loadConversation(ticketKey);
    if (!conversation) {
      conversation = await this.conversationService.createConversation(
        ticketKey,
        context,
      );
    }

    // Build system prompt with stage context
    const systemPrompt = this.buildChatSystemPrompt(stage, workflowState);

    // Start interactive session
    await this.conversationService.startChatSession(
      conversation.conversationId,
      {
        systemPrompt,
        maxTurns: 20,
        exitCommands: ['exit', 'quit', 'continue'],
      },
    );

    console.log(chalk.green('✓ Resuming workflow...\n'));
  }
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

  /**
   * Build system prompt with workflow stage context
   *
   * @param stage - Current workflow stage
   * @param workflowState - State data
   * @returns System prompt with contextual information
   */
  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
  private buildChatSystemPrompt(
    stage: ConvWorkflowStage,
    workflowState: any,
  ): string {
    const basePrompt = `You are an AI assistant helping a developer with a ticket workflow.
The developer is currently at the ${stage.toUpperCase()} stage.

Ticket Content:
${workflowState.ticketContent}
`;

    if (stage === 'plan' && workflowState.plan) {
      return `${basePrompt}

Generated Plan:
- Summary: ${workflowState.plan.summary}
- Action: ${workflowState.plan.action}
- Complexity: ${workflowState.plan.estimatedComplexity}
- Steps:
${workflowState.plan.steps.map((step: string, i: number) => `  ${i + 1}. ${step}`).join('\n')}
${workflowState.plan.filesAffected ? `\nFiles Affected:\n${workflowState.plan.filesAffected.map((f: string) => `  - ${f}`).join('\n')}` : ''}
${workflowState.plan.risks ? `\nRisks:\n${workflowState.plan.risks.map((r: string) => `  - ${r}`).join('\n')}` : ''}

Help the developer refine the implementation plan, discuss the approach, or address concerns.`;
    }

    if (stage === 'review' && workflowState.review) {
      const issuesText =
        workflowState.review.issues.length > 0
          ? workflowState.review.issues
              .map(
                (issue: any) =>
                  `  [${issue.severity}] ${issue.message}${issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : ''}`,
              )
              .join('\n')
          : '  No issues found';

      const suggestionsText =
        workflowState.review.suggestions.length > 0
          ? workflowState.review.suggestions
              .map((s: string) => `  - ${s}`)
              .join('\n')
          : '  No suggestions';

      return `${basePrompt}

Code Review Results:
- Summary: ${workflowState.review.summary}
- Status: ${workflowState.review.approved ? 'APPROVED' : 'NEEDS WORK'}

Issues Found:
${issuesText}

Suggestions:
${suggestionsText}

Help the developer understand the review feedback, discuss issues, or suggest fixes.`;
    }

    return basePrompt;
  }
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */

  /**
   * Resolve a repository name to a filesystem base path.
   *
   * Resolution order:
   *   1. Absolute path that exists on disk — used as-is
   *   2. Path relative to cwd that exists — resolved to absolute
   *   3. Sibling directory of cwd (../repo) that exists
   *   4. Falls back to cwd with a warning
   *
   * @param repo Repository name or path (e.g. "bar", "../bar", "/abs/path/bar")
   * @returns Absolute base path to use for artifact storage
   */
}
