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
import { printCommandHeader } from '../shared/utils/command-header.helper';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { isAiProviderErrorLike, ValidationError, ExecutionError, FileSystemError, AmbiguousPlanArtifactError } from '../shared/utils/errors';
import { assertUsableBranchNamePattern } from '../integrations/git/branch-name';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import {
  buildSyntheticTicketArtifact,
  parsePlanArtifact,
  buildPlanArtifactResolutionNotice,
  resolvePlanArtifactReference as resolvePlanArtifactReferenceInDir,
  SUPPORTED_PLAN_EXTENSIONS,
} from '../shared/utils/plan-artifact';
import { isRepoResolvable, resolveArtifactDir, resolveCustomArtifactDir, resolveRepoBasePath, scaffoldNewRepo } from '../agents/utils';
import { getLoadedWfConfig, initializeWfConfig } from '../config/wf-config-loader';
import { parseReposOption } from './utils/repos-option';
import type { ResolutionAction, TicketArtifact, PlanArtifact, ModelRouting } from '../agents/interfaces';

import { AgentOrchestrator } from '../agents/agent-orchestrator.service';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import type { PlanArtifactReference } from '../shared/utils/plan-artifact';

const VALID_MODEL_ROUTING: ModelRouting[] = ['auto', 'default', 'mechanical'];
const WF_CONFIG_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.json', '.yaml', '.yml'];

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
  figma?: boolean;
  modelRouting?: string;
  noBranch?: boolean;
  repos?: string[];
  silent?: boolean;
  ticketKey?: string;
  tracker?: string;
  sessionId?: string;
  skipInstall?: boolean;
}

@Injectable()
@Command({
  name: 'issue:implement',
  description:
    'Carry out an implementation plan from a ticket-backed, hashed, or custom plan artifact. '
    + 'Delegates the generate-and-verify loop to the configured backend (Anthropic Agent SDK, OpenAI Agents SDK, or Claude CLI headless mode) based on stages.implement.provider and stages.implement.backend. '
    + 'Progress events are streamed to the terminal so you can follow task and tool activity while edits are being generated. All backends emit stable task and tool progress lines plus explicit file mutation logs and verification logs so terminal output stays human-readable while the agent works. '
    + 'Verification commands are expected to be repo-root-relative; stale plan artifacts that still embed redundant repo-selection `cd` prefixes are normalized, while cross-repo directory jumps are treated as setup errors. '
    + 'Set stages.implement.provider and stages.implement.backend in wf.config to select the backend. Use backend: agent with provider anthropic or openai for the Agent SDK path, or backend: cli with provider anthropic or openai for the CLI headless mode (Claude CLI or Codex CLI respectively). Set stages.implement.timeoutMs to override the wall-clock subprocess timeout (default: 15 minutes) and stages.implement.inactivityTimeoutMs to override the per-message inactivity timeout (default: 2 minutes). The Anthropic backend explicitly loads ~/.claude/CLAUDE.md and the repository-root CLAUDE.md, warning when either file is missing. The OpenAI backend loads ~/.openai/AGENTS.md and the repository-root AGENTS.md with the same warning behavior and only exposes an exact-match verify_command tool for whitelisted verification commands. When running from source, use `yarn start issue:implement ...` for the implementation stage and `yarn start issue:commit -c` to stage the final conventional commit once the work is accepted. '
    + 'Unsupported providers (google, deepseek) fail fast with a clear error listing supported providers. backend: standard is rejected at runtime because the implement stage requires an agent-capable backend. '
    + 'Blank AI findings responses fail fast with provider-aware diagnostics instead of generic parse errors. '
    + 'Repo conventions are detected up front and threaded into every backend prompt, including continuation passes, so formatter and structural ESLint constraints survive context compaction. '
    + 'A complexity-gated commit policy controls whether the backend may self-commit: low-complexity plans block commits so changes remain staged for issue:commit; medium and high plans permit a single commit but rewind any self-made commits via git reset --soft and re-stage the content so issue:commit handles the final message. Enforcement always runs even if the backend throws, and any git safety-check failure (shallow repo, detached HEAD, missing upstream) is logged and treated as a skip rather than an error. '
    + 'Run issue:fetch then issue:plan before calling this command for ticket-backed workflows. '
    + 'When a hashed plan artifact is provided, the action is inferred from the filename/manifest and `--action` becomes optional, but any supplied action is still validated against the resolved artifact. '
    + 'Before implementation, the command runs an interactive branch creation workflow: prompts to create a new branch or stay on the current one, then only checks the working tree for uncommitted changes when a pull is needed. '
    + 'When staying on the current branch, the user is asked whether to pull; stashing is only triggered if a pull is accepted. When creating a new branch, uncommitted changes are stashed before pulling the source branch (dev or main). '
    + 'After each pull, runs a dependency install via the detected package manager (bun, pnpm, yarn, or npm); use --skip-install to suppress. Failures are surfaced as warnings and never abort the command. '
    + 'Generated branch names exceeding 100 characters are automatically truncated at the nearest word boundary. '
    + 'Use --silent to auto-stash without prompting; branch selection and naming still prompt when a TTY is available. Use --no-branch to skip branch creation and work directly on the current branch. Use --branch-name-pattern to override the enforced branch name validation regex from git.branchNamePattern config. '
    + 'Branch names are validated when the branch is created, against git ref conventions and the resolved naming pattern (--branch-name-pattern, else git.branchNamePattern, else built-in patterns). Names entered at the branch prompt are trimmed, a pasted `git checkout -b`/`git switch -c` prefix is stripped, and input is validated inline with the specific rejection reason. When branch creation still rejects a name, interactive runs log the reason to the agent log and reopen the branch-name prompt instead of aborting; non-interactive runs fail fast. An invalid --branch-name-pattern regex is rejected before any work starts, and an invalid git.branchNamePattern regex fails config validation at startup. '
    + 'When running against multiple repos, repos absent from the plan\'s affectedRepositories and newRepositories are skipped with a log message. When a plan declares newRepositories, those repos are scaffolded as sibling directories and prepended to the execution order so they run before existing repos. '
    + 'When stages.implement.planStepVerification.enabled is true, a post-implementation AI auditor re-reads the diff and scores each plan step as done, partially-done, not-done, or not-applicable; steps still incomplete trigger an additional fix round in the same session; the loop runs until convergence or stall. stages.implement.planStepVerification.stallWindow (default: 3) sets the sliding-window size for stall detection — the loop exits as stalled when the enriched step content seen in the current round matches any entry in the previous stallWindow rounds. A round whose assessment response is malformed or otherwise fails does not abort the loop — it is retried on the next round, with the actual failure cause recorded in the `step-verify.exhausted` log entry when the stall window is reached; authentication errors (HTTP 401) are the exception and surface immediately as a hard failure. The auditor diffs against the commit HEAD was at before this stage ran (not a possibly-moving HEAD), so committed-but-not-yet-reset work is still visible to the audit even when the commit-policy rewind below is skipped. Verification only runs when the commit policy blocks self-commits (medium/high complexity); low-complexity, stage-and-commit-per-change plans skip it entirely, since their smaller changesets carry less downside risk. When verification is skipped for any reason — config disabled, no working-tree changes, all multi-repo steps are generic (no repo-prefixed path), new-repo run, or commit policy allows direct commit — a `step-verify.skipped reason=<reason>` entry is written to the on-disk agent log so skips are diagnosable rather than silent. In multi-repo mode, generic steps that carry no repo-prefixed file path are excluded from the audit so the assessor only scores actionable steps for the current repo. Steps still pending when rounds are exhausted are listed individually (index, status, and what\'s missing) in the terminal output and the log, not just as a bare count. Non-auth errors in the verification loop do not abort the wf issue:implement workflow; if no assessor target can be resolved or an unexpected error occurs the loop is skipped and the original result is returned unchanged. '
    + 'Before each verification round, a spec-fidelity pre-pass runs one AI call per assessed step to detect literal claim deviations — regex patterns, required parameters, exact threshold values, and string literals — against the diff. Steps with confirmed concrete mismatches receive a [SPEC FIDELITY ERRORS] annotation that causes the step assessor to score them partially-done and enter a fix round even when the code looks superficially complete. Warning-severity findings (diff is silent on a claim) are surfaced but do not trigger a fix round. The pre-pass is skipped when the diff is empty and never throws; any internal error is silently swallowed so the verification loop is unaffected. '
    + 'Runs a Figma implementation pass when stages.implement.figma is true or --figma is passed; Figma frame links stored in the plan manifest by issue:plan are re-read at implement time to fetch design context via the Figma REST API, injecting frame name, dimensions, and screenshot URL into the backend prompt so the implementer can reconcile generated code against spacing, colour, and component-structure constraints before committing. The manifest is resolved directly from the ticket artifact path so the correct links are always loaded without a branch-name search. Figma frame URLs that lack a `?node-id=` query parameter are skipped with a WARN rather than generating a malformed API call. If all frame fetches fail despite valid links being present, a WARN is written to the on-disk agent log to distinguish network or token failures from the links-absent case.',
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
    description: 'Override the enforced branch name validation regex from git.branchNamePattern config; must compile as a valid regex',
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
    flags: '--figma',
    description: 'Force the Figma implementation pass on, fetching design context via the Figma REST API when Figma links are present in the plan manifest. Requires `figma.token` in `wf.config`.',
  })
  parseFigma(): boolean {
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
    flags: '--skip-install',
    description: 'Skip automatic dependency install after branch pull',
  })
  parseSkipInstall(): boolean {
    return true;
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
    if (!options?.silent) printCommandHeader('issue:implement');
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
    const trackerName = options?.tracker || getLoadedWfConfig().tracker;
    const baseDir = resolveRepoBasePath(options?.repos?.[0]);
    const trackerDir = resolveArtifactDir(baseDir, trackerName);
    const customArtifactDir = resolveCustomArtifactDir(baseDir);
    const repos: (string | undefined)[] = options?.repos?.length ? options.repos : [undefined];
    const ticketKey = options?.ticketKey;

    let resolvedPlanReference: PlanArtifactReference | null = null;
    let plan: ResolutionPlan | undefined;

    if (!ticketKey) {
      resolvedPlanReference = this.resolveAndLoadPlanReference(identifier, trackerDir, customArtifactDir, baseDir);
      plan = loadPlanFile(resolvedPlanReference.artifactPath);
    }

    return { trackerName, baseDir, trackerDir, customArtifactDir, repos, ticketKey, resolvedPlanReference, plan };
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
    if (notice) console.log(chalk.yellow(`⚠  ${notice}`));
  }

  private async executeCustomPlanMode(
    ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>,
    identifier: string, options?: IssueImplementOptions
  ): Promise<void> {
    const ref = ctx.resolvedPlanReference;
    const plan = ctx.plan;
    if (!ref || !plan) {
      throw new ValidationError('Custom plan context is incomplete. Re-run issue:implement with a resolved plan artifact.');
    }
    if (options?.dryRun) return this.previewCustomPlanDryRun(identifier, ref, plan, options);
    if (plan.action === 'investigate') return this.executeInvestigation(plan, ref.artifactPath);

    const syntheticTicket = buildSyntheticTicketArtifact(ref.artifactPath, plan);
    const slug = syntheticTicket.ticketKey;
    console.log(chalk.yellow(`⚠ Created synthetic execution context for custom plan ${path.basename(ref.artifactPath)}. Branch naming will use artifact stem "${slug}".`));
    const artifact: PlanArtifact = { plan, action: plan.action, path: ref.artifactPath };
    await this.expandReposFromPlan(ctx, artifact, options?.silent);
    await this.runImplementerLoop(syntheticTicket, artifact, ctx, options, slug);
  }

  private resolveTicketKey(ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>): string {
    const key = ctx.ticketKey ?? ctx.resolvedPlanReference?.ticketKey;
    if (!key) throw new ValidationError('Unable to resolve a ticket key for implementation.');
    return key;
  }

  private async executeTicketMode(
    ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>,
    options?: IssueImplementOptions
  ): Promise<void> {
    const resolvedTicketKey = this.resolveTicketKey(ctx);
    const ticketPath = path.join(ctx.trackerDir, resolvedTicketKey + '.md');
    this.assertTicketExists(ticketPath, ctx.ticketKey, options);

    const ref = this.resolveTicketPlanReference(ctx, resolvedTicketKey, options);
    const plan = ctx.plan ?? loadPlanFile(ref.artifactPath);

    if (options?.dryRun) {
      return this.previewTicketDryRun(resolvedTicketKey, ticketPath, ref.artifactPath, plan.action);
    }

    this.logger.info('Implementing ticket ' + resolvedTicketKey + '...');
    const [ticketArtifact, planArtifact] = await this.buildTicketArtifacts(
      resolvedTicketKey, ticketPath, plan, ref.artifactPath
    );
    await this.expandReposFromPlan(ctx, planArtifact, options?.silent);
    await this.runImplementerLoop(ticketArtifact, planArtifact, ctx, options);
  }

  private async buildTicketArtifacts(
    ticketKey: string, ticketPath: string, plan: ResolutionPlan, artifactPath: string
  ): Promise<[TicketArtifact, PlanArtifact]> {
    const ticketContent = await fs.promises.readFile(ticketPath, 'utf-8');
    return [
      { ticketKey, content: ticketContent, path: ticketPath },
      { plan, action: plan.action, path: artifactPath },
    ];
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
    const activeRepos = this.filterActiveRepos(ctx.repos, planArtifact);
    const isMultiRepo = activeRepos.length > 1;
    if (isMultiRepo && !options?.silent) {
      console.log(chalk.bold.yellow('\n🔧 Implementation'));
      console.log(chalk.gray('─'.repeat(70)));
    }
    for (const repo of activeRepos) {
      await initializeWfConfig(resolveRepoBasePath(repo));
      const shouldExit = await this.executeRepoImplementation(
        repo, ticketArtifact, planArtifact, ctx, options, isMultiRepo, customBranchSlug
      );
      if (shouldExit) return;
    }
  }

  private async executeRepoImplementation(
    repo: string | undefined, ticketArtifact: TicketArtifact, planArtifact: PlanArtifact,
    ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>, options?: IssueImplementOptions,
    isMultiRepo?: boolean, customBranchSlug?: string
  ): Promise<boolean> {
    if (isMultiRepo && !options?.silent) console.log(chalk.bold.cyan('\n  ── ' + (repo ?? 'current directory') + ' ──'));
    const implementOpts = this.buildImplementOpts(repo, ctx, options, isMultiRepo, customBranchSlug, planArtifact);
    const result = await this.orchestrator.implementer.execute(ticketArtifact, planArtifact, implementOpts);
    if (result?.type === 'investigation') {
      console.log(chalk.bold.green('\n✔ Investigation workflow complete — no further stages will run'));
      return true;
    }
    return false;
  }

  /**
   * Filters the repo list to only those present in the plan's affectedRepositories or newRepositories.
   * If both arrays are empty, all repos are returned unchanged.
   * undefined entries (cwd mode) are always kept.
   * Falls back to the full list if filtering would remove all repos.
   * @param repos - The list of repo names (or undefined for cwd mode).
   * @param planArtifact - The plan artifact containing affectedRepositories and newRepositories.
   * @returns The filtered (or original) repo list.
   */
  private filterActiveRepos(repos: (string | undefined)[], planArtifact: PlanArtifact): (string | undefined)[] {
    const affected = new Set([
      ...(planArtifact.plan.affectedRepositories ?? []),
      ...(planArtifact.plan.newRepositories ?? []),
    ]);
    if (affected.size === 0) return repos;

    const active = repos.filter(repo => !repo || affected.has(repo));
    if (active.length < repos.length) {
      const skipped = repos.filter(repo => repo && !affected.has(repo));
      for (const repo of skipped) {
        console.log(chalk.gray(`  Skipping ${repo} — not in plan's affected or new repositories`));
      }
    }
    return active.length > 0 ? active : repos;
  }

  private buildImplementOpts(
    repo: string | undefined,
    ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>,
    options?: IssueImplementOptions, isMultiRepo = false, customBranchSlug?: string,
    planArtifact?: PlanArtifact
  ) {
    return {
      trackerName: ctx.trackerName, repoDir: resolveRepoBasePath(repo),
      additionalRepoDirs: (options?.repos ?? []).filter(r => r !== repo).map(r => resolveRepoBasePath(r)),
      suppressHeader: isMultiRepo, allowMultiRepoScope: isMultiRepo, customBranchSlug,
      modelRouting: options?.modelRouting as ModelRouting, silent: options?.silent,
      noBranch: options?.noBranch, branchNamePattern: options?.branchNamePattern,
      resumeProviderSessionId: options?.sessionId, figma: options?.figma,
      skipInstall: options?.skipInstall,
      isNewRepo: planArtifact?.plan.newRepositories?.includes(repo ?? '') ?? false,
    };
  }

  private async expandReposFromPlan(
    ctx: ReturnType<IssueImplementCommand['resolveImplementContext']>,
    planArtifact: PlanArtifact,
    silent?: boolean
  ): Promise<void> {
    const newRepos = (planArtifact.plan.newRepositories ?? []).filter(r => !isRepoResolvable(r));
    this.validateUnresolvedRepos(planArtifact, newRepos);
    if (newRepos.length === 0) return;

    if (silent || !this.isInteractiveSession()) {
      for (const repo of newRepos) {
        const repoPath = scaffoldNewRepo(repo, ctx.baseDir);
        if (!silent) console.log(chalk.green(`  Scaffolded new repository: ${repoPath}`));
      }
      ctx.repos = [...newRepos, ...ctx.repos];
      return;
    }

    const readyRepos = await this.promptManualRepoSetup(newRepos, ctx.baseDir);
    if (readyRepos.length > 0) ctx.repos = [...readyRepos, ...ctx.repos];
  }

  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  private async promptManualRepoSetup(newRepos: string[], baseDir: string): Promise<string[]> {
    const resolved = newRepos.map(r => ({ name: r, dir: path.resolve(baseDir, '..', r) }));
    console.log(chalk.yellow('\n  The plan requires new repositories that do not exist locally.'));
    console.log(chalk.yellow('  Please create each directory and its wf.config.* file before continuing.\n'));
    for (const r of resolved) {
      console.log(chalk.cyan(`    ${r.name}`));
      console.log(chalk.gray(`      Directory:  ${r.dir}`));
      console.log(chalk.gray(`      Config:     ${r.dir}/wf.config.ts  (or .js / .json / .yaml / .yml)`));
    }
    const { ready } = await inquirer.prompt<{ ready: boolean }>([{
      type: 'confirm', name: 'ready',
      message: 'Have you created the directories and config files listed above?',
      prefix: ' ', default: false,
    }]);
    if (!ready) return [];
    this.validateNewReposExist(resolved);
    for (const r of resolved) console.log(chalk.green(`  Confirmed new repository: ${r.dir}`));
    return resolved.map(r => r.name);
  }

  private validateNewReposExist(resolved: Array<{ name: string; dir: string }>): void {
    const missing = resolved
      .map(r => {
        const dirExists = fs.existsSync(r.dir);
        const configExists = dirExists && WF_CONFIG_EXTENSIONS.some(ext =>
          fs.existsSync(path.join(r.dir, `wf.config${ext}`))
        );
        if (dirExists && configExists) return null;
        return `${r.name} (${dirExists ? 'wf.config.* not found' : 'directory not found'}: ${r.dir})`;
      })
      .filter((entry): entry is string => entry !== null);
    if (missing.length === 0) return;

    console.log(chalk.red('\n  The following repos are still missing:'));
    for (const m of missing) console.log(chalk.red(`    - ${m}`));
    console.log('');
    throw new ValidationError(
      'Cannot proceed — new repositories must have both a directory and a wf.config.* file. '
      + `Missing: ${missing.join(', ')}`
    );
  }

  /**
   * Throws if any repo in `affectedRepositories` is unresolvable and not
   * declared in `newRepositories`.
   * @param planArtifact - The plan artifact containing affectedRepositories.
   * @param newRepos - Repos declared as new in the plan.
   */
  private validateUnresolvedRepos(planArtifact: PlanArtifact, newRepos: string[]): void {
    const allRepos = planArtifact.plan.affectedRepositories ?? [];
    const newSet = new Set(newRepos);
    const invalid = allRepos.filter(r => !isRepoResolvable(r) && !newSet.has(r));
    if (invalid.length === 0) return;
    throw new ValidationError(
      `Plan references repositories not found locally: ${invalid.join(', ')}. `
      + 'If these are new repos, add them to the plan\'s newRepositories field.'
    );
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
      method: 'POST', endpoint: this.aiService.getProviderEndpoint('implement'), platform: this.aiService.getProviderDisplayName('implement'),
      description: 'Generate investigation findings and recommendations', estimatedResponse: preview,
    });
    this.dryRunPreview.previewFileWrite({
      filePath: findingsPath, operation: fs.existsSync(findingsPath) ? 'overwrite' : 'create',
      sizeEstimate: '2–6 KB', format: 'json', contentPreview: preview,
    });
    this.dryRunPreview.showSummary({
      apiCallCount: 1, fileCreatedCount: 1, fileModifiedCount: 0, gitOperationCount: 0,
      terminalOutputLines: [`✔ Investigation findings saved to: ${findingsPath}`],
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
        '  Affected repositories:', '    - <repo>', '',
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
      terminalOutputLines: ['', 'Plan Summary:', '  Action: ' + action, '  Complexity: <medium|high|low>', '  Steps: <n>', '  Files affected: <n>', '  Affected repositories: <n>'],
    });
    this.dryRunPreview.showValidationResult();
  }

  private validateImplementInputs(identifier: string, options?: IssueImplementOptions): void {
    this.assertNoBranchConflict(options);
    this.assertBranchNamePatternFlag(options?.branchNamePattern);
    const trackerName = options?.tracker || getLoadedWfConfig().tracker;
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

  private assertBranchNamePatternFlag(pattern?: string): void {
    assertUsableBranchNamePattern(pattern, '--branch-name-pattern');
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
    this.logger.success(`✔ Findings saved to: ${findingsPath}`);
  }

  private async generateFindings(plan: ResolutionPlan): Promise<any> {
    const systemPrompt = 'You are an expert software investigator providing structured findings and recommendations.\n'
      + 'Analyse the investigation plan and generate comprehensive findings based on the plan\'s investigation steps.\n'
      + 'Return your response as a JSON object.';

    const findingsPrompt = `Investigation Plan:\n${JSON.stringify(plan, null, 2)}\n\n`
      + 'Based on this investigation plan and context, generate structured findings and recommendations.\n\n'
      + 'Return ONLY a valid JSON object:\n'
      + '{ "action": "investigate", "summary": "...", "findings": ["..."], "recommendations": ["..."], "conclusion": "..." }';

    const response = await this.aiService.execute({ prompt: findingsPrompt, systemPrompt, temperature: 0.4, stage: 'implement' });
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
      if (isAiProviderErrorLike(error)) {
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
   * An ambiguous match in trackerDir intentionally aborts before customArtifactDir
   * is checked, rather than falling through to a possibly-unrelated match — genuine
   * ambiguity must surface as an error, not be silently resolved by trying elsewhere.
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
    } catch (error) {
      if (error instanceof AmbiguousPlanArtifactError) throw error;
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
