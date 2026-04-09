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

/** Resolve the single standard plan file for a ticket. */
const discoverStandardPlan = (
  dir: string,
  key: string,
): { action: ResolutionAction; filePath: string } | null => {
  const candidates: ResolutionAction[] = ['feature', 'fix', 'investigate'];
  const found = candidates
    .flatMap((action) =>
      SUPPORTED_PLAN_EXTENSIONS.map((extension) => ({
        action,
        filePath: path.join(dir, `${key}-plan-${action}.${extension}`),
      })),
    )
    .filter(({ filePath }) => fs.existsSync(filePath))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));

  if (found.length === 0) {
    return null;
  }

  if (found.length > 1) {
    throw new Error(
      `Multiple standard plan artifacts found for ${key}: ${found
        .map(({ filePath }) => path.basename(filePath))
        .join(
          ', ',
        )}. Re-run wf issue:plan ${key} --action <feature|fix|investigate> to replace stale plans.`,
    );
  }

  return found[0];
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
    'Carry out an implementation plan from a ticket-backed or custom plan artifact. ' +
    'Uses a two-phase retry strategy on verification failure: a diagnosis call ' +
    'analyses failing file contents, related type definitions, repo test-runner context, and test sources, ' +
    'then generates a structured fix plan used as shared context during re-generation. Retry scope widens to paired implementation/spec files when diagnostics implicate one side of the pair, and history-aware progress tracking keeps retrying when deep failures collapse into smaller earlier-stage residual errors. Repo context is also injected into implement/diagnose prompts to reduce Jest/Vitest framework drift. ' +
    'Verification commands are expected to be repo-root-relative; stale plan artifacts that still embed redundant repo-selection `cd` prefixes are normalized, while cross-repo directory jumps are treated as setup errors. ' +
    'Enable the experimental Anthropic agent backend (requires provider: anthropic) ' +
    'with stages.implement.experimentalAgent: true in wf.config for agentic tool-use ' +
    'on TypeScript type and test failures. ' +
    'Run issue:fetch then issue:plan before calling this command for ticket-backed workflows. ' +
    'Examples: wf issue:implement PROJ-123 | wf issue:implement PROJ-123 --repos my-repo | ' +
    'wf issue:implement PROJ-123 --repos repo-a repo-b | wf issue:implement my-custom-plan.json',
  arguments: '[ticket-key-or-plan-file]',
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
      const ticketKey = isTicketKey(identifier) ? identifier : undefined;
      const resolvedPlanPath = ticketKey
        ? undefined
        : this.resolveCustomPlanPath(identifier, baseDir);

      // ── CUSTOM PLAN MODE ────────────────────────────────────────────────
      if (!ticketKey && resolvedPlanPath) {
        const plan = loadPlanFile(resolvedPlanPath);
        const repoDir = resolveRepoBasePath(options?.repos?.[0]);
        const customExecutionContext =
          this.buildSyntheticCustomExecutionContext(resolvedPlanPath, plan);

        if (options?.dryRun) {
          this.dryRunPreview.showHeader('issue:implement', identifier);

          const planExists = fs.existsSync(resolvedPlanPath);
          this.dryRunPreview.previewFileRead({
            filePath: resolvedPlanPath,
            exists: planExists,
            sizeInKb: planExists
              ? (fs.statSync(resolvedPlanPath).size / 1024).toFixed(2)
              : '0',
          });

          // Detect investigate plan if file exists, otherwise use action heuristic

          const isInvestigateDryRun = plan.action === 'investigate';

          if (isInvestigateDryRun) {
            const findingsPath = resolvedPlanPath.replace(
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
                `⚠️ Synthetic execution context for custom plan ${path.basename(resolvedPlanPath)}`,
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
          const findingsPath = resolvedPlanPath.replace(
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
            `⚠️ Created synthetic execution context for custom plan ${path.basename(resolvedPlanPath)}. Branch naming will use artifact stem "${customExecutionContext.customBranchSlug}".`,
          ),
        );

        const planArtifact: PlanArtifact = {
          plan,
          action: plan.action,
          path: resolvedPlanPath,
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

      if (!ticketKey) {
        throw new Error('Ticket key is required for standard plan execution');
      }

      // ── MODE B & C: ticketKey present ──────────────────────────────────
      const platformDir = resolveArtifactDir(baseDir, platformName);
      warnOnVerificationRepoBoundary(options?.repos);
      const ticketPath = path.join(platformDir, `${ticketKey}.md`);
      const discovered = discoverStandardPlan(platformDir, ticketKey);
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

      if (!discovered) {
        console.error(
          chalk.red(`Error: No plan artifact found for ${ticketKey}.`),
        );
        console.error(
          chalk.yellow(
            `Run:   wf issue:plan ${ticketKey} --action <feature|fix|investigate>${options?.repos?.length ? ` --repos ${options.repos.join(' ')}` : ''}`,
          ),
        );
        console.error(
          chalk.yellow(
            `Then:  wf issue:implement ${ticketKey}${options?.repos?.length ? ` --repos ${options.repos.join(' ')}` : ''}`,
          ),
        );
        process.exit(1);
        return;
      }
      const action: ResolutionAction = discovered.action;
      const planPath = discovered.filePath;

      if (options?.dryRun) {
        this.dryRunPreview.showHeader('issue:implement', ticketKey);

        // Ticket: always a file-read (preflight check guarantees it exists)
        this.dryRunPreview.previewFileRead({
          filePath: ticketPath,
          exists: true,
          sizeInKb: (fs.statSync(ticketPath).size / 1024).toFixed(2),
        });

        // Plan source: Mode B reads from --plan flag; Mode C reads from discovered path
        if (resolvedPlanPath) {
          const planExists = fs.existsSync(resolvedPlanPath);
          this.dryRunPreview.previewFileRead({
            filePath: resolvedPlanPath,
            exists: planExists,
            sizeInKb: planExists
              ? (fs.statSync(resolvedPlanPath).size / 1024).toFixed(2)
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
          const findingsPath = (resolvedPlanPath ?? planPath).replace(
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
                  `✓ Investigation findings saved to: ${(resolvedPlanPath ?? planPath).replace('.json', '-findings-and-recommendations.json')}`,
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

      this.logger.info(`Implementing ticket ${ticketKey}...`);
      const repoDir = resolveRepoBasePath(options?.repos?.[0]);

      const ticketContent = await fs.promises.readFile(ticketPath, 'utf-8');
      const ticketArtifact: TicketArtifact = {
        ticketKey,
        content: ticketContent,
        path: ticketPath,
      };

      let planArtifact: PlanArtifact;

      if (resolvedPlanPath) {
        // Mode B: load plan from --plan path

        const plan = loadPlanFile(resolvedPlanPath);
        planArtifact = {
          plan,
          action: plan.action,
          path: resolvedPlanPath,
        };
      } else {
        // Mode C: load plan from disk (plan artifact verified by preflight check)

        const plan = loadPlanFile(planPath);
        planArtifact = {
          plan,
          action: plan.action,
          path: planPath,
        };
      }

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
