import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService, ResolutionPlan } from '../integrations/ai/ai.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import {
  isTicketKey,
  parsePlanArtifact,
  buildPlanArtifactResolutionNotice,
  resolvePlanArtifactReference as resolvePlanArtifactReferenceInDir,
  SUPPORTED_PLAN_EXTENSIONS,
} from '../shared/utils/plan-artifact';
import {
  resolveArtifactDir,
  resolveCustomArtifactDir,
  resolveRepoBasePath,
} from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import type {
  ResolutionAction,
  TicketArtifact,
  PlanArtifact,
} from '../agents/interfaces';
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
    throw new Error(
      error instanceof Error
        ? error.message
        : `Plan file is not valid: ${filePath}`,
    );
  }
};

interface IssueImplementOptions {
  platform?: string;
  repos?: string[];
  dryRun?: boolean;
}

interface SyntheticCustomExecutionContext {
  ticketArtifact: TicketArtifact;
  customBranchSlug: string;
}

const warnOnVerificationRepoBoundary = (repos?: string[]): void => {
  if ((repos?.length ?? 0) > 1) {
    console.log(
      chalk.yellow(
        `⚠️ issue:implement verifies only the first repository. Remaining repos are context only: ${repos!.slice(1).join(', ')}. Use wf issue or run wf issue:implement separately per repository for multi-repo plans.`,
      ),
    );
  }
};

@Injectable()
@Command({
  name: 'issue:implement',
  description:
    'Carry out an implementation plan from a ticket-backed, hashed, or custom plan artifact. ' +
    'Uses a two-phase retry strategy on verification failure: a diagnosis call ' +
    'analyses failing file contents, related type definitions, repo test-runner context, and test sources, ' +
    'then generates a structured fix plan used as shared context during re-generation. Retry scope widens to paired implementation/spec files when diagnostics implicate one side of the pair, then stays pinned to the smallest implicated file set unless later diagnostics name additional files. History-aware progress tracking keeps retrying when deep failures collapse into smaller earlier-stage residual errors. Repo context is also injected into implement/diagnose prompts to reduce Jest/Vitest framework drift. ' +
    'When the Anthropic or OpenAI agent backend is active, progress events are streamed to the terminal so you can follow task and tool activity while edits are being generated. The Anthropic backend emits stable Claude Agent SDK task and tool progress lines, while the OpenAI backend emits heuristic progress signals to encourage forward motion when verification is converging. ' +
    'Verification commands are expected to be repo-root-relative; stale plan artifacts that still embed redundant repo-selection `cd` prefixes are normalized, while cross-repo directory jumps are treated as setup errors. ' +
    'Enable the Anthropic or OpenAI agent backend by setting stages.implement.agent: true and selecting stages.implement.provider: anthropic or openai in wf.config; the plan artifact provider only tags the plan/model for analysis and does not drive backend selection. The Anthropic backend explicitly loads ~/.claude/CLAUDE.md and the repository-root CLAUDE.md, warning when either file is missing. The OpenAI backend loads ~/.openai/OPENAI.md and the repository-root .openai/OPENAI.md with the same warning behavior and only exposes an exact-match verify_command tool for whitelisted verification commands. When running from source, use `yarn start issue:implement ...` for the implementation stage and `yarn start issue:commit -c` to stage the final conventional commit once the work is accepted. ' +
    'When the agent backend is disabled, issue:implement uses the standard two-phase retry path. Unsupported providers with stages.implement.agent: true fail fast. ' +
    'Run issue:fetch then issue:plan before calling this command for ticket-backed workflows. ' +
    'When a hashed plan artifact is provided, the action is inferred from the filename/manifest and `--action` becomes optional, but any supplied action is still validated against the resolved artifact. ' +
    'Examples: wf issue:implement PROJ-123 | wf issue:implement 2026-05-04-1a2b3c4d-fix-plan.json | ' +
    'wf issue:implement PROJ-123 --repos my-repo | wf issue:implement PROJ-123 --repos repo-a repo-b | ' +
    'wf issue:implement PROJ-123 --dry-run',
  arguments: '[ticket-key-or-plan-token]',
})
export class IssueImplementCommand extends CommandRunner {
  constructor(
    private readonly aiService: AiService,
    private readonly platformService: PlatformService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly orchestrator: AgentOrchestrator,
  ) {
    super();
  }

  @Option({
    flags: '-p, --platform <platform>',
    description: 'Platform to fetch from if local artifact not found',
  })
  parsePlatform(platform: string): string {
    const validPlatforms = ['jira', 'github', 'bitbucket'];
    if (!validPlatforms.includes(platform)) {
      throw new Error(
        `Invalid platform: ${platform}. Valid platforms: ${validPlatforms.join(', ')}`,
      );
    }
    return platform;
  }

  @Option({
    flags: '--dry-run',
    description:
      'Preview branch, file, and investigation work without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; first repo anchors artifact lookup, all repos remain available as implementation context',
    required: false,
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  async run(
    [identifier]: string[],
    options?: IssueImplementOptions,
  ): Promise<void> {
    try {
      // Guard: ticketKey + Bitbucket requires --repos
      const platformName =
        options?.platform ||
        this.configService.get<string>('platforms.primary', 'jira');

      if (
        identifier &&
        isTicketKey(identifier) &&
        platformName === 'bitbucket' &&
        !options?.repos?.length
      ) {
        console.error(
          chalk.red('Error: --repos is required for Bitbucket ticket fetching'),
        );
        process.exit(1);
      }

      if (!identifier) {
        console.error(
          chalk.red(
            'Error: Provide a <ticket-key> or a custom plan artifact filename',
          ),
        );
        process.exit(1);
        return;
      }

      const baseDir = resolveRepoBasePath(options?.repos?.[0]);
      const platformDir = resolveArtifactDir(baseDir, platformName);
      const customArtifactDir = resolveCustomArtifactDir(baseDir);
      const ticketKey = isTicketKey(identifier) ? identifier : undefined;
      let resolvedPlanReference: PlanArtifactReference | null = null;
      let plan: ResolutionPlan | undefined;

      // ── CUSTOM PLAN MODE ────────────────────────────────────────────────
      if (!ticketKey) {
        resolvedPlanReference = this.resolvePlanArtifactReferenceAcrossDirs(
          identifier,
          platformDir,
          customArtifactDir,
          baseDir,
        );

        if (!resolvedPlanReference) {
          throw new Error(
            `Plan artifact not found for ${identifier}. Run wf issue:plan first or provide a supported plan filename.`,
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
        const customExecutionContext =
          this.buildSyntheticCustomExecutionContext(
            resolvedPlanReference.artifactPath,
            plan,
          );

        if (options?.dryRun) {
          this.dryRunPreview.showHeader('issue:implement', identifier);

          const planExists = fs.existsSync(resolvedPlanReference.artifactPath);
          this.dryRunPreview.previewFileRead({
            filePath: resolvedPlanReference.artifactPath,
            exists: planExists,
            sizeInKb: planExists
              ? (
                  fs.statSync(resolvedPlanReference.artifactPath).size / 1024
                ).toFixed(2)
              : '0',
          });

          // Detect investigate plan if file exists, otherwise use action heuristic

          const isInvestigateDryRun = plan.action === 'investigate';

          if (isInvestigateDryRun) {
            const findingsPath = resolvedPlanReference.artifactPath.replace(
              '.json',
              '-findings-and-recommendations.json',
            );
            this.dryRunPreview.previewApiCall({
              method: 'POST',
              endpoint: '/v1/messages',
              platform: this.aiService.getProviderDisplayName(),
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
            this.dryRunPreview.showSummary({
              apiCallCount: 1,
              fileCreatedCount: 1,
              fileModifiedCount: 0,
              gitOperationCount: 0,
              terminalOutputLines: [
                `✓ Investigation findings saved to: ${findingsPath}`,
              ],
            });
          } else {
            const trackedFiles = this.resolveDryRunTrackedFiles(plan, repoDir);
            const modifiedFileCount = trackedFiles.filter((file) =>
              fs.existsSync(file),
            ).length;
            const createdFileCount = trackedFiles.length - modifiedFileCount;

            this.dryRunPreview.previewGitOperation({
              operation: 'branch',
              description: `create or switch to feature branch ${this.formatCustomBranchName(plan.action, customExecutionContext.customBranchSlug)}`,
            });
            trackedFiles.forEach((filePath) => {
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
                `Branch: ${this.formatCustomBranchName(plan.action, customExecutionContext.customBranchSlug)}`,
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
            '-findings-and-recommendations.json',
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

          let findings: any;
          try {
            const jsonMatch =
              response.content.match(/```json\s*([\s\S]*?)\s*```/) ||
              response.content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON found in response');
            findings = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
          } catch {
            throw new Error(
              'Failed to parse investigation findings from AI response',
            );
          }

          await fs.promises.writeFile(
            findingsPath,
            JSON.stringify(findings, null, 2),
            'utf-8',
          );

          console.log('\n🔍 Investigation Findings');
          console.log('─'.repeat(70));
          console.log(`  Summary: ${findings.summary ?? ''}`);
          if ((findings.findings ?? []).length > 0) {
            console.log('\n  Findings:');
            (findings.findings as string[]).forEach((f: string, i: number) =>
              console.log(`    ${i + 1}. ${f}`),
            );
          }
          if ((findings.recommendations ?? []).length > 0) {
            console.log('\n  Recommendations:');
            (findings.recommendations as string[]).forEach(
              (r: string, i: number) => console.log(`    ${i + 1}. ${r}`),
            );
          }
          console.log(`\n  Conclusion: ${findings.conclusion ?? ''}`);
          this.logger.success(`✓ Findings saved to: ${findingsPath}`);
          return;
        }

        console.log(
          chalk.yellow(
            `⚠️ Created synthetic execution context for custom plan ${path.basename(resolvedPlanReference.artifactPath)}. Branch naming will use artifact stem "${customExecutionContext.customBranchSlug}".`,
          ),
        );

        const planArtifact: PlanArtifact = {
          plan,
          action: plan.action,
          path: resolvedPlanReference.artifactPath,
        };
        await this.orchestrator.implementer.execute(
          customExecutionContext.ticketArtifact,
          planArtifact,
          {
            platformName,
            repoDir,
            additionalRepoDirs: (options?.repos ?? [])
              .slice(1)
              .map((r) => resolveRepoBasePath(r)),
            customBranchSlug: customExecutionContext.customBranchSlug,
          },
        );
        return;
      }

      // ── MODE B & C: ticketKey present ──────────────────────────────────
      warnOnVerificationRepoBoundary(options?.repos);
      const resolvedTicketKey =
        ticketKey ?? resolvedPlanReference?.ticketKey ?? identifier;
      const ticketPath = path.join(platformDir, `${resolvedTicketKey}.md`);
      // Preflight Check 1: ticket artifact must exist (gates both live + dry-run)
      if (!fs.existsSync(ticketPath)) {
        console.error(
          chalk.red(`Error: Ticket artifact not found: ${ticketPath}`),
        );
        console.error(
          chalk.yellow(
            `Run:   wf issue:fetch ${ticketKey}${options?.repos?.length ? ` --repos ${options.repos.join(' ')}` : ''}`,
          ),
        );
        process.exit(1);
        return;
      }

      resolvedPlanReference =
        resolvedPlanReference ??
        this.resolvePlanArtifactReferenceAcrossDirs(
          resolvedTicketKey,
          platformDir,
          customArtifactDir,
          baseDir,
        );

      if (!resolvedPlanReference) {
        console.error(
          chalk.red(`Error: No plan artifact found for ${resolvedTicketKey}.`),
        );
        console.error(
          chalk.yellow(
            `Run:   wf issue:plan ${resolvedTicketKey} --action <feature|fix|investigate>${options?.repos?.length ? ` --repos ${options.repos.join(' ')}` : ''}`,
          ),
        );
        console.error(
          chalk.yellow(
            `Then:  wf issue:implement ${resolvedTicketKey}${options?.repos?.length ? ` --repos ${options.repos.join(' ')}` : ''}`,
          ),
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
            sizeInKb: planExists
              ? (fs.statSync(planPath).size / 1024).toFixed(2)
              : '0',
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
          const findingsPath = planPath.replace(
            '.json',
            '-findings-and-recommendations.json',
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
      const repoDir = resolveRepoBasePath(options?.repos?.[0]);

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

      await this.orchestrator.implementer.execute(
        ticketArtifact,
        planArtifact,
        {
          platformName,
          repoDir,
          additionalRepoDirs: (options?.repos ?? [])
            .slice(1)
            .map((r) => resolveRepoBasePath(r)),
        },
      );
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
  private formatBitbucketRepo(
    repo: string,
    configService: ConfigService,
  ): string {
    if (repo.includes('/')) {
      return repo;
    }

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
   * Resolve a custom plan artifact filename using the active custom namespace.
   *
   * @param identifier - Raw CLI positional argument
   * @param baseDir - Repo-aware base directory
   * @returns Resolved plan artifact path
   */
  private resolveCustomPlanPath(identifier: string, baseDir: string): string {
    const extension = path.extname(identifier).slice(1).toLowerCase();
    const supportedExtension =
      extension as (typeof SUPPORTED_PLAN_EXTENSIONS)[number];
    if (extension && !SUPPORTED_PLAN_EXTENSIONS.includes(supportedExtension)) {
      throw new Error(
        'Custom plan artifacts must include a supported file extension: .json, .md, .yaml, or .yml',
      );
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
   * @param platformDir - Standard platform artifact directory
   * @param customArtifactDir - Custom artifact directory
   * @returns Resolved plan artifact reference or null when not found
   */
  private resolvePlanArtifactReferenceAcrossDirs(
    identifier: string,
    platformDir: string,
    customArtifactDir: string,
    baseDir: string,
  ): PlanArtifactReference | null {
    const candidateDirs = isTicketKey(identifier)
      ? [platformDir]
      : [platformDir, customArtifactDir];

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
        const artifactStem = path.basename(
          directPlanPath,
          path.extname(directPlanPath),
        );
        const actionMatch = artifactStem.match(/-(feature|fix|investigate)$/i);
        return {
          action: (actionMatch?.[1] as ResolutionAction) || 'fix',
          artifactPath: directPlanPath,
          format: path.extname(directPlanPath).slice(1).toLowerCase() as
            | 'json'
            | 'md'
            | 'yaml'
            | 'yml',
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
    const candidatePaths = SUPPORTED_PLAN_EXTENSIONS.map(
      (candidateExtension) => `${basePath}.${candidateExtension}`,
    );
    const matches = candidatePaths.filter((candidatePath) =>
      fs.existsSync(candidatePath),
    );

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple custom plan artifacts found for ${identifier}: ${matches
          .map((candidatePath) => path.basename(candidatePath))
          .join(', ')}. Use the explicit filename including extension.`,
      );
    }

    throw new Error(
      `Custom plan artifact not found for ${identifier}. Checked: ${candidatePaths.join(', ')}`,
    );
  }

  /**
   * Build a synthetic ticket-like context so custom plans can reuse the
   * standard implementer flow without a backing ticket artifact.
   *
   * @param planPath - Absolute custom plan artifact path
   * @param plan - Parsed custom plan
   * @returns Synthetic execution context for the implementer
   */
  private buildSyntheticCustomExecutionContext(
    planPath: string,
    plan: ResolutionPlan,
  ): SyntheticCustomExecutionContext {
    const artifactName = path.basename(planPath, path.extname(planPath));
    const customBranchSlug = artifactName.replace(
      new RegExp(`-${plan.action}$`),
      '',
    );
    const ticketKey = customBranchSlug || artifactName;
    const ticketContent = [
      `# ${ticketKey}: ${plan.summary || 'Custom implementation'}`,
      '',
      `**Plan Artifact:** ${path.basename(planPath)}`,
      `**Action:** ${plan.action}`,
      '',
      '## Summary',
      '',
      plan.summary ||
        'Custom plan execution context synthesized from artifact.',
      '',
      '## Steps',
      '',
      ...(plan.steps.length > 0
        ? plan.steps.map((step, index) => `${index + 1}. ${step}`)
        : ['1. Follow the custom implementation plan']),
      '',
      '## Files Affected',
      '',
      ...((plan.filesAffected ?? []).length > 0
        ? (plan.filesAffected ?? []).map((filePath) => `- ${filePath}`)
        : ['- (none listed)']),
      '',
      '## Risks',
      '',
      ...((plan.risks ?? []).length > 0
        ? (plan.risks ?? []).map((risk) => `- ${risk}`)
        : ['- Synthetic execution context derived from custom plan artifact']),
    ].join('\n');

    return {
      ticketArtifact: {
        ticketKey,
        content: ticketContent,
        path: planPath,
      },
      customBranchSlug: ticketKey,
    };
  }

  /**
   * Resolve repo-local file targets for custom dry-run previews.
   *
   * @param plan - Parsed plan artifact
   * @param repoDir - Repository directory selected for execution
   * @returns Absolute file paths the implementer would target
   */
  private resolveDryRunTrackedFiles(
    plan: ResolutionPlan,
    repoDir: string,
  ): string[] {
    const repoName = path.basename(repoDir);
    const files = plan.filesAffected ?? [];

    return files.map((filePath) => {
      const relativePath = filePath.startsWith(`${repoName}/`)
        ? filePath.slice(repoName.length + 1)
        : filePath;
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
  private formatCustomBranchName(
    action: ResolutionAction,
    customBranchSlug: string,
  ): string {
    const configuredPrefixMapping = this.configService.get<
      Record<string, string> | undefined
    >('branching.prefixMapping');
    const prefixMapping =
      configuredPrefixMapping &&
      typeof configuredPrefixMapping === 'object' &&
      !Array.isArray(configuredPrefixMapping)
        ? configuredPrefixMapping
        : {
            feature: 'feature',
            fix: 'bugfix',
            investigate: 'chore',
          };

    return `${prefixMapping[action] || 'feature'}/${customBranchSlug}`;
  }
}
