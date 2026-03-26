import { Command, CommandRunner, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiService,
  ResolutionPlan,
} from '../integrations/ai/ai.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { buildTicketMarkdownPreview } from '../shared/preview/preview.helpers';
import { ErrorHandler } from '../shared/utils/error-handler';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import type {
  ResolutionAction,
  TicketArtifact,
  PlanArtifact,
} from '../agents/interfaces';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

type OutputFormat = 'json' | 'md' | 'yaml';

const loadPlanFile = (filePath: string): unknown => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Plan file not found: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    throw new Error(`Plan file is not valid JSON: ${filePath}`);
  }
};

/** Finds the most recently modified plan file for a ticket across all actions. */
const discoverPlanAction = (
  dir: string,
  key: string,
): { action: ResolutionAction; filePath: string } => {
  const candidates: ResolutionAction[] = ['investigate', 'feature', 'fix'];
  const found = candidates
    .map((a) => ({
      action: a,
      filePath: path.join(dir, `${key}-plan-${a}.json`),
    }))
    .filter(({ filePath }) => fs.existsSync(filePath))
    .sort(
      (x, y) =>
        fs.statSync(y.filePath).mtimeMs - fs.statSync(x.filePath).mtimeMs,
    );
  return (
    found[0] ?? {
      action: 'feature',
      filePath: path.join(dir, `${key}-plan-feature.json`),
    }
  );
};

interface IssueImplementOptions {
  plan?: string;
  platform?: string;
  format?: OutputFormat;
  repos?: string[];
  dryRun?: boolean;
}

@Injectable()
@Command({
  name: 'issue:implement',
  description:
    'Carry out an implementation plan for a ticket. ' +
    'Requires a local ticket artifact (<ticketKey>.md) and a plan artifact ' +
    '(<ticketKey>-plan-<action>.json). ' +
    'Run issue:fetch then issue:plan before calling this command.',
  arguments: '[ticket-key]',
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
    flags: '--plan <path>',
    description:
      'Filename (looked up under <app>/.wf/<platform>/) or relative path (resolved from app root)',
    required: false,
  })
  parsePlan(val: string): string {
    return val;
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
    flags: '-f, --format <format>',
    description: 'Output format for the implementation plan (json|md|yaml)',
  })
  parseFormat(format: string): OutputFormat {
    const validFormats: OutputFormat[] = ['json', 'md', 'yaml'];
    if (!validFormats.includes(format as OutputFormat)) {
      throw new Error(
        `Invalid format: ${format}. Valid formats: ${validFormats.join(', ')}`,
      );
    }
    return format as OutputFormat;
  }

  @Option({
    flags: '-r, --repos <repos>',
    description:
      'Comma-separated list of repositories affected by this ticket (workspace/repo or repo-name)',
    required: false,
  })
  parseRepos(val: string): string[] {
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  @Option({
    flags: '--dry-run',
    description: 'Preview the implement operation without making changes',
  })
  parseDryRun(): boolean {
    return true;
  }

  async run(
    [ticketKey]: string[],
    options?: IssueImplementOptions,
  ): Promise<void> {
    try {
      // Guard: ticketKey + Bitbucket requires --repos
      const platformName =
        options?.platform ||
        this.configService.get<string>('platforms.primary', 'jira');

      if (
        ticketKey &&
        platformName === 'bitbucket' &&
        !options?.repos?.length
      ) {
        console.error(
          chalk.red('Error: --repos is required for Bitbucket ticket fetching'),
        );
        process.exit(1);
      }

      // Guard: must have either ticketKey or --plan
      if (!ticketKey && !options?.plan) {
        console.error(
          chalk.red(
            'Error: Provide a <ticket-key> or use --plan <path> to load a plan directly',
          ),
        );
        process.exit(1);
      }

      const format = options?.format || 'json';

      const baseDir = resolveRepoBasePath(options?.repos?.[0]);

      const resolvedPlanPath = options?.plan
        ? path.dirname(options.plan) === '.'
          ? path.join(baseDir, '.wf', platformName, options.plan)
          : path.resolve(baseDir, options.plan)
        : undefined;

      // ── MODE A: --plan only (no ticketKey) ─────────────────────────────
      if (!ticketKey && resolvedPlanPath) {
        if (options?.dryRun) {
          this.dryRunPreview.showHeader(
            'issue:implement',
            options.plan ?? '<plan-path>',
          );

          const planExists = fs.existsSync(resolvedPlanPath);
          this.dryRunPreview.previewFileRead({
            filePath: resolvedPlanPath,
            exists: planExists,
            sizeInKb: planExists
              ? (fs.statSync(resolvedPlanPath).size / 1024).toFixed(2)
              : '0',
          });

          // Detect investigate plan if file exists, otherwise use action heuristic
          /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
          const planForDryRun = planExists
            ? (() => {
                try {
                  return JSON.parse(fs.readFileSync(resolvedPlanPath, 'utf-8'));
                } catch {
                  return null;
                }
              })()
            : null;
          const isInvestigateDryRun = planForDryRun?.action === 'investigate';
          /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */

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
            this.dryRunPreview.showSummary({
              apiCallCount: 0,
              fileCreatedCount: 0,
              fileModifiedCount: 0,
              gitOperationCount: 0,
              terminalOutputLines: [
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

        /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
        const plan = loadPlanFile(resolvedPlanPath) as any;

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

        const steps: string[] = plan.steps ?? [];
        const filesAffected: string[] = plan.filesAffected ?? [];
        const repositoriesAffected: string[] = plan.repositoriesAffected ?? [];
        /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

        console.log('\n🔧 Implementation Guide');
        console.log('─'.repeat(70));
        console.log('  Steps:');
        steps.forEach((step, i) => {
          console.log(`    ${i + 1}. ${step}`);
        });
        console.log('');
        console.log('  Files to modify:');
        filesAffected.forEach((file) => {
          console.log(`    - ${file}`);
        });
        console.log('');
        console.log('  Repositories affected:');
        repositoriesAffected.forEach((repo) => {
          console.log(`    - ${repo}`);
        });
        console.log('');
        console.log('  Status:');
        console.log(
          '    Ready to implement — create your branch before starting',
        );
        console.log('');
        return;
      }

      // ── MODE B & C: ticketKey present ──────────────────────────────────
      const platformDir = resolveArtifactDir(baseDir, platformName);
      const ticketPath = path.join(platformDir, `${ticketKey}.md`);
      const discovered = discoverPlanAction(platformDir, ticketKey);
      const action: ResolutionAction = discovered.action;
      const planPath = discovered.filePath;
      // Preflight Check 1: ticket artifact must exist (gates both live + dry-run)
      if (!fs.existsSync(ticketPath)) {
        console.error(
          chalk.red(`Error: Ticket artifact not found: ${ticketPath}`),
        );
        console.error(
          chalk.yellow(
            `Run:   wf issue:fetch ${ticketKey}${options?.repos?.length ? ` --repos ${options.repos.join(',')}` : ''}`,
          ),
        );
        process.exit(1);
        return;
      }

      // Preflight Check 2: plan artifact must exist (gates both live + dry-run)
      // Note: discoverPlanAction always returns a struct — when no plan exists on
      // disk it returns a synthesised fallback path that does not exist. This
      // fs.existsSync call is the only existence gate.
      if (!fs.existsSync(planPath)) {
        console.error(
          chalk.red(`Error: No plan artifact found for ${ticketKey}.`),
        );
        console.error(
          chalk.yellow(
            `Run:   wf issue:plan ${ticketKey} --action <feature|fix|investigate>${options?.repos?.length ? ` --repos ${options.repos.join(',')}` : ''}`,
          ),
        );
        console.error(
          chalk.yellow(
            `Then:  wf issue:implement ${ticketKey}${options?.repos?.length ? ` --repos ${options.repos.join(',')}` : ''}`,
          ),
        );
        process.exit(1);
        return;
      }

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

      const ticketContent = await fs.promises.readFile(ticketPath, 'utf-8');
      const ticketArtifact: TicketArtifact = {
        ticketKey,
        content: ticketContent,
        path: ticketPath,
      };

      let planArtifact: PlanArtifact;

      if (resolvedPlanPath) {
        // Mode B: load plan from --plan path
        /* eslint-disable @typescript-eslint/no-unsafe-member-access */
        const plan = loadPlanFile(resolvedPlanPath) as ResolutionPlan;
        planArtifact = {
          plan,
          action: ((plan as any).action ?? action) as ResolutionAction,
          path: resolvedPlanPath,
        };
        /* eslint-enable @typescript-eslint/no-unsafe-member-access */
      } else {
        // Mode C: load plan from disk (plan artifact verified by preflight check)
        /* eslint-disable @typescript-eslint/no-unsafe-member-access */
        const plan = loadPlanFile(planPath) as ResolutionPlan;
        planArtifact = {
          plan,
          // `action` is not declared on ResolutionPlan; the `as any` cast is
          // intentional and mirrors the same defensive pattern used in Mode B.
          action: ((plan as any).action ?? action) as ResolutionAction,
          path: planPath,
        };
        /* eslint-enable @typescript-eslint/no-unsafe-member-access */
      }

      await this.orchestrator.implementer.execute(
        ticketArtifact,
        planArtifact,
        {
          platformName,
        },
      );
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  /* eslint-disable @typescript-eslint/no-unsafe-member-access */
  private formatTicketAsMarkdown(ticket: any): string {
    let md = `# ${ticket.title}\n\n`;
    md += `**Ticket:** ${ticket.key}\n`;
    md += `**Type:** ${ticket.type || 'N/A'}\n`;
    md += `**Status:** ${ticket.status}\n`;
    md += `**Priority:** ${ticket.priority || 'N/A'}\n\n`;
    md += `## Description\n\n${ticket.description || 'No description provided'}\n`;
    return md;
  }
  /* eslint-enable @typescript-eslint/no-unsafe-member-access */

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
}
