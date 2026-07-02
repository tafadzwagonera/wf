import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiService,
  ResolutionPlan,
  normalizeFileEntries,
  requireAiResponseContent,
} from '../integrations/ai/ai.service';
import { ensureWfHome } from '../shared/utils/ensure-wf-home';
import { IssueTrackerService } from '../integrations/issue-trackers/issue-tracker.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { isAIErrorLike } from '../shared/utils/errors';
import {
  buildSyntheticTicketArtifact,
  isTicketKey,
  parsePlanArtifact,
  buildPlanArtifactResolutionNotice,
  resolvePlanArtifactReference as resolvePlanArtifactReferenceInDir,
  SUPPORTED_PLAN_EXTENSIONS,
} from '../shared/utils/plan-artifact';
import { resolveArtifactDir, resolveCustomArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import type { ResolutionAction, TicketArtifact, PlanArtifact, ModelRouting } from '../agents/interfaces';

const VALID_MODEL_ROUTINGS: ModelRouting[] = ['auto', 'default', 'mechanical'];
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import type { PlanArtifactReference } from '../shared/utils/plan-artifact';

const loadPlanFile = (filePath: string): ResolutionPlan => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Plan file not found: ${filePath}`);
  }
  try {
    return parsePlanArtifact(fs.readFileSync(filePath, 'utf-8'), filePath);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `Plan file is not valid: ${filePath}`);
  }
};

interface IssueImplementOptions {
  branch?: boolean;
  branchNamePattern?: string;
  dryRun?: boolean;
  modelRouting?: string;
  noBranch?: boolean;
  repos?: string[];
  silent?: boolean;
  tracker?: string;
  sessionId?: string;
}

@Injectable()
@Command({
  name: 'issue:implement',
  description:
    'Carry out an implementation plan from a ticket-backed, hashed, or custom plan artifact. ' +
    'Delegates the generate-and-verify loop to the configured backend (Anthropic Agent SDK, OpenAI Agents SDK, or Claude CLI headless mode) based on stages.implement.provider and stages.implement.backend. ' +
    'Progress events are streamed to the terminal so you can follow task and tool activity while edits are being generated. All backends emit stable task and tool progress lines plus explicit file mutation logs and verification logs so terminal output stays human-readable while the agent works. ' +
    'Verification commands are expected to be repo-root-relative; stale plan artifacts that still embed redundant repo-selection `cd` prefixes are normalized, while cross-repo directory jumps are treated as setup errors. ' +
    'Set stages.implement.provider and stages.implement.backend in wf.config to select the backend. Use backend: agent with provider anthropic or openai for the Agent SDK path, or backend: cli with provider anthropic or openai for the CLI headless mode (Claude CLI or Codex CLI respectively). The Anthropic backend explicitly loads ~/.claude/CLAUDE.md and the repository-root CLAUDE.md, warning when either file is missing. The OpenAI backend loads ~/.openai/OPENAI.md and the repository-root .openai/OPENAI.md with the same warning behavior and only exposes an exact-match verify_command tool for whitelisted verification commands. When running from source, use `yarn start issue:implement ...` for the implementation stage and `yarn start issue:commit -c` to stage the final conventional commit once the work is accepted. ' +
    'Unsupported providers (google, deepseek) fail fast with a clear error listing supported providers. backend: standard is rejected at runtime because the implement stage requires an agent-capable backend. ' +
    'Blank AI findings responses fail fast with provider-aware diagnostics instead of generic parse errors. ' +
    'Run issue:fetch then issue:plan before calling this command for ticket-backed workflows. ' +
    'When a hashed plan artifact is provided, the action is inferred from the filename/manifest and `--action` becomes optional, but any supplied action is still validated against the resolved artifact. ' +
    'Before implementation, the command runs an interactive branch creation workflow: checks the working tree for uncommitted changes (stashing if needed), detects and pulls the source branch (dev or main), then prompts for branch name confirmation. ' +
    'Use --silent to auto-stash without prompting; branch selection and naming still prompt when a TTY is available. Use --no-branch to skip branch creation and work directly on the source branch. Use --branch-name-pattern to override the branch name validation regex from git.branchNamePattern config. ' +
    'Examples: wf issue:implement PROJ-123 | wf issue:implement 2026-05-04-1a2b3c4d-fix-plan.json | ' +
    'wf issue:implement PROJ-123 --repos my-repo | ' +
    'wf issue:implement PROJ-123 --silent | wf issue:implement PROJ-123 --no-branch | ' +
    'wf issue:implement PROJ-123 --dry-run',
  arguments: '[ticket-key-or-plan-token]',
})
export class IssueImplementCommand extends CommandRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly issueTrackerService: IssueTrackerService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly orchestrator: AgentOrchestrator
  ) {
    super();
  }

  @Option({
    flags: '--branch-name-pattern <pattern>',
    description: 'Override branch name validation pattern from git.branchNamePattern config',
  })
  parseBranchNamePattern(val: string): string {
    return val;
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview branch, file, and investigation work without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '--model-routing <mode>',
    description:
      'Model selection strategy: auto (detect mechanical vs creative), default (force default model), mechanical (force cheaper model). Defaults to auto.',
  })
  parseModelRouting(val: string): string {
    if (!VALID_MODEL_ROUTINGS.includes(val as ModelRouting)) {
      throw new Error(`Invalid --model-routing value: ${val}. Must be one of: ${VALID_MODEL_ROUTINGS.join(', ')}`);
    }
    return val;
  }

  @Option({
    flags: '--no-branch',
    description: 'Suppress branch creation; work directly on the source branch',
  })
  parseNoBranch(): boolean {
    // Commander maps --no-X flags as boolean negation of X.
    // Return false so that options.branch becomes false when --no-branch is passed.
    return false;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; first repo anchors artifact lookup. When multiple repos are passed, implementation runs per-repo with cross-repo context',
    required: false,
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '-s, --silent',
    description: 'Auto-stash without prompting; branch selection and naming still prompt when a TTY is available',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description: 'Tracker to fetch from if local artifact not found',
  })
  parseTracker(tracker: string): string {
    const validTrackers = ['jira', 'github', 'bitbucket'];
    if (!validTrackers.includes(tracker)) {
      throw new Error(`Invalid tracker: ${tracker}. Valid trackers: ${validTrackers.join(', ')}`);
    }
    return tracker;
  }

  @Option({
    flags: '--session-id <id>',
    description: 'Resume an AI provider session (e.g. Anthropic sess_*, Claude CLI, or Codex CLI session ID)',
  })
  parseSessionId(val: string): string {
    return val;
  }

  async run([identifier]: string[], options?: IssueImplementOptions): Promise<void> {
    try {
      await ensureWfHome();

      // Commander maps --no-branch to { branch: false }; normalize to noBranch
      if (options && options.branch === false) {
        options.noBranch = true;
      }

      // Mutual exclusion: --no-branch + --branch-name-pattern
      if (options?.noBranch && options?.branchNamePattern) {
        console.error(
          chalk.red(
            'Error: --no-branch and --branch-name-pattern are mutually exclusive.\n' +
              '  Use --no-branch to stay on the source branch, or\n' +
              '  Use --branch-name-pattern <pattern> to validate a generated branch name.'
          )
        );
        process.exit(1);
      }

      // Guard: ticketKey + Bitbucket requires --repos
      const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');

      if (identifier && isTicketKey(identifier) && trackerName === 'bitbucket' && !options?.repos?.length) {
        console.error(chalk.red('Error: --repos is required for Bitbucket ticket fetching'));
        process.exit(1);
      }

      if (!identifier) {
        console.error(chalk.red('Error: Provide a <ticket-key> or a custom plan artifact filename'));
        process.exit(1);
        return;
      }

      const repoList: (string | undefined)[] = options?.repos?.length ? options.repos : [undefined];
      const isMultiRepo = repoList.length > 1;

      const baseDir = resolveRepoBasePath(options?.repos?.[0]);
      const trackerDir = resolveArtifactDir(baseDir, trackerName);
      const customArtifactDir = resolveCustomArtifactDir(baseDir);
      const ticketKey = isTicketKey(identifier) ? identifier : undefined;
      let resolvedPlanReference: PlanArtifactReference | null = null;
      let plan: ResolutionPlan | undefined;

      // ── CUSTOM PLAN MODE ────────────────────────────────────────────────
      if (!ticketKey) {
        resolvedPlanReference = this.resolvePlanArtifactReferenceAcrossDirs(
          identifier,
          trackerDir,
          customArtifactDir,
          baseDir
        );

        if (!resolvedPlanReference) {
          throw new Error(
            `Plan artifact not found for ${identifier}. Run wf issue:plan first or provide a supported plan filename.`
          );
        }

        const notice = buildPlanArtifactResolutionNotice({
          artifactPath: resolvedPlanReference.artifactPath,
          action: resolvedPlanReference.action,
          isLegacy: resolvedPlanReference.isLegacy,
          ticketKey: resolvedPlanReference.ticketKey,
          customArtifactName: resolvedPlanReference.customArtifactName,
          sourceName: resolvedPlanReference.sourceName,
        });
        if (notice) {
          console.log(chalk.yellow(`⚠️  ${notice}`));
        }

        plan = loadPlanFile(resolvedPlanReference.artifactPath);
      }

      if (resolvedPlanReference?.sourceKind === 'custom' && plan) {
        const repoDir = resolveRepoBasePath(options?.repos?.[0]);
        const syntheticTicketArtifact = buildSyntheticTicketArtifact(resolvedPlanReference.artifactPath, plan);
        const customBranchSlug = syntheticTicketArtifact.ticketKey;

        if (options?.dryRun) {
          this.dryRunPreview.showHeader('issue:implement', identifier);

          const planExists = fs.existsSync(resolvedPlanReference.artifactPath);
          this.dryRunPreview.previewFileRead({
            filePath: resolvedPlanReference.artifactPath,
            exists: planExists,
            sizeInKb: planExists ? (fs.statSync(resolvedPlanReference.artifactPath).size / 1024).toFixed(2) : '0',
          });

          // Detect investigate plan if file exists, otherwise use action heuristic

          const isInvestigateDryRun = plan.action === 'investigate';

          if (isInvestigateDryRun) {
            const findingsPath = resolvedPlanReference.artifactPath.replace(
              '.json',
              '-findings-and-recommendations.json'
            );
            this.dryRunPreview.previewApiCall({
              method: 'POST',
              endpoint: '/v1/messages',
              platform: this.aiService.getProviderDisplayName(),
              description: 'Generate investigation findings and recommendations',
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
            this.dryRunPreview.showSummary({
              apiCallCount: 1,
              fileCreatedCount: 1,
              fileModifiedCount: 0,
              gitOperationCount: 0,
              terminalOutputLines: [`✓ Investigation findings saved to: ${findingsPath}`],
            });
          } else {
            const trackedFiles = this.resolveDryRunTrackedFiles(plan, repoDir);
            const modifiedFileCount = trackedFiles.filter(file => fs.existsSync(file)).length;
            const createdFileCount = trackedFiles.length - modifiedFileCount;

            this.dryRunPreview.previewGitOperation({
              operation: 'branch',
              description: `create or switch to feature branch ${this.formatCustomBranchName(plan.action, customBranchSlug)}`,
            });
            trackedFiles.forEach(filePath => {
              this.dryRunPreview.previewFileWrite({
                filePath,
                operation: fs.existsSync(filePath) ? 'overwrite' : 'create',
                sizeEstimate: 'AI-generated update',
                format: path.extname(filePath).slice(1) || 'text',
                contentPreview: `# planned change\n${path.relative(repoDir, filePath)}`,
              });
            });
            this.dryRunPreview.showSummary({
              apiCallCount: 0,
              fileCreatedCount: createdFileCount,
              fileModifiedCount: modifiedFileCount,
              gitOperationCount: 1,
              terminalOutputLines: [
                `⚠️ Synthetic execution context for custom plan ${path.basename(resolvedPlanReference.artifactPath)}`,
                `Branch: ${this.formatCustomBranchName(plan.action, customBranchSlug)}`,
                '🔧 Implementation Guide',
                '─'.repeat(70),
                '  Steps:',
                '    1. <step from plan>',
                '    2. ...',
                '',
                '  Files to modify:',
                '    - <file>',
                '',
                '  Repositories affected:',
                '    - <repo>',
                '',
                '  Status:',
                '    Ready to implement — create your branch before starting',
              ],
            });
          }

          this.dryRunPreview.showValidationResult();
          return;
        }

        // Investigation: generate findings instead of showing implementation guide
        if (plan.action === 'investigate') {
          const findingsPath = resolvedPlanReference.artifactPath.replace(
            '.json',
            '-findings-and-recommendations.json'
          );

          this.logger.info('Generating investigation findings...');

          const systemPrompt = `You are an expert software investigator providing structured findings and recommendations.
Analyse the investigation plan and generate comprehensive findings based on the plan's investigation steps.
Return your response as a JSON object.`;

          const findingsPrompt = `Investigation Plan:
${JSON.stringify(plan, null, 2)}

Based on this investigation plan and context, generate structured findings and recommendations.

Return ONLY a valid JSON object:
{
  "action": "investigate",
  "summary": "Brief summary of what was investigated and key findings",
  "findings": ["finding 1", "finding 2", ...],
  "recommendations": ["recommendation 1", ...],
  "conclusion": "Overall conclusion and next steps"
}`;

          const response = await this.aiService.execute({
            prompt: findingsPrompt,
            systemPrompt,
            temperature: 0.4,
          });
          const findingsContent = requireAiResponseContent(
            response,
            'AI provider returned an empty investigation findings response'
          );

          let findings: any;
          try {
            const jsonMatch =
              findingsContent.match(/```json\s*([\s\S]*?)\s*```/) || findingsContent.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON found in response');
            findings = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
          } catch (error) {
            if (isAIErrorLike(error)) {
              throw error;
            }

            throw new Error('Failed to parse investigation findings from AI response');
          }

          await fs.promises.writeFile(findingsPath, JSON.stringify(findings, null, 2), 'utf-8');

          console.log('\n🔍 Investigation Findings');
          console.log('─'.repeat(70));
          console.log(`  Summary: ${findings.summary ?? ''}`);
          if ((findings.findings ?? []).length > 0) {
            console.log('\n  Findings:');
            (findings.findings as string[]).forEach((f: string, i: number) => console.log(`    ${i + 1}. ${f}`));
          }
          if ((findings.recommendations ?? []).length > 0) {
            console.log('\n  Recommendations:');
            (findings.recommendations as string[]).forEach((r: string, i: number) => console.log(`    ${i + 1}. ${r}`));
          }
          console.log(`\n  Conclusion: ${findings.conclusion ?? ''}`);
          this.logger.success(`✓ Findings saved to: ${findingsPath}`);
          return;
        }

        console.log(
          chalk.yellow(
            `⚠️ Created synthetic execution context for custom plan ${path.basename(resolvedPlanReference.artifactPath)}. Branch naming will use artifact stem "${customBranchSlug}".`
          )
        );

        const planArtifact: PlanArtifact = {
          plan,
          action: plan.action,
          path: resolvedPlanReference.artifactPath,
        };

        if (isMultiRepo && !options?.silent) {
          console.log(chalk.bold.yellow('\n🔧 Implementation'));
          console.log(chalk.gray('─'.repeat(70)));
        }

        for (const repo of repoList) {
          const iterRepoDir = resolveRepoBasePath(repo);
          if (isMultiRepo && !options?.silent) console.log(chalk.bold.cyan(`\n  ── ${repo ?? 'current directory'} ──`));
          const result = await this.orchestrator.implementer.execute(syntheticTicketArtifact, planArtifact, {
            trackerName,
            repoDir: iterRepoDir,
            additionalRepoDirs: (options?.repos ?? []).filter(r => r !== repo).map(r => resolveRepoBasePath(r)),
            suppressHeader: isMultiRepo,
            allowMultiRepoScope: isMultiRepo,
            customBranchSlug: customBranchSlug,
            modelRouting: options?.modelRouting as ModelRouting,
            silent: options?.silent,
            noBranch: options?.noBranch,
            branchNamePattern: options?.branchNamePattern,
            resumeProviderSessionId: options?.sessionId,
          });

          if (result?.type === 'investigation') {
            console.log(chalk.bold.green('\n✓ Investigation workflow complete — no further stages will run'));
            return;
          }
        }
        return;
      }

      // ── MODE B & C: ticketKey present ──────────────────────────────────
      const resolvedTicketKey = ticketKey ?? resolvedPlanReference?.ticketKey ?? identifier;
      const ticketPath = path.join(trackerDir, `${resolvedTicketKey}.md`);
      // Preflight Check 1: ticket artifact must exist (gates both live + dry-run)
      if (!fs.existsSync(ticketPath)) {
        console.error(chalk.red(`Error: Ticket artifact not found: ${ticketPath}`));
        console.error(
          chalk.yellow(
            `Run:   wf issue:fetch ${ticketKey}${options?.repos?.length ? ` --repos ${options.repos.join(' ')}` : ''}`
          )
        );
        process.exit(1);
        return;
      }

      resolvedPlanReference =
        resolvedPlanReference ??
        this.resolvePlanArtifactReferenceAcrossDirs(resolvedTicketKey, trackerDir, customArtifactDir, baseDir);

      if (!resolvedPlanReference) {
        console.error(chalk.red(`Error: No plan artifact found for ${resolvedTicketKey}.`));
        console.error(
          chalk.yellow(
            `Run:   wf issue:plan ${resolvedTicketKey} --action <feature|fix|investigate>${options?.repos?.length ? ` --repos ${options.repos.join(' ')}` : ''}`
          )
        );
        console.error(
          chalk.yellow(
            `Then:  wf issue:implement ${resolvedTicketKey}${options?.repos?.length ? ` --repos ${options.repos.join(' ')}` : ''}`
          )
        );
        process.exit(1);
        return;
      }

      const notice = buildPlanArtifactResolutionNotice({
        artifactPath: resolvedPlanReference.artifactPath,
        action: resolvedPlanReference.action,
        isLegacy: resolvedPlanReference.isLegacy,
        ticketKey: resolvedPlanReference.ticketKey,
        customArtifactName: resolvedPlanReference.customArtifactName,
        sourceName: resolvedPlanReference.sourceName,
      });
      if (notice) {
        console.log(chalk.yellow(`⚠️  ${notice}`));
      }

      plan = plan ?? loadPlanFile(resolvedPlanReference.artifactPath);
      const action: ResolutionAction = plan.action;
      const planPath = resolvedPlanReference.artifactPath;

      if (options?.dryRun) {
        this.dryRunPreview.showHeader('issue:implement', resolvedTicketKey);

        // Ticket: always a file-read (preflight check guarantees it exists)
        this.dryRunPreview.previewFileRead({
          filePath: ticketPath,
          exists: true,
          sizeInKb: (fs.statSync(ticketPath).size / 1024).toFixed(2),
        });

        // Plan source: Mode B reads from --plan flag; Mode C reads from discovered path
        if (resolvedPlanReference.artifactPath) {
          const planExists = fs.existsSync(planPath);
          this.dryRunPreview.previewFileRead({
            filePath: planPath,
            exists: planExists,
            sizeInKb: planExists ? (fs.statSync(planPath).size / 1024).toFixed(2) : '0',
          });
        } else {
          // Mode C: plan discovered from disk — file-read only, no AI call
          this.dryRunPreview.previewFileRead({
            filePath: planPath,
            exists: true,
            sizeInKb: (fs.statSync(planPath).size / 1024).toFixed(2),
          });
        }

        // For investigate: also preview findings API call and file write
        if (action === 'investigate') {
          const findingsPath = planPath.replace('.json', '-findings-and-recommendations.json');
          this.dryRunPreview.previewApiCall({
            method: 'POST',
            endpoint: '/v1/messages',
            platform: this.aiService.getProviderDisplayName(),
            description: 'Generate investigation findings and recommendations',
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
        }

        const investigateApiCalls = action === 'investigate' ? 1 : 0;
        const investigateFiles = action === 'investigate' ? 1 : 0;
        this.dryRunPreview.showSummary({
          apiCallCount: investigateApiCalls,
          fileCreatedCount: investigateFiles,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          terminalOutputLines: [
            ...(action === 'investigate'
              ? [
                  `✓ Investigation findings saved to: ${planPath.replace('.json', '-findings-and-recommendations.json')}`,
                ]
              : [
                  '',
                  'Plan Summary:',
                  '  Action: ' + action,
                  '  Complexity: <medium|high|low>',
                  '  Steps: <n>',
                  '  Files affected: <n>',
                  '  Repositories affected: <n>',
                ]),
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      this.logger.info(`Implementing ticket ${resolvedTicketKey}...`);

      const ticketContent = await fs.promises.readFile(ticketPath, 'utf-8');
      const ticketArtifact: TicketArtifact = {
        ticketKey: resolvedTicketKey,
        content: ticketContent,
        path: ticketPath,
      };

      const planArtifact: PlanArtifact = {
        plan,
        action,
        path: planPath,
      };

      if (isMultiRepo && !options?.silent) {
        console.log(chalk.bold.yellow('\n🔧 Implementation'));
        console.log(chalk.gray('─'.repeat(70)));
      }

      for (const repo of repoList) {
        const repoDir = resolveRepoBasePath(repo);
        if (isMultiRepo && !options?.silent) console.log(chalk.bold.cyan(`\n  ── ${repo ?? 'current directory'} ──`));
        const result = await this.orchestrator.implementer.execute(ticketArtifact, planArtifact, {
          trackerName,
          repoDir,
          additionalRepoDirs: (options?.repos ?? []).filter(r => r !== repo).map(r => resolveRepoBasePath(r)),
          suppressHeader: isMultiRepo,
          allowMultiRepoScope: isMultiRepo,
          modelRouting: options?.modelRouting as ModelRouting,
          silent: options?.silent,
          noBranch: options?.noBranch,
          branchNamePattern: options?.branchNamePattern,
          resumeProviderSessionId: options?.sessionId,
        });

        if (result?.type === 'investigation') {
          console.log(chalk.bold.green('\n✓ Investigation workflow complete — no further stages will run'));
          return;
        }
      }
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  private formatTicketAsMarkdown(ticket: any): string {
    let md = `# ${ticket.title}\n\n`;
    md += `**Ticket:** ${ticket.key}\n`;
    md += `**Type:** ${ticket.type || 'N/A'}\n`;
    md += `**Status:** ${ticket.status}\n`;
    md += `**Priority:** ${ticket.priority || 'N/A'}\n\n`;
    md += `## Description\n\n${ticket.description || 'No description provided'}\n`;
    return md;
  }

  /**
   * Format repository string for Bitbucket operations
   * @param repo Repository in workspace/repo or repo-name format
   * @param configService NestJS ConfigService instance
   * @returns Formatted workspace/repo string
   */
  private formatBitbucketRepo(repo: string, configService: ConfigService): string {
    if (repo.includes('/')) {
      return repo;
    }

    const workspace = configService.get<string>('atlassian.bitbucket.workspace');
    if (!workspace) {
      throw new Error(
        'Workspace required. Provide as workspace/repo or set atlassian.bitbucket.workspace in wf.config.*'
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
  private formatBitbucketReference(issueId: string, repo: string, configService: ConfigService): string {
    const formattedRepo = this.formatBitbucketRepo(repo, configService);
    return `${formattedRepo}#${issueId}`;
  }

  /**
   * Resolve a custom plan artifact filename using the active custom namespace.
   *
   * @param identifier - Raw CLI positional argument
   * @param baseDir - Repo-aware base directory
   * @returns Resolved plan artifact path
   */
  private resolveCustomPlanPath(identifier: string, baseDir: string): string {
    const extension = path.extname(identifier).slice(1).toLowerCase();
    const supportedExtension = extension as (typeof SUPPORTED_PLAN_EXTENSIONS)[number];
    if (extension && !SUPPORTED_PLAN_EXTENSIONS.includes(supportedExtension)) {
      throw new Error('Custom plan artifacts must include a supported file extension: .json, .md, .yaml, or .yml');
    }

    if (!extension) {
      return this.resolveCustomPlanStem(identifier, baseDir);
    }

    if (path.isAbsolute(identifier)) {
      return identifier;
    }

    if (path.dirname(identifier) === '.') {
      return path.join(resolveCustomArtifactDir(baseDir), identifier);
    }

    return path.resolve(baseDir, identifier);
  }

  /**
   * Resolve a plan artifact from the standard and custom artifact namespaces.
   *
   * @param identifier - Raw CLI positional argument
   * @param trackerDir - Standard platform artifact directory
   * @param customArtifactDir - Custom artifact directory
   * @returns Resolved plan artifact reference or null when not found
   */
  private resolvePlanArtifactReferenceAcrossDirs(
    identifier: string,
    trackerDir: string,
    customArtifactDir: string,
    baseDir: string
  ): PlanArtifactReference | null {
    const candidateDirs = isTicketKey(identifier) ? [trackerDir] : [trackerDir, customArtifactDir];

    for (const artifactDir of candidateDirs) {
      try {
        return resolvePlanArtifactReferenceInDir(identifier, { artifactDir });
      } catch {
        continue;
      }
    }

    if (!isTicketKey(identifier)) {
      const directPlanPath = this.resolveCustomPlanPath(identifier, baseDir);
      if (fs.existsSync(directPlanPath)) {
        const artifactStem = path.basename(directPlanPath, path.extname(directPlanPath));
        const actionMatch = artifactStem.match(/-(feature|fix|investigate)$/i);
        return {
          action: (actionMatch?.[1] as ResolutionAction) || 'fix',
          artifactPath: directPlanPath,
          format: path.extname(directPlanPath).slice(1).toLowerCase() as 'json' | 'md' | 'yaml' | 'yml',
          hash: path.basename(directPlanPath, path.extname(directPlanPath)),
          sourceKind: 'custom',
          sourceName: artifactStem.replace(/-(feature|fix|investigate)$/i, ''),
          isLegacy: true,
        };
      }
    }

    return null;
  }

  /**
   * Resolve a custom plan artifact stem by scanning supported extensions.
   *
   * @param identifier - Raw CLI positional argument without extension
   * @param baseDir - Repo-aware base directory
   * @returns Absolute path to the uniquely matched artifact
   */
  private resolveCustomPlanStem(identifier: string, baseDir: string): string {
    const basePath = path.isAbsolute(identifier)
      ? identifier
      : path.dirname(identifier) === '.'
        ? path.join(resolveCustomArtifactDir(baseDir), identifier)
        : path.resolve(baseDir, identifier);
    const candidatePaths = SUPPORTED_PLAN_EXTENSIONS.map(candidateExtension => `${basePath}.${candidateExtension}`);
    const matches = candidatePaths.filter(candidatePath => fs.existsSync(candidatePath));

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple custom plan artifacts found for ${identifier}: ${matches
          .map(candidatePath => path.basename(candidatePath))
          .join(', ')}. Use the explicit filename including extension.`
      );
    }

    throw new Error(`Custom plan artifact not found for ${identifier}. Checked: ${candidatePaths.join(', ')}`);
  }

  /**
   * Resolve repo-local file targets for custom dry-run previews.
   *
   * @param plan - Parsed plan artifact
   * @param repoDir - Repository directory selected for execution
   * @returns Absolute file paths the implementer would target
   */
  private resolveDryRunTrackedFiles(plan: ResolutionPlan, repoDir: string): string[] {
    const repoName = path.basename(repoDir);
    const entries = normalizeFileEntries(plan.affectedFiles ?? []);

    return entries
      .filter(entry => entry.status !== 'not-found')
      .map(entry => {
        const relativePath = entry.filePath.startsWith(`${repoName}/`)
          ? entry.filePath.slice(repoName.length + 1)
          : entry.filePath;
        return path.join(repoDir, relativePath);
      });
  }

  /**
   * Format the branch name used by custom plan execution and dry-run previews.
   *
   * @param action - Plan action used to determine branch prefix
   * @param customBranchSlug - Artifact-derived branch slug
   * @returns Branch name shown to the user
   */
  private formatCustomBranchName(action: ResolutionAction, customBranchSlug: string): string {
    const configuredPrefixMapping = this.configService.get<Record<string, string> | undefined>(
      'git.branchPrefixMapping'
    );
    const prefixMapping =
      configuredPrefixMapping && typeof configuredPrefixMapping === 'object' && !Array.isArray(configuredPrefixMapping)
        ? configuredPrefixMapping
        : {
            feature: 'feature',
            fix: 'bugfix',
            investigate: 'chore',
          };

    return `${prefixMapping[action] || 'feature'}/${customBranchSlug}`;
  }
}
