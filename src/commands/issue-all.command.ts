import { Command, CommandRunner, Option } from 'nest-commander';
import { JiraService } from '../integrations/jira/jira.service';
import { ClaudeService } from '../integrations/ai/claude.service';
import { ConversationService } from '../integrations/ai/conversation/conversation.service';
import {
  ConversationContext,
  WorkflowStage as ConvWorkflowStage,
} from '../integrations/ai/conversation/interfaces';
import { LoggerService } from '../shared/logger/logger.service';
import { GitService } from '../integrations/git/git.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ErrorHandler } from '../shared/utils/error-handler';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

type ResolutionAction = 'implement' | 'fix' | 'investigate';

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
    private jiraService: JiraService,
    private claudeService: ClaudeService,
    private conversationService: ConversationService,
    private logger: LoggerService,
    private gitService: GitService,
    private platformService: PlatformService,
    private configService: ConfigService,
    private dryRunPreview: DryRunPreviewService,
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
    flags: '--action <action>',
    description:
      'Resolution action type (implement|fix|investigate) - required for PLAN stage',
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
    return val.split(',').map((s) => s.trim()).filter(Boolean);
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
              'Specify: --action <implement|fix|investigate>',
          );
        }
        // Validate action
        const validActions: ResolutionAction[] = [
          'implement',
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
          'implement',
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
      const repoBaseDir = this.resolveRepoBasePath(options!.repos[0]);

      if (options?.dryRun) {
        const platformDir = path.join(repoBaseDir, platformName);

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
              : path.join(platformDir, `${ticketKey}-plan-implement.json`);
            const artifactExists = fs.existsSync(planPath);

            if (options.skipExisting && artifactExists) {
              this.dryRunPreview.showSkipped('artifact exists');
            } else {
              this.dryRunPreview.previewApiCall({
                method: 'POST',
                endpoint: '/v1/messages',
                platform: 'Anthropic Claude',
                description: `Generate ${action || 'implement'} plan`,
                estimatedResponse: [
                  '{',
                  `  "action": "${action || 'implement'}",`,
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
                  `  "action": "${action || 'implement'}",`,
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
            this.dryRunPreview.showNoSideEffects();
            console.log(
              chalk.gray(
                '     Displays: branch name, implementation steps, affected files',
              ),
            );
          } else if (stage === WorkflowStage.REVIEW) {
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

      let ticketContent = '';
      let ticketPath = '';
      let plan: any = null;
      let branchName = '';
      let review: any = null;

      // STAGE 1: FETCH
      if (stagesToRun.includes(WorkflowStage.FETCH)) {
        // Check if we should skip this stage
        const artifact = this.checkArtifactExists(
          WorkflowStage.FETCH,
          ticketKey,
          platformName,
          undefined,
          repoBaseDir,
        );
        if (options.skipExisting && artifact.exists) {
          console.log(
            chalk.gray(`📋 Skipping FETCH - artifact exists: ${artifact.path}`),
          );
          ticketContent = fs.readFileSync(artifact.path, 'utf-8');
          ticketPath = artifact.path;
        } else {
          console.log(chalk.bold.yellow('📋 STAGE 1: Fetch Ticket'));
          console.log(chalk.gray('─'.repeat(70)));

          // Format reference for Bitbucket
          const ticketReference =
            platformName === 'bitbucket'
              ? this.formatBitbucketReference(
                  ticketKey,
                  options!.repos[0],
                  this.configService,
                )
              : ticketKey;

          const adapter = this.platformService.getAdapter(platformName);
          const ticket = await adapter.getTicket(ticketReference);

          console.log(chalk.green('✓ Ticket fetched'));
          console.log(chalk.bold('  Title:'), chalk.white(ticket.title));
          console.log(chalk.bold('  Type:'), chalk.white(ticket.type || 'N/A'));
          console.log(
            chalk.bold('  Status:'),
            chalk.white(ticket.status || 'N/A'),
          );

          // Save ticket to platform directory
          const platformDir = path.join(repoBaseDir, platformName);
          if (!fs.existsSync(platformDir)) {
            fs.mkdirSync(platformDir, { recursive: true });
          }

          ticketPath = path.join(platformDir, `${ticketKey}.md`);

          ticketContent = `# ${ticket.key || ticketKey}: ${ticket.title}

**Type:** ${ticket.type || 'N/A'}
**Status:** ${ticket.status || 'N/A'}
**Priority:** ${ticket.priority || 'N/A'}
**Assignee:** ${ticket.assignee || 'Unassigned'}
**Reporter:** ${ticket.reporter || 'Unknown'}
**Created:** ${ticket.created ? ticket.created.toLocaleDateString() : 'N/A'}
**Updated:** ${ticket.updated ? ticket.updated.toLocaleDateString() : 'N/A'}

**Labels:** ${ticket.labels?.join(', ') || 'None'}

## Description

${ticket.description}
`;

          fs.writeFileSync(ticketPath, ticketContent);
          console.log(chalk.gray(`  Saved to: ${ticketPath}`));
        }
      } else {
        // Load ticket from file if skipping fetch
        const platformDir = path.join(repoBaseDir, platformName);
        ticketPath = path.join(platformDir, `${ticketKey}.md`);
        if (fs.existsSync(ticketPath)) {
          ticketContent = fs.readFileSync(ticketPath, 'utf-8');
          console.log(chalk.gray(`📋 Using existing ticket: ${ticketPath}`));
        } else {
          throw new Error(
            `Ticket file not found: ${ticketPath}. Run with --from fetch first.`,
          );
        }
      }

      // STAGE 2: PLAN
      if (stagesToRun.includes(WorkflowStage.PLAN)) {
        // Check if we should skip this stage
        const artifact = this.checkArtifactExists(
          WorkflowStage.PLAN,
          ticketKey,
          platformName,
          action,
          repoBaseDir,
        );
        if (options.skipExisting && artifact.exists) {
          console.log(
            chalk.gray(`🤖 Skipping PLAN - artifact exists: ${artifact.path}`),
          );
          plan = JSON.parse(fs.readFileSync(artifact.path, 'utf-8'));
        } else {
          console.log(
            chalk.bold.yellow('\n🤖 STAGE 2: Generate Implementation Plan'),
          );
          console.log(chalk.gray('─'.repeat(70)));
          console.log(chalk.gray(`  Action type: ${action}`));

          if (!action) {
            throw new Error(
              'Internal error: action should be defined for PLAN stage',
            );
          }

          plan = await this.claudeService.generatePlan(action, ticketContent, {
            ticketKey,
            summary: this.extractSummary(ticketContent),
            affectedRepositories: options!.repos,
          });

          console.log(chalk.green('✓ Plan generated'));
          console.log(chalk.bold('  Summary:'), chalk.white(plan.summary));
          console.log(chalk.bold('  Action:'), chalk.white(plan.action));
          console.log(
            chalk.bold('  Complexity:'),
            chalk.white(plan.estimatedComplexity),
          );

          // Save plan
          const planPath = ticketPath.replace('.md', `-plan-${action}.json`);
          fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
          console.log(chalk.gray(`  Saved to: ${planPath}`));

          // Interactive chat after PLAN stage
          if (options?.interactive) {
            await this.startInteractiveChat(
              ticketKey,
              'plan' as ConvWorkflowStage,
              {
                ticketContent,
                plan,
              },
            );
          }
        }
      }

      // Load plan if needed for later stages
      if (
        stagesToRun.some((s) =>
          [WorkflowStage.IMPLEMENT, WorkflowStage.REVIEW].includes(s),
        )
      ) {
        if (action) {
          // Action explicitly provided - try to load that specific plan
          const planPath = ticketPath.replace('.md', `-plan-${action}.json`);
          if (fs.existsSync(planPath)) {
            plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
            console.log(
              chalk.gray(`🤖 Using plan: ${path.basename(planPath)}`),
            );

            // Validate consistency between provided action and plan's action
            if (plan.action && action !== plan.action) {
              console.log(
                chalk.yellow(
                  `⚠ Warning: Specified --action ${action} differs from plan's action: ${plan.action}`,
                ),
              );
              console.log(
                chalk.yellow(`  Using plan's action: ${plan.action}`),
              );
              action = plan.action; // Override with plan's action
            }
          } else {
            throw new Error(
              `Plan file not found: ${path.basename(planPath)}\n` +
                `Run with --from plan --action ${action} first to generate it.`,
            );
          }
        } else {
          // No action provided - auto-discover existing plan
          const discovered = this.discoverExistingPlan(ticketPath);
          if (!discovered) {
            throw new Error(
              `No plan file found for ticket.\n` +
                `Run with --from plan --action <implement|fix|investigate> first to generate a plan.`,
            );
          }

          plan = discovered.plan;
          action = discovered.action;
          console.log(
            chalk.gray(
              `🤖 Auto-discovered plan: ${path.basename(discovered.planPath)} (action: ${action})`,
            ),
          );
        }
      }

      // Resolve effective affected repositories:
      // explicit CLI flag takes precedence; AI-inferred from ticket is the fallback.
      const planRepos: string[] =
        Array.isArray(plan?.repositoriesAffected)
          ? (plan.repositoriesAffected as string[])
          : [];
      const resolvedRepos: string[] = [
        ...options!.repos,
        ...planRepos,
      ].filter((v, i, a) => v.trim() && a.indexOf(v) === i);

      // STAGE 3: IMPLEMENT
      if (stagesToRun.includes(WorkflowStage.IMPLEMENT)) {
        console.log(chalk.bold.yellow('\n🔧 STAGE 3: Implementation Guide'));
        console.log(chalk.gray('─'.repeat(70)));

        const summary = this.extractSummary(ticketContent);
        branchName = this.generateBranchName(
          ticketKey,
          summary,
          action as ResolutionAction,
          platformName,
        );

        // Check if branch exists
        try {
          const { stdout: currentBranch } = await execAsync(
            'git branch --show-current',
          );
          if (currentBranch.trim() === branchName) {
            console.log(chalk.green(`✓ Already on branch: ${branchName}`));
          } else {
            console.log(chalk.bold('  Branch:'), chalk.cyan(branchName));
            console.log(chalk.gray('  Command:'));
            console.log(chalk.cyan(`    git checkout -b ${branchName}`));
          }
        } catch {
          console.log(chalk.bold('  Branch:'), chalk.cyan(branchName));
          console.log(chalk.gray('  Command:'));
          console.log(chalk.cyan(`    git checkout -b ${branchName}`));
        }

        if (plan) {
          console.log(chalk.bold('\n  Steps:'));
          plan.steps.forEach((step: string, i: number) => {
            console.log(chalk.white(`    ${i + 1}. ${step}`));
          });

          if (plan.filesAffected && plan.filesAffected.length > 0) {
            console.log(chalk.bold('\n  Files to modify:'));
            plan.filesAffected.forEach((file: string) => {
              console.log(chalk.gray(`    - ${file}`));
            });
          }

          if (resolvedRepos.length > 0) {
            console.log(chalk.bold('\n  Repositories affected:'));
            resolvedRepos.forEach((repo: string) => {
              console.log(chalk.gray(`    - ${repo}`));
            });
          }
        }

        console.log(chalk.bold('\n  Status:'));
        console.log(
          chalk.white('    Ready to implement changes according to the plan'),
        );
        console.log(
          chalk.white(
            '    Next stages: review → commit (will execute automatically)',
          ),
        );
      }

      // STAGE 4: REVIEW
      if (stagesToRun.includes(WorkflowStage.REVIEW)) {
        // Check if we should skip this stage
        const artifact = this.checkArtifactExists(
          WorkflowStage.REVIEW,
          ticketKey,
          platformName,
          undefined,
          repoBaseDir,
        );
        if (options.skipExisting && artifact.exists) {
          console.log(
            chalk.gray(
              `🔍 Skipping REVIEW - artifact exists: ${artifact.path}`,
            ),
          );
          // Note: We don't load review from file as it's not needed for subsequent stages
        } else {
          console.log(chalk.bold.yellow('\n🔍 STAGE 4: Code Review'));
          console.log(chalk.gray('─'.repeat(70)));

          if (resolvedRepos.length > 0) {
            console.log(chalk.bold('  Repositories in scope:'));
            resolvedRepos.forEach((repo) =>
              console.log(chalk.gray(`    - ${repo}`)),
            );
          }

          try {
            const { stdout: diff } = await execAsync('git diff HEAD');

            if (!diff.trim()) {
              console.log(chalk.yellow('⚠ No uncommitted changes to review'));
            } else {
              console.log(chalk.bold('  Analyzing changes...'));

              const guidelines = [
                'Clarity: Would another developer understand this instantly?',
                'Deletability: Can I remove or replace this easily?',
                'Failure handling: What breaks? Is it handled?',
                'Necessity: Is anything here unused or speculative?',
                'Quality: Do the changes conform to formatting and quality metrics?',
                `Relevancy: Does the feature or fix work? (This is very important — context: ticket ${ticketKey})`,
                'Security: Are there any glaring security concerns?',
                'Simplicity: Is this the simplest thing that works?',
                'Structure: Does this reflect the domain?',
              ];

              review = await this.claudeService.reviewCode(diff, guidelines);

              console.log(chalk.green('\n✓ Review complete'));
              console.log(
                chalk.bold('\n  Summary:'),
                chalk.white(review.summary),
              );

              if (review.issues.length > 0) {
                console.log(chalk.bold('\n  Issues found:'));
                review.issues.forEach((issue) => {
                  const color =
                    issue.severity === 'error'
                      ? chalk.red
                      : issue.severity === 'warning'
                        ? chalk.yellow
                        : chalk.blue;
                  console.log(
                    color(`    [${issue.severity}] ${issue.message}`),
                  );
                  if (issue.file) {
                    console.log(
                      chalk.gray(
                        `      ${issue.file}${issue.line ? `:${issue.line}` : ''}`,
                      ),
                    );
                  }
                });
              }

              if (review.suggestions.length > 0) {
                console.log(chalk.bold('\n  Suggestions:'));
                review.suggestions.forEach((suggestion) => {
                  console.log(chalk.white(`    - ${suggestion}`));
                });
              }

              console.log(
                chalk.bold('\n  Status:'),
                review.approved
                  ? chalk.green('✓ Approved')
                  : chalk.red('✗ Changes needed'),
              );

              // Save review
              const reviewPath = ticketPath.replace('.md', '-review.md');
              const reviewContent = `# Code Review: ${ticketKey}

## Summary
${review.summary}

## Issues
${review.issues.map((i) => `- [${i.severity}] ${i.message}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ''})` : ''}`).join('\n')}

## Suggestions
${review.suggestions.map((s) => `- ${s}`).join('\n')}

## Status
${review.approved ? '✓ Approved' : '✗ Changes needed'}
`;
              fs.writeFileSync(reviewPath, reviewContent);
              console.log(chalk.gray(`\n  Saved to: ${reviewPath}`));
            }
          } catch (error) {
            console.log(
              chalk.yellow(
                `⚠ Could not generate review: ${(error as Error).message}`,
              ),
            );
          }
        }

        if (review) {
          console.log(chalk.bold('\n  Status:'));
          if (review.approved) {
            console.log(
              chalk.white('    Changes approved - proceeding to commit stage'),
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

          // Interactive chat after REVIEW stage
          if (options?.interactive) {
            await this.startInteractiveChat(
              ticketKey,
              'review' as ConvWorkflowStage,
              {
                ticketContent,
                plan,
                review,
              },
            );
          }
        }
      }

      // STAGE 5: COMMIT
      if (stagesToRun.includes(WorkflowStage.COMMIT)) {
        console.log(chalk.bold.yellow('\n💾 STAGE 5: Commit Changes'));
        console.log(chalk.gray('─'.repeat(70)));

        try {
          const { stdout: status } = await execAsync('git status --porcelain');

          if (!status.trim()) {
            console.log(chalk.yellow('⚠ No changes to commit'));
          } else {
            console.log(chalk.bold('  Generating commit message...'));

            const { stdout: diff } = await execAsync('git diff HEAD');

            // Get commit history for format detection
            const { stdout: logOutput } = await execAsync(
              'git log --pretty=format:"%s" -n 10',
            );
            const commitHistory = logOutput
              .split('\n')
              .filter((line) => line.trim());

            const commitMsg = await this.claudeService.generateCommitMessage(
              diff,
              commitHistory,
              'auto',
            );
            const finalMsg = `${ticketKey}: ${commitMsg}`;

            console.log(chalk.green('\n✓ Commit message generated'));
            console.log(chalk.bold('\n  Message:'));
            console.log(chalk.white(`    ${finalMsg}`));

            console.log(chalk.bold('\n  Commands:'));
            console.log(chalk.cyan('    git add .'));
            console.log(chalk.cyan(`    git commit -m "${finalMsg}"`));
            console.log(chalk.cyan('    git push'));

            if (resolvedRepos.length > 0) {
              console.log(chalk.bold('\n  Repositories:'));
              resolvedRepos.forEach((repo) =>
                console.log(chalk.gray(`    - ${repo}`)),
              );
            }
          }
        } catch (error) {
          console.log(
            chalk.yellow(
              `⚠ Could not generate commit message: ${(error as Error).message}`,
            ),
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

  /**
   * Discover existing plan files for a ticket
   * @returns Object with planPath, action, and parsed plan, or null if no plan found
   */
  private discoverExistingPlan(
    ticketPath: string,
  ): { planPath: string; action: ResolutionAction; plan: any } | null {
    const baseDir = path.dirname(ticketPath);
    const baseName = path.basename(ticketPath, '.md');
    const actions: ResolutionAction[] = ['implement', 'fix', 'investigate'];

    // Search for any plan file
    const foundPlans: Array<{
      path: string;
      action: ResolutionAction;
      mtime: Date;
    }> = [];

    for (const actionType of actions) {
      const planPath = path.join(
        baseDir,
        `${baseName}-plan-${actionType}.json`,
      );
      if (fs.existsSync(planPath)) {
        const stats = fs.statSync(planPath);
        foundPlans.push({
          path: planPath,
          action: actionType,
          mtime: stats.mtime,
        });
      }
    }

    if (foundPlans.length === 0) {
      return null;
    }

    // Sort by most recent modification time
    foundPlans.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (foundPlans.length > 1) {
      console.log(
        chalk.yellow(
          `⚠ Multiple plans found (${foundPlans.map((p) => p.action).join(', ')})`,
        ),
      );
      console.log(chalk.yellow(`  Using most recent: ${foundPlans[0].action}`));
    }

    // Load and parse the plan
    const selectedPlan = foundPlans[0];
    const planContent = fs.readFileSync(selectedPlan.path, 'utf-8');
    const plan = JSON.parse(planContent);

    return {
      planPath: selectedPlan.path,
      action: selectedPlan.action,
      plan,
    };
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
    const platformDir = path.join(baseDir, platformName);

    switch (stage) {
      case WorkflowStage.FETCH:
        const ticketPath = path.join(platformDir, `${ticketKey}.md`);
        return { exists: fs.existsSync(ticketPath), path: ticketPath };

      case WorkflowStage.PLAN:
        if (!action) {
          // Try to find any plan file
          const actions: ResolutionAction[] = [
            'implement',
            'fix',
            'investigate',
          ];
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
        }
        const planPath = path.join(
          platformDir,
          `${ticketKey}-plan-${action}.json`,
        );
        return { exists: fs.existsSync(planPath), path: planPath };

      case WorkflowStage.REVIEW:
        const reviewPath = path.join(platformDir, `${ticketKey}-review.md`);
        return { exists: fs.existsSync(reviewPath), path: reviewPath };

      default:
        return { exists: false, path: '' };
    }
  }

  private extractSummary(content: string): string {
    const match = content.match(/^#\s+[A-Z]+-\d+:\s+(.+)$/m);
    return match ? match[1] : 'Implementation';
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 50);
  }

  /**
   * Generate branch name with conventional prefix and ticket key
   * @param ticketKey - Ticket identifier (e.g., WBP-2937)
   * @param summary - Ticket summary for description
   * @param action - Resolution action (implement, fix, investigate)
   * @param platformName - Platform name (jira, github, bitbucket)
   * @returns Formatted branch name with prefix and uppercase ticket key for Atlassian
   */
  private generateBranchName(
    ticketKey: string,
    summary: string,
    action: ResolutionAction,
    platformName: string,
  ): string {
    // Get prefix from action
    const prefixMapping = this.configService.get<
      Record<ResolutionAction, string>
    >('branching.prefixMapping', {
      implement: 'feature',
      fix: 'bugfix',
      investigate: 'chore',
    });
    const prefix = prefixMapping[action] || 'feature';

    // Preserve case of ticket key (uppercase for Atlassian platforms)
    const isAtlassian = platformName === 'jira' || platformName === 'bitbucket';
    const ticketKeyFormatted = isAtlassian
      ? ticketKey.toUpperCase()
      : ticketKey;

    // Sanitize summary
    const sanitizedSummary = this.slugify(summary);

    // Generate branch name
    const branchName = `${prefix}/${ticketKeyFormatted}__${sanitizedSummary}`;

    // Validate against platform pattern
    const patternKey = isAtlassian
      ? 'branching.atlassianPattern'
      : 'branching.githubPattern';
    const pattern = this.configService.get<string>(patternKey);

    if (pattern) {
      const regex = new RegExp(pattern);
      if (!regex.test(branchName)) {
        console.log(
          chalk.yellow(
            `⚠ Generated branch name "${branchName}" does not match platform pattern: ${pattern}`,
          ),
        );
      }
    }

    return branchName;
  }

  /**
   * Start interactive chat session
   *
   * @param ticketKey - Ticket identifier
   * @param stage - Current workflow stage
   * @param workflowState - State data including ticket content, plan, review
   */
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

  /**
   * Build system prompt with workflow stage context
   *
   * @param stage - Current workflow stage
   * @param workflowState - State data
   * @returns System prompt with contextual information
   */
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

  /**
   * Format repository string for Bitbucket operations
   * @param repo Repository in workspace/repo or repo-name format
   * @param configService NestJS ConfigService instance
   * @returns Formatted workspace/repo string
   */
  private formatBitbucketRepo(
    repo: string,
    configService: ConfigService,
  ): string {
    // Already in workspace/repo format
    if (repo.includes('/')) {
      return repo;
    }

    // Get workspace from config and combine
    const workspace = configService.get<string>(
      'atlassian.bitbucket.workspace',
    );
    if (!workspace) {
      throw new Error(
        'Workspace required. Provide as workspace/repo or set ATLASSIAN_BITBUCKET_WORKSPACE',
      );
    }

    return `${workspace}/${repo}`;
  }

  /**
   * Format Bitbucket issue reference
   * @param issueId Issue ID (number or string)
   * @param repo Repository (workspace/repo or repo-name)
   * @param configService NestJS ConfigService instance
   * @returns Formatted reference (workspace/repo#123)
   */
  private formatBitbucketReference(
    issueId: string,
    repo: string,
    configService: ConfigService,
  ): string {
    const formattedRepo = this.formatBitbucketRepo(repo, configService);
    return `${formattedRepo}#${issueId}`;
  }

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
  private resolveRepoBasePath(repo?: string): string {
    if (!repo) return process.cwd();

    if (path.isAbsolute(repo) && fs.existsSync(repo)) return repo;

    const relPath = path.resolve(process.cwd(), repo);
    if (fs.existsSync(relPath)) return relPath;

    const siblingPath = path.resolve(process.cwd(), '..', repo);
    if (fs.existsSync(siblingPath)) return siblingPath;

    console.log(
      chalk.yellow(
        `⚠  Repository '${repo}' not found as a path or sibling directory. Using current directory.`,
      ),
    );
    return process.cwd();
  }
}
