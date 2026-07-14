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
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { isAIErrorLike, ValidationError, ExecutionError, FileSystemError } from '../shared/utils/errors';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import {
  buildSyntheticTicketArtifact,
  parsePlanArtifact,
  buildPlanArtifactResolutionNotice,
  resolvePlanArtifactReference as resolvePlanArtifactReferenceInDir,
  SUPPORTED_PLAN_EXTENSIONS,
} from '../shared/utils/plan-artifact';
import { resolveArtifactDir, resolveCustomArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { parseReposOption } from './utils/repos-option';
import type { ResolutionAction, TicketArtifact, PlanArtifact, ModelRouting } from '../agents/interfaces';

const VALID_MODEL_ROUTING: ModelRouting[] = ['auto', 'default', 'mechanical'];
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import type { PlanArtifactReference } from '../shared/utils/plan-artifact';

const loadPlanFile = (filePath: string): ResolutionPlan => {
  if (!fs.existsSync(filePath)) {
    throw new FileSystemError(`Plan file not found: ${filePath}`);
  }
  try {
    return parsePlanArtifact(fs.readFileSync(filePath, 'utf-8'), filePath);
  } catch (error) {
    throw new ExecutionError(error instanceof Error ? error.message : `Plan file is not valid: ${filePath}`);
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
  ticketKey?: string;
  tracker?: string;
  sessionId?: string;
}

@Injectable()
@Command({
  name: 'issue:implement',
  description:
    'Carry out an implementation plan from a ticket-backed, hashed, or custom plan artifact. '
    + 'Delegates the generate-and-verify loop to the configured backend (Anthropic Agent SDK, OpenAI Agents SDK, or Claude CLI headless mode) based on stages.implement.provider and stages.implement.backend. '
    + 'Progress events are streamed to the terminal so you can follow task and tool activity while edits are being generated. All backends emit stable task and tool progress lines plus explicit file mutation logs and verification logs so terminal output stays human-readable while the agent works. '
    + 'Verification commands are expected to be repo-root-relative; stale plan artifacts that still embed redundant repo-selection `cd` prefixes are normalized, while cross-repo directory jumps are treated as setup errors. '
    + 'Set stages.implement.provider and stages.implement.backend in wf.config to select the backend. Use backend: agent with provider anthropic or openai for the Agent SDK path, or backend: cli with provider anthropic or openai for the CLI headless mode (Claude CLI or Codex CLI respectively). The Anthropic backend explicitly loads ~/.claude/CLAUDE.md and the repository-root CLAUDE.md, warning when either file is missing. The OpenAI backend loads ~/.openai/OPENAI.md and the repository-root .openai/OPENAI.md with the same warning behavior and only exposes an exact-match verify_command tool for whitelisted verification commands. When running from source, use `yarn start issue:implement ...` for the implementation stage and `yarn start issue:commit -c` to stage the final conventional commit once the work is accepted. '
    + 'Unsupported providers (google, deepseek) fail fast with a clear error listing supported providers. backend: standard is rejected at runtime because the implement stage requires an agent-capable backend. '
    + 'Blank AI findings responses fail fast with provider-aware diagnostics instead of generic parse errors. '
    + 'Run issue:fetch then issue:plan before calling this command for ticket-backed workflows. '
    + 'When a hashed plan artifact is provided, the action is inferred from the filename/manifest and `--action` becomes optional, but any supplied action is still validated against the resolved artifact. '
    + 'Before implementation, the command runs an interactive branch creation workflow: prompts to create a new branch or stay on the current one, then only checks the working tree for uncommitted changes when a pull is needed. '
    + 'When staying on the current branch, the user is asked whether to pull; stashing is only triggered if a pull is accepted. When creating a new branch, uncommitted changes are stashed before pulling the source branch (dev or main). '
    + 'Generated branch names exceeding 100 characters are automatically truncated at the nearest word boundary. '
    + 'Use --silent to auto-stash without prompting; branch selection and naming still prompt when a TTY is available. Use --no-branch to skip branch creation and work directly on the current branch. Use --branch-name-pattern to override the branch name validation regex from git.branchNamePattern config. '
    + 'Examples: wf issue:implement -k PROJ-123 | wf issue:implement 2026-05-04-1a2b3c4d-fix-plan.json | '
    + 'wf issue:implement -k PROJ-123 --repos my-repo | '
    + 'wf issue:implement -k PROJ-123 --silent | wf issue:implement -k PROJ-123 --no-branch | '
    + 'wf issue:implement -k PROJ-123 --dry-run',
  arguments: '[plan-token]',
})
export class IssueImplementCommand extends CommandRunner {
  constructor(
    private readonly aiService: AiService,
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
    if (!VALID_MODEL_ROUTING.includes(val as ModelRouting)) {
      throw new ValidationError(
        `Invalid --model-routing value: ${val}. Must be one of: ${VALID_MODEL_ROUTING.join(', ')}`
      );
    }
    return val;
  }

  @Option({
    flags: '--no-branch',
    description: 'Suppress branch creation; work directly on the current branch',
  })
  parseNoBranch(): boolean {
    // Commander maps --no-X flags as boolean negation of X.
    // Return false so that options.branch becomes false when --no-branch is passed.
    return false;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; the first repository reference anchors artifact lookup and is an execution context. The remaining repository references are execution contexts for a multi-repository issue. Implementation runs per-repo with cross-repo read context from all other repos',
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
    description: 'Auto-stash without prompting; branch selection and naming still prompt when a TTY is available',
  })
  parseSilent(): boolean {
    return true;
  }

  @Option({
    flags: '-k, --ticket-key <key>',
    description: 'Ticket key to implement (e.g. WBP-2971)',
  })
  parseTicketKey(val: string): string {
    return val;
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description: 'Tracker to fetch from if local artifact not found',
  })
  parseTracker(tracker: string): string {
    const validTrackers = ['jira', 'github', 'bitbucket'];
    if (!validTrackers.includes(tracker)) {
      throw new ValidationError(`Invalid tracker: ${tracker}. Valid trackers: ${validTrackers.join(', ')}`);
    }
    return tracker;
  }

  async run([identifier]: string[], options?: IssueImplementOptions): Promise<void> {
    await executeAsyncWithCatch({ fn: async () => {
      await ensureWfHome();
      if (options?.branch === false) options.noBranch = true;
      this.validateImplementInputs(identifier, options);

      const ctx = this.resolveImplementContext(identifier, options);

      if (ctx.resolvedPlanReference?.sourceKind === 'custom' && ctx.plan) {
        return this.executeCustomPlanMode(ctx, identifier, options);
      }

      await this.executeTicketMode(ctx, options);
    } });
  }

  private resolveImplementContext(identifier: string, options?: IssueImplementOptions) {
    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    const baseDir = resolveRepoBasePath(options?.repos?.[0]);
    const trackerDir = resolveArtifactDir(baseDir, trackerName);
    const customArtifactDir = resolveCustomArtifactDir(baseDir);
    const repoList: (string | undefined)[] = options?.repos?.length ? options.repos : [undefined];
    const ticketKey = options?.ticketKey;

    let resolvedPlanReference: PlanArtifactReference | null = null;
    let plan: ResolutionPlan | undefined;

    if (!ticketKey) {
      resolvedPlanReference = this.resolveAndLoadPlanReference(identifier, trackerDir, customArtifactDir, baseDir);
      plan = loadPlanFile(resolvedPlanReference.artifactPath);
    }

    return { trackerName, baseDir, trackerDir, customArtifactDir, repoList, ticketKey, resolvedPlanReference, plan };
  }

  private resolveAndLoadPlanReference(
    identifier: string, trackerDir: string, customArtifactDir: string, baseDir: string
  ): PlanArtifactReference {
    const ref = this.resolvePlanArtifactReferenceAcrossDirs(identifier, trackerDir, customArtifactDir, baseDir);
    if (!ref) {
      throw new FileSystemError(
        `Plan artifact not found for ${identifier}. Run wf issue:plan first or provide a supported plan filename.`
      );
    }
    this.printPlanResolutionNotice(ref);
    return ref;
  }

  private printPlanResolutionNotice(ref: PlanArtifactReference): void {
    const notice = buildPlanArtifactResolutionNotice({
      artifactPath: ref.artifactPath, action: ref.action, isLegacy: ref.isLegacy,
      ticketKey: ref.ticketKey, customArtifactName: ref.customArtifactName, sourceName: ref.sourceName,
    });
    if (notice) console.log(chalk.yellow(`⚠️  ${notice}`));
  }

  private async executeCustomPlanMode(
    ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>,
    identifier: string, options?: IssueImplementOptions
  ): Promise<void> {
    const ref = ctx.resolvedPlanReference!;
    const plan = ctx.plan!;
    const syntheticTicket = buildSyntheticTicketArtifact(ref.artifactPath, plan);

    if (options?.dryRun) {
      return this.previewCustomPlanDryRun(identifier, ref, plan, options);
    }

    if (plan.action === 'investigate') {
      return this.executeInvestigation(plan, ref.artifactPath);
    }

    const slug = syntheticTicket.ticketKey;
    console.log(chalk.yellow(
      `⚠️ Created synthetic execution context for custom plan ${path.basename(ref.artifactPath)}. Branch naming will use artifact stem "${slug}".`
    ));

    const artifact: PlanArtifact = { plan, action: plan.action, path: ref.artifactPath };
    await this.runImplementerLoop(syntheticTicket, artifact, ctx, options, slug);
  }

  private async executeTicketMode(
    ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>,
    options?: IssueImplementOptions
  ): Promise<void> {
    const resolvedTicketKey = ctx.ticketKey ?? ctx.resolvedPlanReference?.ticketKey;
    const ticketPath = path.join(ctx.trackerDir, resolvedTicketKey + '.md');
    this.assertTicketExists(ticketPath, ctx.ticketKey, options);

    const ref = this.resolveTicketPlanReference(ctx, resolvedTicketKey!, options);
    const plan = ctx.plan ?? loadPlanFile(ref.artifactPath);

    if (options?.dryRun) {
      return this.previewTicketDryRun(resolvedTicketKey!, ticketPath, ref.artifactPath, plan.action);
    }

    this.logger.info('Implementing ticket ' + resolvedTicketKey + '...');
    const ticketContent = await fs.promises.readFile(ticketPath, 'utf-8');
    const ticketArtifact: TicketArtifact = { ticketKey: resolvedTicketKey!, content: ticketContent, path: ticketPath };
    const planArtifact: PlanArtifact = { plan, action: plan.action, path: ref.artifactPath };
    await this.runImplementerLoop(ticketArtifact, planArtifact, ctx, options);
  }

  private resolveTicketPlanReference(
    ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>,
    ticketKey: string, options?: IssueImplementOptions
  ): PlanArtifactReference {
    if (ctx.resolvedPlanReference) return ctx.resolvedPlanReference;

    const ref = this.resolvePlanArtifactReferenceAcrossDirs(
      ticketKey, ctx.trackerDir, ctx.customArtifactDir, ctx.baseDir
    );
    if (!ref) {
      const reposFlag = options?.repos?.length ? ' --repos ' + options.repos.join(' ') : '';
      throw new FileSystemError(
        'No plan artifact found for ' + ticketKey + '.\n'
        + 'Run:   wf issue:plan -k ' + ticketKey + ' --action <feature|fix|investigate>' + reposFlag + '\n'
        + 'Then:  wf issue:implement -k ' + ticketKey + reposFlag
      );
    }
    this.printPlanResolutionNotice(ref);
    return ref;
  }

  private assertTicketExists(ticketPath: string, ticketKey?: string, options?: IssueImplementOptions): void {
    if (fs.existsSync(ticketPath)) return;
    const reposFlag = options?.repos?.length ? ` --repos ${options.repos.join(' ')}` : '';
    throw new FileSystemError(`Ticket artifact not found: ${ticketPath}\nRun:   wf issue:fetch ${ticketKey}${reposFlag}`);
  }

  private async runImplementerLoop(
    ticketArtifact: TicketArtifact, planArtifact: PlanArtifact,
    ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>,
    options?: IssueImplementOptions, customBranchSlug?: string
  ): Promise<void> {
    const isMultiRepo = ctx.repoList.length > 1;
    if (isMultiRepo && !options?.silent) {
      console.log(chalk.bold.yellow('\n🔧 Implementation'));
      console.log(chalk.gray('─'.repeat(70)));
    }

    for (const repo of ctx.repoList) {
      if (isMultiRepo && !options?.silent) console.log(chalk.bold.cyan('\n  ── ' + (repo ?? 'current directory') + ' ──'));
      const result = await this.orchestrator.implementer.execute(
        ticketArtifact, planArtifact, this.buildImplementOpts(repo, ctx, options, isMultiRepo, customBranchSlug)
      );
      if (result?.type === 'investigation') {
        console.log(chalk.bold.green('\n✓ Investigation workflow complete — no further stages will run'));
        return;
      }
    }
  }

  private buildImplementOpts(
    repo: string | undefined,
    ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>,
    options?: IssueImplementOptions, isMultiRepo = false, customBranchSlug?: string
  ) {
    return {
      trackerName: ctx.trackerName, repoDir: resolveRepoBasePath(repo),
      additionalRepoDirs: (options?.repos ?? []).filter(r => r !== repo).map(r => resolveRepoBasePath(r)),
      suppressHeader: isMultiRepo, allowMultiRepoScope: isMultiRepo, customBranchSlug,
      modelRouting: options?.modelRouting as ModelRouting, silent: options?.silent,
      noBranch: options?.noBranch, branchNamePattern: options?.branchNamePattern,
      resumeProviderSessionId: options?.sessionId,
    };
  }

  private previewCustomPlanDryRun(
    identifier: string, ref: PlanArtifactReference, plan: ResolutionPlan, options?: IssueImplementOptions
  ): void {
    this.dryRunPreview.showHeader('issue:implement', identifier);
    this.previewFileReadForPlan(ref.artifactPath);

    if (plan.action === 'investigate') {
      return this.previewInvestigateDryRun(ref.artifactPath);
    }

    const repoDir = resolveRepoBasePath(options?.repos?.[0]);
    this.previewCustomImplementDryRun(plan, ref, repoDir);
  }

  private previewFileReadForPlan(artifactPath: string): void {
    const exists = fs.existsSync(artifactPath);
    this.dryRunPreview.previewFileRead({
      filePath: artifactPath, exists,
      sizeInKb: exists ? (fs.statSync(artifactPath).size / 1024).toFixed(2) : '0',
    });
  }

  private previewInvestigateDryRun(artifactPath: string): void {
    const findingsPath = artifactPath.replace('.json', '-findings-and-recommendations.json');
    const preview = '{\n  "action": "investigate",\n  "summary": "<summary>",\n  "findings": ["<finding>"],\n  "recommendations": ["<recommendation>"],\n  "conclusion": "<conclusion>"\n}';
    this.dryRunPreview.previewApiCall({
      method: 'POST', endpoint: '/v1/messages', platform: this.aiService.getProviderDisplayName(),
      description: 'Generate investigation findings and recommendations', estimatedResponse: preview,
    });
    this.dryRunPreview.previewFileWrite({
      filePath: findingsPath, operation: fs.existsSync(findingsPath) ? 'overwrite' : 'create',
      sizeEstimate: '2–6 KB', format: 'json', contentPreview: preview,
    });
    this.dryRunPreview.showSummary({
      apiCallCount: 1, fileCreatedCount: 1, fileModifiedCount: 0, gitOperationCount: 0,
      terminalOutputLines: [`✓ Investigation findings saved to: ${findingsPath}`],
    });
    this.dryRunPreview.showValidationResult();
  }

  private previewCustomImplementDryRun(plan: ResolutionPlan, ref: PlanArtifactReference, repoDir: string): void {
    const slug = buildSyntheticTicketArtifact(ref.artifactPath, plan).ticketKey;
    const branchName = this.formatCustomBranchName(plan.action, slug);
    const trackedFiles = this.resolveDryRunTrackedFiles(plan, repoDir);
    const modifiedCount = trackedFiles.filter(f => fs.existsSync(f)).length;

    this.dryRunPreview.previewGitOperation({ operation: 'branch', description: 'create or switch to feature branch ' + branchName });
    for (const filePath of trackedFiles) {
      this.dryRunPreview.previewFileWrite({
        filePath, operation: fs.existsSync(filePath) ? 'overwrite' : 'create',
        sizeEstimate: 'AI-generated update', format: path.extname(filePath).slice(1) || 'text',
        contentPreview: '# planned change\n' + path.relative(repoDir, filePath),
      });
    }
    this.showCustomImplementSummary(ref, branchName, trackedFiles.length, modifiedCount);
  }

  private showCustomImplementSummary(
    ref: PlanArtifactReference, branchName: string, totalFiles: number, modifiedCount: number
  ): void {
    this.dryRunPreview.showSummary({
      apiCallCount: 0, fileCreatedCount: totalFiles - modifiedCount,
      fileModifiedCount: modifiedCount, gitOperationCount: 1,
      terminalOutputLines: [
        'Synthetic execution context for custom plan ' + path.basename(ref.artifactPath),
        'Branch: ' + branchName,
        '🔧 Implementation Guide', '─'.repeat(70),
        '  Steps:', '    1. <step from plan>', '    2. ...', '',
        '  Files to modify:', '    - <file>', '',
        '  Repositories affected:', '    - <repo>', '',
        '  Status:', '    Ready to implement — create your branch before starting',
      ],
    });
    this.dryRunPreview.showValidationResult();
  }

  private previewTicketDryRun(
    ticketKey: string, ticketPath: string, planPath: string, action: ResolutionAction
  ): void {
    this.dryRunPreview.showHeader('issue:implement', ticketKey);
    const sizeInKb = (fs.statSync(ticketPath).size / 1024).toFixed(2);
    this.dryRunPreview.previewFileRead({ filePath: ticketPath, exists: true, sizeInKb });
    this.previewFileReadForPlan(planPath);

    if (action === 'investigate') {
      return this.previewInvestigateDryRun(planPath);
    }

    this.dryRunPreview.showSummary({
      apiCallCount: 0, fileCreatedCount: 0, fileModifiedCount: 0, gitOperationCount: 0,
      terminalOutputLines: ['', 'Plan Summary:', '  Action: ' + action, '  Complexity: <medium|high|low>', '  Steps: <n>', '  Files affected: <n>', '  Repositories affected: <n>'],
    });
    this.dryRunPreview.showValidationResult();
  }

  private validateImplementInputs(identifier: string, options?: IssueImplementOptions): void {
    this.assertNoBranchConflict(options);
    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    if (options?.ticketKey && trackerName === 'bitbucket' && !options?.repos?.length) {
      throw new ValidationError('--repos is required for Bitbucket ticket fetching');
    }
    if (!options?.ticketKey && !identifier) {
      throw new ValidationError('Provide --ticket-key <key> or a custom plan artifact filename');
    }
    if (identifier && /^[A-Z]+-\d+$/i.test(identifier) && !options?.ticketKey) {
      throw new ValidationError(
        `Ticket keys must now be passed via -k/--ticket-key. Use: wf issue:implement -k ${identifier}`
      );
    }
  }

  private assertNoBranchConflict(options?: IssueImplementOptions): void {
    if (!options?.noBranch || !options?.branchNamePattern) return;
    throw new ValidationError(
      '--no-branch and --branch-name-pattern are mutually exclusive.\n'
      + '  Use --no-branch to stay on the current branch, or\n'
      + '  Use --branch-name-pattern <pattern> to validate a generated branch name.'
    );
  }

  /**
   * Generate and persist investigation findings from a plan artifact.
   *
   * @param plan - Parsed investigation plan
   * @param artifactPath - Source plan artifact path used to derive the findings path
   */
  private async executeInvestigation(plan: ResolutionPlan, artifactPath: string): Promise<void> {
    const findingsPath = artifactPath.replace('.json', '-findings-and-recommendations.json');
    this.logger.info('Generating investigation findings...');

    const findings = await this.generateFindings(plan);
    await fs.promises.writeFile(findingsPath, JSON.stringify(findings, null, 2), 'utf-8');
    this.printFindings(findings);
    this.logger.success(`✓ Findings saved to: ${findingsPath}`);
  }

  private async generateFindings(plan: ResolutionPlan): Promise<any> {
    const systemPrompt = 'You are an expert software investigator providing structured findings and recommendations.\n'
      + 'Analyse the investigation plan and generate comprehensive findings based on the plan\'s investigation steps.\n'
      + 'Return your response as a JSON object.';

    const findingsPrompt = `Investigation Plan:\n${JSON.stringify(plan, null, 2)}\n\n`
      + 'Based on this investigation plan and context, generate structured findings and recommendations.\n\n'
      + 'Return ONLY a valid JSON object:\n'
      + '{ "action": "investigate", "summary": "...", "findings": ["..."], "recommendations": ["..."], "conclusion": "..." }';

    const response = await this.aiService.execute({ prompt: findingsPrompt, systemPrompt, temperature: 0.4 });
    const content = requireAiResponseContent(response, 'AI provider returned an empty investigation findings response');
    return this.parseInvestigationFindings(content);
  }

  private printFindings(findings: any): void {
    console.log('\n🔍 Investigation Findings');
    console.log('─'.repeat(70));
    console.log(`  Summary: ${findings.summary ?? ''}`);
    this.printNumberedList('Findings', findings.findings);
    this.printNumberedList('Recommendations', findings.recommendations);
    console.log(`\n  Conclusion: ${findings.conclusion ?? ''}`);
  }

  private printNumberedList(label: string, items?: string[]): void {
    if (!items?.length) return;
    console.log(`\n  ${label}:`);
    for (const [i, item] of items.entries()) {
      console.log(`    ${i + 1}. ${item}`);
    }
  }

  /**
   * Parse JSON investigation findings from an AI response string.
   *
   * @param content - Raw AI response content
   * @returns Parsed findings object
   */
  private parseInvestigationFindings(content: string): any {
    const jsonMatch = new RegExp(/```json\s*([\s\S]*?)\s*```/).exec(content) || new RegExp(/\{[\s\S]*}/).exec(content);
    if (!jsonMatch) {
      throw new ExecutionError('No JSON found in response');
    }

    try {
      return JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
    } catch (error) {
      if (isAIErrorLike(error)) {
        throw error;
      }
      throw new ExecutionError('Failed to parse investigation findings from AI response');
    }
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
    this.assertSupportedExtension(extension);

    if (!extension) return this.resolveCustomPlanStem(identifier, baseDir);
    if (path.isAbsolute(identifier)) return identifier;

    return this.resolveArtifactCandidate(identifier, baseDir);
  }

  private assertSupportedExtension(extension: string): void {
    if (!extension) return;
    const supported = extension as (typeof SUPPORTED_PLAN_EXTENSIONS)[number];
    if (!SUPPORTED_PLAN_EXTENSIONS.includes(supported)) {
      throw new ValidationError(
        'Custom plan artifacts must include a supported file extension: .json, .md, .yaml, or .yml'
      );
    }
  }

  private resolveArtifactCandidate(identifier: string, baseDir: string): string {
    const artifactDir = resolveCustomArtifactDir(baseDir);
    const candidate = path.join(artifactDir, identifier);
    if (fs.existsSync(candidate)) return candidate;

    const fromRoot = path.resolve(baseDir, identifier);
    if (fs.existsSync(fromRoot)) return fromRoot;

    throw new FileSystemError(
      `Custom plan artifact "${identifier}" not found in artifact repository: ${candidate}`
    );
  }

  /**
   * Resolve a plan artifact from the standard and custom artifact namespaces.
   *
   * @param identifier - Raw CLI positional argument
   * @param trackerDir - Standard platform artifact directory
   * @param customArtifactDir - Custom artifact directory
   * @param baseDir
   * @returns Resolved plan artifact reference or null when not found
   */
  private resolvePlanArtifactReferenceAcrossDirs(
    identifier: string, trackerDir: string, customArtifactDir: string, baseDir: string
  ): PlanArtifactReference | null {
    for (const artifactDir of [trackerDir, customArtifactDir]) {
      const resolved = this.safePlanResolve(identifier, artifactDir);
      if (resolved) return resolved;
    }

    if (/^[A-Z]+-\d+$/i.test(identifier)) return null;

    return this.resolveDirectCustomPlan(identifier, baseDir);
  }

  private resolveDirectCustomPlan(identifier: string, baseDir: string): PlanArtifactReference | null {
    try {
      const planPath = this.resolveCustomPlanPath(identifier, baseDir);
      return this.buildLegacyPlanReference(planPath);
    } catch (error) {
      if (!(error instanceof FileSystemError)) throw error;
      return null;
    }
  }

  private buildLegacyPlanReference(planPath: string): PlanArtifactReference {
    const stem = path.basename(planPath, path.extname(planPath));
    const actionMatch = new RegExp(/-(feature|fix|investigate)$/i).exec(stem);
    return {
      action: (actionMatch?.[1] as ResolutionAction) || 'fix',
      artifactPath: planPath,
      format: path.extname(planPath).slice(1).toLowerCase() as 'json' | 'md' | 'yaml' | 'yml',
      hash: stem,
      sourceKind: 'custom',
      sourceName: stem.replace(/-(feature|fix|investigate)$/i, ''),
      isLegacy: true,
    };
  }

  /**
   * Resolve a custom plan artifact stem by scanning supported extensions.
   *
   * @param identifier - Raw CLI positional argument without extension
   * @param baseDir - Repo-aware base directory
   * @returns Absolute path to the uniquely matched artifact
   */
  /**
   * Resolve a plan artifact reference without throwing.
   * @returns The resolved reference, or null when no matching artifact exists
   */
  private safePlanResolve(
    identifier: string,
    artifactDir: string
  ): ReturnType<typeof resolvePlanArtifactReferenceInDir> | null {
    try {
      return resolvePlanArtifactReferenceInDir(identifier, { artifactDir });
    } catch {
      return null;
    }
  }

  private resolveCustomPlanStem(identifier: string, baseDir: string): string {
    const basePath = path.isAbsolute(identifier)
      ? identifier
      : path.join(resolveCustomArtifactDir(baseDir), identifier);
    const candidates = SUPPORTED_PLAN_EXTENSIONS.map(ext => `${basePath}.${ext}`);
    const matches = candidates.filter(c => fs.existsSync(c));

    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const names = matches.map(c => path.basename(c)).join(', ');
      throw new ValidationError(`Multiple custom plan artifacts found for ${identifier}: ${names}. Use the explicit filename including extension.`);
    }
    throw new FileSystemError(`Custom plan artifact not found for ${identifier}. Checked: ${candidates.join(', ')}`);
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
    const prefixMapping
      = configuredPrefixMapping && typeof configuredPrefixMapping === 'object' && !Array.isArray(configuredPrefixMapping)
        ? configuredPrefixMapping
        : {
            feature: 'feature',
            fix: 'bugfix',
            investigate: 'chore',
          };

    return `${prefixMapping[action] || 'feature'}/${customBranchSlug}`;
  }
}
