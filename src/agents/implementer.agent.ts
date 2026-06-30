// src/agents/implementer.agent.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { GitService } from '../integrations/git/git.service';
import type { BranchInfo } from '../integrations/git/git.service';
import { AiService, normalizeFileEntries } from '../integrations/ai/ai.service';
import {
  ImplementBackendSelection,
  ImplementRunArtifact,
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  ResolutionAction,
  FindingsArtifact,
  ImplementerResult,
  VerificationScript,
} from './interfaces';
import { extractSummary, slugify } from './utils';
import { ConfigurationError, GitError, ValidationError } from '../shared/utils/errors';
import { formatBackendSelection, writeImplementVerificationRunFile } from '../shared/utils/implement-verification';
import { getWfStateDir } from '../shared/utils/wf-paths';
import * as fs from 'fs';
import * as path from 'path';
import type { NormalizedVerificationConditionsConfig } from '../config/wf-config-loader';
import { loadVerificationManifest, type VerificationStep } from '../shared/utils/verification-manifest';
import { AnthropicAgentAdapter } from '../integrations/ai/adapters/anthropic-agent.adapter';
import { OpenAIAgentAdapter } from '../integrations/ai/adapters/openai-agent.adapter';
import { ClaudeCliAdapter } from '../integrations/ai/adapters/claude-cli.adapter';
import { CodexCliAdapter } from '../integrations/ai/adapters/codex-cli.adapter';
import inquirer from 'inquirer';

const DEFAULT_PREFIX_MAPPING: Record<ResolutionAction, string> = {
  feature: 'feature',
  fix: 'bugfix',
  investigate: 'chore',
};

@Injectable()
export class ImplementerAgent {
  constructor(
    private configService: ConfigService,
    private gitService: GitService,
    private aiService: AiService
  ) {}

  /**
   * Executes the implementation plan for the given ticket.
   * Generates a branch name, then delegates the entire generate-and-verify loop
   * to the appropriate agent adapter (Anthropic or OpenAI).
   *
   * For investigate actions, calls the AI to generate structured findings
   * and saves a findings artifact instead.
   *
   * @param ticket - The fetched ticket artifact containing key and content
   * @param planArtifact - The generated plan artifact with steps and metadata
   * @param options - Implementation options; `additionalRepoDirs` threads sibling
   *   repo paths as read-only context (writes stay scoped to `repoDir`)
   * @returns An ImplementerResult: either an implementation with branchName or an investigation artifact
   */
  async execute(
    ticket: TicketArtifact,
    planArtifact: PlanArtifact,
    options: ImplementerOptions
  ): Promise<ImplementerResult> {
    if (planArtifact.action === 'investigate') {
      return this.executeInvestigation(ticket, planArtifact);
    }

    if (!options.suppressHeader) {
      console.log(chalk.bold.yellow('\n🔧 STAGE 3: Implementation Guide'));
      console.log(chalk.gray('─'.repeat(70)));
    }

    this.validateImplementationScope(planArtifact, options.repoDir, options.allowMultiRepoScope);

    const branchName = await this.handleBranchWorkflow(ticket, planArtifact, options);

    console.log(chalk.bold('\n  Steps:'));
    planArtifact.plan.steps.forEach((step: string, i: number) => {
      console.log(chalk.cyan(`    ${i + 1}. ${step}`));
    });

    // Generate and write code changes for files belonging to this repo
    const repoName = options.repoDir ? path.basename(options.repoDir) : '';
    const normalizedAffected = normalizeFileEntries(planArtifact.plan.affectedFiles ?? []);
    const allFiles = normalizedAffected.filter(entry => entry.status !== 'not-found').map(entry => entry.filePath);

    // Primary: files explicitly prefixed with this repo's name.
    let repoFiles = repoName ? allFiles.filter(f => f.startsWith(`${repoName}/`)) : allFiles;

    // Fallback: plan was generated without repo-name prefixes (older format or
    // AI non-compliance). Safe to apply only when NO file in the plan carries ANY
    // known repo prefix — if some files are prefixed and this repo's aren't, the
    // empty result is intentional and we must not override it.
    if (repoFiles.length === 0 && allFiles.length > 0) {
      const planRepos = planArtifact.plan.affectedRepositories ?? [];
      const hasAnyRepoPrefix = allFiles.some(f => planRepos.some(repo => f.startsWith(`${repo}/`)));
      if (!hasAnyRepoPrefix && (planRepos.includes(repoName) || planRepos.length === 0)) {
        repoFiles = allFiles;
        if (repoName) {
          console.log(
            chalk.yellow(
              `  ⚠️ affectedFiles lacks "${repoName}/" prefix — treating all paths as relative to ${repoName}`
            )
          );
        }
      }
    }

    // Derive context files (read-only references) from affectedFilesContext
    const normalizedContext = normalizeFileEntries(planArtifact.plan.affectedFilesContext ?? []);
    const allContextPaths = normalizedContext
      .filter(entry => entry.status !== 'not-found')
      .map(entry => entry.filePath);
    let contextFiles = repoName ? allContextPaths.filter(f => f.startsWith(`${repoName}/`)) : allContextPaths;
    // Unprefixed fallback — same logic as repoFiles
    if (contextFiles.length === 0 && allContextPaths.length > 0) {
      const planRepos = planArtifact.plan.affectedRepositories ?? [];
      const hasAnyRepoPrefix = allContextPaths.some(f => planRepos.some(repo => f.startsWith(`${repo}/`)));
      if (!hasAnyRepoPrefix && (planRepos.includes(repoName) || planRepos.length === 0)) {
        contextFiles = allContextPaths;
      }
    }
    // Silent dedup: remove context files already in repoFiles
    const repoFilesSet = new Set(repoFiles);
    contextFiles = contextFiles.filter(f => !repoFilesSet.has(f));

    // Remove nonexistent context files — they are read-only, so they must exist.
    const repoDir = options.repoDir ?? process.cwd();
    const phantomContextPaths: string[] = [];
    contextFiles = contextFiles.filter(filePath => {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`) ? filePath.slice(repoName.length + 1) : filePath;
      const fullPath = path.join(repoDir, relativePath);
      if (!fs.existsSync(fullPath)) {
        phantomContextPaths.push(filePath);
        return false;
      }
      return true;
    });
    if (phantomContextPaths.length > 0) {
      console.log(chalk.yellow(`  ⚠️ Removed ${phantomContextPaths.length} nonexistent context file(s):`));
      for (const p of phantomContextPaths) {
        console.log(chalk.yellow(`      - ${p}`));
      }
    }

    // Filesystem existence check: verify each planned file against disk.
    // Entries marked to-create are kept (new files). Entries that claim found
    // but don't exist on disk are removed with a warning — the planner likely
    // hallucinated the path. Legacy string entries default to found, so they
    // are also checked.
    const statusByPath = new Map(normalizedAffected.map(e => [e.filePath, e.status]));
    const phantomPaths: string[] = [];
    repoFiles = repoFiles.filter(filePath => {
      const status = statusByPath.get(filePath) ?? 'found';
      if (status === 'to-create') return true;
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`) ? filePath.slice(repoName.length + 1) : filePath;
      const fullPath = path.join(repoDir, relativePath);
      if (!fs.existsSync(fullPath)) {
        phantomPaths.push(filePath);
        return false;
      }
      return true;
    });
    if (phantomPaths.length > 0) {
      console.log(
        chalk.yellow(`  ⚠️ Removed ${phantomPaths.length} nonexistent path(s) from repoFiles (planner hallucination):`)
      );
      for (const p of phantomPaths) {
        console.log(chalk.yellow(`      - ${p}`));
      }
    }

    if (repoFiles.length === 0) {
      console.log(
        chalk.yellow(
          '  ⚠️ No planned files to implement — the agent will be fully self-directed with no continuation passes.'
        )
      );
    }

    const verificationConditions = this.getVerificationConditionsConfig();
    const verificationScripts = this.prepareVerificationScripts(
      options.repoDir,
      verificationConditions,
      planArtifact.plan.verification
    );
    const rawTrackedFilePaths = this.resolveTrackedFilePaths(repoFiles, repoName, options.repoDir);
    const { kept: trackedFilePaths, keptIndices } = await this.validateTrackedFilePaths(
      rawTrackedFilePaths,
      options.repoDir
    );
    // Align repoFiles with the validated tracked paths so adapter continuation
    // loops don't chase gitignored entries that can never be committed.
    if (keptIndices.length < repoFiles.length) {
      repoFiles = keptIndices.map(i => repoFiles[i]);
    }
    const ticketContext = ticket.content;

    const backendSelection = this.resolveImplementBackendSelection();
    console.log(chalk.cyan(`  ${formatBackendSelection(backendSelection)}`));

    const verificationRunFilePath = this.getImplementVerificationRunPath(ticket.ticketKey, options.repoDir);
    this.writeImplementVerificationRunArtifact(verificationRunFilePath, {
      ticketKey: ticket.ticketKey,
      repoDir: options.repoDir ?? process.cwd(),
      backendConfigured: backendSelection.configured,
      backendSelected: backendSelection.selected,
      provider: backendSelection.provider,
      verificationScripts: verificationScripts.map(({ id, command }) => ({
        id,
        command,
      })),
      startedAt: new Date().toISOString(),
    });

    const adapter = (() => {
      if (backendSelection.selected === 'claude-cli') return new ClaudeCliAdapter(this.configService);
      if (backendSelection.selected === 'codex-cli') return new CodexCliAdapter(this.configService);
      if (backendSelection.selected === 'openai-agent') return new OpenAIAgentAdapter(this.configService);
      return new AnthropicAgentAdapter(this.configService);
    })();
    const backendResult = await adapter.generateAndVerify({
      ticket,
      planArtifact,
      options,
      verificationScripts,
      ticketContext,
      repoFiles,
      contextFiles,
      repoName,
      trackedFilePaths,
    });

    if ((planArtifact.plan.affectedRepositories?.length ?? 0) > 0) {
      console.log(chalk.bold('\n  Repositories affected:'));
      planArtifact.plan.affectedRepositories!.forEach((repo: string) => console.log(chalk.gray(`    - ${repo}`)));
    }

    console.log(chalk.bold('\n  Status:'));
    console.log(chalk.cyan('    Changes generated, verified, and written to disk'));
    console.log(chalk.cyan('    issue:implement completed for the selected repository'));

    return { type: 'implementation', branchName, sessionId: backendResult.sessionId };
  }

  /**
   * Ensures issue:implement only operates on the selected repository.
   *
   * @param planArtifact - Plan metadata including files/repositories affected
   * @param repoDir - Selected repository directory
   * @returns Nothing; throws when the plan crosses repo boundaries
   */
  private validateImplementationScope(
    planArtifact: PlanArtifact,
    repoDir?: string,
    allowMultiRepoScope?: boolean
  ): void {
    const repoName = repoDir ? path.basename(repoDir) : '';
    const affectedRepositories = [...new Set(planArtifact.plan.affectedRepositories ?? [])];
    if (affectedRepositories.length > 1 && !allowMultiRepoScope) {
      throw new ValidationError(
        `issue:implement only verifies a single repository. This plan affects multiple repositories: ${affectedRepositories.join(', ')}. Use wf issue or run wf issue:implement separately per repository.`
      );
    }

    if (allowMultiRepoScope) {
      return;
    }

    if (!repoName) {
      return;
    }

    const localPathPrefixes = new Set([
      'src',
      'test',
      'tests',
      'apps',
      'libs',
      'docs',
      'scripts',
      'config',
      'bin',
      'dist',
      '.github',
      '.husky',
      '.changeset',
      'package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'README.md',
    ]);
    const normalizedPaths = normalizeFileEntries(planArtifact.plan.affectedFiles ?? []);
    const offendingPaths = normalizedPaths.filter(entry => {
      const [prefix] = entry.filePath.split('/');
      return prefix !== repoName && !localPathPrefixes.has(prefix);
    });
    if (offendingPaths.length > 0) {
      throw new ValidationError(
        `issue:implement can only modify and verify files for ${repoName}. Found paths for other repositories: ${offendingPaths.map(e => e.filePath).join(', ')}. Use wf issue or run wf issue:implement separately per repository.`
      );
    }
  }

  /**
   * Loads the normalized implement-stage verification configuration.
   *
   * @returns Configured verification conditions, if any
   */
  private getVerificationConditionsConfig(): NormalizedVerificationConditionsConfig | undefined {
    return this.configService.get<NormalizedVerificationConditionsConfig | undefined>(
      'stages.implement.verificationConditions'
    );
  }

  /**
   * Resolves the absolute file paths tracked for verification rewrite detection.
   *
   * @param repoFiles - Files assigned to the current repository
   * @param repoName - Repository name prefix
   * @param repoDir - Repository directory
   * @returns Absolute file paths for tracked files
   */
  private resolveTrackedFilePaths(repoFiles: string[], repoName: string, repoDir?: string): string[] {
    return repoFiles.map(filePath => {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`) ? filePath.slice(repoName.length + 1) : filePath;

      return repoDir ? path.join(repoDir, relativePath) : path.resolve(relativePath);
    });
  }

  /**
   * Filters tracked file paths by removing gitignored entries and logging
   * a diagnostic breakdown (existing, new, ignored) so operators can spot
   * when the planner fabricated paths.
   *
   * @param trackedPaths - Absolute paths resolved from the plan
   * @param repoDir - Repository root used for the git check-ignore call
   * @returns Filtered paths and their original indices for parallel array alignment
   */
  private async validateTrackedFilePaths(
    trackedPaths: string[],
    repoDir?: string
  ): Promise<{ kept: string[]; keptIndices: number[] }> {
    if (trackedPaths.length === 0) {
      return { kept: [], keptIndices: [] };
    }

    const ignoredSet = new Set(await this.gitService.checkIgnored(trackedPaths, repoDir));

    const kept: string[] = [];
    const keptIndices: number[] = [];
    const existing: string[] = [];
    const created: string[] = [];
    const ignored: string[] = [];

    for (let i = 0; i < trackedPaths.length; i++) {
      const filePath = trackedPaths[i];
      if (ignoredSet.has(filePath)) {
        ignored.push(filePath);
        continue;
      }
      kept.push(filePath);
      keptIndices.push(i);
      if (fs.existsSync(filePath)) {
        existing.push(filePath);
      } else {
        created.push(filePath);
      }
    }

    if (ignored.length > 0) {
      console.log(chalk.yellow(`  ⚠️ Dropped ${ignored.length} gitignored path(s) from tracked files:`));
      for (const p of ignored) {
        console.log(chalk.yellow(`      - ${p}`));
      }
    }

    if (existing.length > 0 || created.length > 0) {
      console.log(chalk.gray(`  Tracked files: ${existing.length} existing, ${created.length} new`));
    }

    return { kept, keptIndices };
  }

  /**
   * Reads package.json scripts for alias reporting when available.
   *
   * @param repoDir - Repository directory to inspect
   * @returns package.json script mappings, or an empty object when unavailable
   */
  private readPackageScripts(repoDir?: string): Record<string, string> {
    const packageJsonPath = path.join(repoDir ?? process.cwd(), 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return {};
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { scripts?: Record<string, string> };
      return packageJson.scripts ?? {};
    } catch {
      console.log(
        chalk.yellow(`  ⚠️ Unable to parse ${packageJsonPath}; continuing without package.json alias discovery.`)
      );
      return {};
    }
  }

  /**
   * Builds the verification script list and resolves package.json aliases when possible.
   *
   * @param repoDir - Repository directory used for package.json alias discovery
   * @param verificationConditions - Normalized verification conditions config
   * @returns Ordered verification scripts
   */
  private prepareVerificationScripts(
    repoDir: string | undefined,
    verificationConditions: NormalizedVerificationConditionsConfig | undefined,
    planVerification?: PlanArtifact['plan']['verification']
  ): VerificationScript[] {
    const packageScripts = this.readPackageScripts(repoDir);
    const baselineSteps = this.resolveBaselineVerificationSteps(repoDir, verificationConditions);
    const waiverIds = new Set((planVerification?.waivers ?? []).map(waiver => waiver.id));
    const targetedSteps = planVerification?.targeted ?? [];
    const resolvedSteps = [...baselineSteps, ...targetedSteps].filter(step => !waiverIds.has(step.id));

    return resolvedSteps.map(step => {
      const normalizedCommand = this.normalizeVerificationCommand(step.run, repoDir);

      return {
        id: step.id,
        name: step.id,
        command: normalizedCommand,
        policy: step.policy,
        reason: step.reason,
        aliases: this.findPackageAliases(normalizedCommand, packageScripts),
      };
    });
  }

  private normalizeVerificationCommand(command: string, repoDir: string | undefined): string {
    const trimmed = command.trim();
    if (!repoDir) {
      return trimmed;
    }

    const cdPrefixMatch = trimmed.match(/^cd\s+(.+?)\s*&&\s*(.+)$/);
    if (!cdPrefixMatch) {
      return trimmed;
    }

    const [, rawTarget, remainder] = cdPrefixMatch;
    const target = rawTarget.trim().replace(/^['"]|['"]$/g, '');
    const normalizedRepoDir = path.resolve(repoDir);
    const repoName = path.basename(normalizedRepoDir);
    const normalizedRelativeTarget =
      target === repoName || target === `./${repoName}` ? normalizedRepoDir : path.resolve(repoDir, target);
    const normalizedAbsoluteTarget = path.resolve(target);

    if (normalizedRelativeTarget === normalizedRepoDir || normalizedAbsoluteTarget === normalizedRepoDir) {
      return remainder.trim();
    }

    return trimmed;
  }

  private resolveBaselineVerificationSteps(
    repoDir: string | undefined,
    verificationConditions: NormalizedVerificationConditionsConfig | undefined
  ): VerificationStep[] {
    const manifestPath = this.resolveVerificationManifestPath(repoDir, verificationConditions);

    if (manifestPath) {
      return loadVerificationManifest(manifestPath, 'implement').baseline;
    }

    if (!verificationConditions) {
      return [];
    }

    return Object.entries(verificationConditions.scripts).map(([name, command]) => ({
      id: name,
      run: command,
      policy: 'enforced',
    }));
  }

  private resolveVerificationManifestPath(
    repoDir: string | undefined,
    verificationConditions: NormalizedVerificationConditionsConfig | undefined
  ): string | undefined {
    const baseDir = repoDir ?? process.cwd();
    const configuredPath = verificationConditions?.policyFile;
    if (configuredPath) {
      return path.isAbsolute(configuredPath) ? configuredPath : path.join(baseDir, configuredPath);
    }

    const defaultPath = path.join(baseDir, '.wf', 'verification.json');
    return fs.existsSync(defaultPath) ? defaultPath : undefined;
  }

  /**
   * Resolves package.json aliases for a configured verification command.
   *
   * @param command - Configured hook command
   * @param packageScripts - package.json scripts map
   * @returns Matching package.json aliases
   */
  private findPackageAliases(command: string, packageScripts: Record<string, string>): string[] {
    const aliases = new Set<string>();
    const directScriptMatch = command.match(/^(?:npm run|pnpm|yarn|nr)\s+([A-Za-z0-9:_-]+)$/);

    if (directScriptMatch) {
      const [, scriptName] = directScriptMatch;
      if (packageScripts[scriptName]) {
        aliases.add(scriptName);
      }
    }

    for (const [scriptName, scriptCommand] of Object.entries(packageScripts)) {
      if (scriptCommand === command) {
        aliases.add(scriptName);
      }
    }

    return [...aliases];
  }

  /**
   * Resolves which implementation backend should run for the current config.
   *
   * @returns Selected backend plus the provider
   */
  private resolveImplementBackendSelection(): ImplementBackendSelection {
    const provider =
      this.configService.get<string>('stages.implement.provider') ??
      this.configService.get<string>('ai.provider', 'anthropic');
    const backend = this.configService.get<string>('stages.implement.backend', 'agent');

    if (backend === 'standard') {
      throw new ConfigurationError('Implement stage does not support backend "standard". Use "agent" or "cli".');
    }

    if (backend === 'cli') {
      if (provider === 'openai') {
        return { configured: 'codex-cli', selected: 'codex-cli', provider };
      }
      if (provider !== 'anthropic') {
        throw new ConfigurationError(
          `Implement stage backend "cli" requires provider "anthropic" or "openai". Got "${provider}".`
        );
      }
      return { configured: 'claude-cli', selected: 'claude-cli', provider };
    }

    if (provider === 'anthropic') {
      return {
        configured: 'anthropic-agent',
        selected: 'anthropic-agent',
        provider,
      };
    }

    if (provider === 'openai') {
      return {
        configured: 'openai-agent',
        selected: 'openai-agent',
        provider,
      };
    }

    throw new ConfigurationError(`Implement stage requires provider "anthropic" or "openai". Got "${provider}".`);
  }

  /**
   * Builds the filesystem path for the current implementation verification run.
   *
   * @param ticketKey - Ticket identifier used to scope the persisted run
   * @param repoDir - Selected repository directory, used for namespacing
   * @returns Absolute path to the persisted verification run file
   */
  private getImplementVerificationRunPath(ticketKey: string, repoDir?: string): string {
    const stateDirectory = getWfStateDir();
    const repoName = repoDir ? path.basename(repoDir) : 'repo';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    return path.join(stateDirectory, 'implement-verification', repoName, `${ticketKey}-${timestamp}.json`);
  }

  /**
   * Writes the initial run artifact and ensures its directory exists.
   *
   * @param filePath - Destination path for the run artifact
   * @param run - Run metadata to persist before generation starts
   * @returns Nothing
   */
  private writeImplementVerificationRunArtifact(filePath: string, run: ImplementRunArtifact): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeImplementVerificationRunFile(filePath, run);
  }

  private async executeInvestigation(ticket: TicketArtifact, planArtifact: PlanArtifact): Promise<ImplementerResult> {
    console.log(chalk.bold.yellow('\n🔍 STAGE 3: Investigation Findings'));
    console.log(chalk.gray('─'.repeat(70)));
    console.log(chalk.gray('  Generating findings and recommendations...'));

    const findings = await this.aiService.generateFindings(planArtifact.plan, ticket.content);

    const findingsPath = planArtifact.path.replace('.json', '-findings-and-recommendations.json');

    fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
    fs.writeFileSync(findingsPath, JSON.stringify(findings, null, 2), 'utf-8');

    const artifact: FindingsArtifact = { ...findings, path: findingsPath };

    console.log(chalk.green('\n✓ Investigation complete'));
    console.log(chalk.bold('  Summary:'), chalk.bold.cyan(artifact.summary));

    if (artifact.findings.length > 0) {
      console.log(chalk.bold('\n  Findings:'));
      artifact.findings.forEach((f, i) => console.log(chalk.cyan(`    ${i + 1}. ${f}`)));
    }

    if (artifact.recommendations.length > 0) {
      console.log(chalk.bold('\n  Recommendations:'));
      artifact.recommendations.forEach((r, i) => console.log(chalk.cyan(`    ${i + 1}. ${r}`)));
    }

    console.log(chalk.bold('\n  Conclusion:'));
    console.log(chalk.cyan(`    ${artifact.conclusion}`));
    console.log(chalk.gray(`\n  Saved to: ${findingsPath}`));

    return { type: 'investigation', artifact };
  }

  /**
   * Orchestrates the full branch creation workflow: dirty-tree check, source
   * branch selection, pull, and branch creation with interactive or silent
   * fallback behavior.
   *
   * @param ticket - Ticket artifact for branch name generation
   * @param planArtifact - Plan artifact with action and metadata
   * @param options - Implementation options including silent/noBranch flags
   * @returns The created branch name, or null when --no-branch was used
   */
  private async handleBranchWorkflow(
    ticket: TicketArtifact,
    planArtifact: PlanArtifact,
    options: ImplementerOptions
  ): Promise<string | null> {
    const cwd = options.repoDir;
    const interactive = !options.silent && this.isInteractiveSession();

    const { didStash } = await this.ensureCleanWorkingTree(planArtifact, options, interactive, cwd);

    console.log(chalk.gray('  Detecting source branches...'));
    const branchInfo = await this.gitService.getBranchInfo(cwd);
    const devBranches = this.gitService.detectDevelopmentBranches(branchInfo.all);
    const mainBranch = this.gitService.detectMainBranch(branchInfo.all);

    const sourceBranch = await this.resolveSourceBranch({ branchInfo, devBranches, mainBranch, interactive, cwd });

    await this.pullLatestFromSource(sourceBranch, branchInfo, cwd);
    await this.restoreStash(didStash, cwd);

    const generatedName = this.generateBranchNameForTicket(ticket, planArtifact, options);
    const branchName = await this.promptBranchName({
      generatedName,
      sourceBranch,
      noBranch: options.noBranch,
      interactive,
    });
    if (branchName === null) {
      return null;
    }

    const currentBranch = await this.gitService.getCurrentBranch(cwd).catch(() => '');
    if (currentBranch === branchName) {
      console.log(chalk.green(`  Already on branch: ${branchName}`));
      return branchName;
    }
    await this.gitService.createBranch(branchName, sourceBranch, cwd);
    console.log(chalk.green(`  Created branch: ${branchName} from ${sourceBranch}`));
    return branchName;
  }

  private async ensureCleanWorkingTree(
    planArtifact: PlanArtifact,
    options: ImplementerOptions,
    interactive: boolean,
    cwd: string | undefined
  ): Promise<{ didStash: boolean }> {
    console.log(chalk.gray('  Checking working tree status...'));
    const status = await this.gitService.getStatus(cwd);

    if (status.conflicted.length > 0) {
      throw new GitError(
        `Working tree has unresolved merge conflicts: ${status.conflicted.join(', ')}. Resolve them before running implement.`
      );
    }

    const hasTrackedChanges =
      status.modified.length > 0 || status.staged.length > 0 || status.deleted.length > 0 || status.renamed.length > 0;

    if (!hasTrackedChanges) {
      console.log(chalk.green('  Working tree is clean'));
      return { didStash: false };
    }

    const stashMessage = path.basename(planArtifact.path) || 'wf-auto-stash';

    if (interactive) {
      const { shouldStash } = await inquirer.prompt<{
        shouldStash: boolean;
      }>([
        {
          type: 'confirm',
          name: 'shouldStash',
          message: 'Working tree has uncommitted changes. Stash and continue?',
          prefix: ' ',
          default: true,
        },
      ]);
      if (!shouldStash) {
        throw new GitError('Aborted: working tree has uncommitted changes. Commit or stash them first.');
      }
    }

    console.log(chalk.yellow(`  Working tree has uncommitted changes — stashing (${stashMessage})...`));
    await this.gitService.stashChanges(stashMessage, cwd);
    return { didStash: true };
  }

  private async resolveSourceBranch(params: {
    branchInfo: BranchInfo;
    devBranches: string[];
    mainBranch: string | undefined;
    interactive: boolean;
    cwd: string | undefined;
  }): Promise<string> {
    const { branchInfo, devBranches, mainBranch, interactive, cwd } = params;
    const isRemote = (b: string): boolean => b.startsWith('remotes/') || b.startsWith('origin/');
    const formatBranchChoice = (b: string): { name: string; value: string } =>
      isRemote(b) ? { name: chalk.gray(b), value: b } : { name: chalk.cyan(b), value: b };
    const logSource = async (b: string): Promise<string> => {
      const branchColor = isRemote(b) ? chalk.gray : chalk.cyan;
      const hasUpstream = isRemote(b) ? true : await this.gitService.hasUpstream(b, cwd);
      console.log(chalk.cyan(`  Source branch: ${branchColor(b)}${hasUpstream ? ' (has upstream)' : ''}`));
      return b;
    };

    if (devBranches.length === 1) {
      return logSource(devBranches[0]);
    }

    if (devBranches.length > 1 && interactive) {
      const choices = [...devBranches.map(formatBranchChoice), ...(mainBranch ? [formatBranchChoice(mainBranch)] : [])];
      const { selected } = await inquirer.prompt<{ selected: string }>([
        {
          type: 'list',
          name: 'selected',
          message: 'Multiple dev branches found. Select source branch:',
          prefix: ' ',
          choices,
          default: devBranches[0],
        },
      ]);
      return logSource(selected);
    }

    if (devBranches.length > 1) {
      return logSource(devBranches[0]);
    }

    if (mainBranch) {
      return logSource(mainBranch);
    }

    const fallback = branchInfo.current;
    console.log(chalk.yellow(`  No dev or main branch detected — using current branch: ${fallback}`));
    return fallback;
  }

  private async pullLatestFromSource(
    sourceBranch: string,
    branchInfo: BranchInfo,
    cwd: string | undefined
  ): Promise<void> {
    const isRemote = (b: string): boolean => b.startsWith('remotes/') || b.startsWith('origin/');

    if (isRemote(sourceBranch)) {
      console.log(chalk.gray(`  Skipping pull — ${sourceBranch} is a remote tracking ref`));
      return;
    }

    if (branchInfo.current !== sourceBranch) {
      await this.gitService.checkoutBranch(sourceBranch, cwd);
    }
    try {
      console.log(chalk.gray(`  Pulling latest from origin/${sourceBranch}...`));
      await this.gitService.pull('origin', sourceBranch, cwd);
    } catch {
      console.log(
        chalk.yellow(`  Could not pull ${sourceBranch} (no upstream or network issue) — continuing with local state`)
      );
    }
  }

  private async restoreStash(didStash: boolean, cwd: string | undefined): Promise<void> {
    if (!didStash) {
      return;
    }

    try {
      await this.gitService.stashPop(cwd);
    } catch {
      console.log(
        chalk.yellow(
          '  Stash pop encountered conflicts. Your changes are in stash@{0} — resolve manually after implementation.'
        )
      );
    }
  }

  /**
   * @param ticket - Ticket artifact for branch name derivation
   * @param planArtifact - Plan artifact with resolution action
   * @param options - Implementation options with slug/pattern overrides
   * @returns Generated branch name string
   */
  private generateBranchNameForTicket(
    ticket: TicketArtifact,
    planArtifact: PlanArtifact,
    options: ImplementerOptions
  ): string {
    const summary = extractSummary(ticket.content);
    if (options.customBranchSlug) {
      return this.generateCustomBranchName(options.customBranchSlug, planArtifact.action);
    }
    return this.generateBranchName(
      ticket.ticketKey,
      summary,
      planArtifact.action,
      options.trackerName,
      options.branchNamePattern
    );
  }

  private async promptBranchName(params: {
    generatedName: string;
    sourceBranch: string;
    noBranch?: boolean;
    interactive: boolean;
  }): Promise<string | null> {
    const { generatedName, sourceBranch, noBranch, interactive } = params;

    if (noBranch) {
      console.log(chalk.cyan(`  Staying on ${sourceBranch} (--no-branch)`));
      return null;
    }

    if (!interactive) {
      return generatedName;
    }

    const { choice } = await inquirer.prompt<{ choice: string }>([
      {
        type: 'list',
        name: 'choice',
        message: 'Branch name:',
        prefix: ' ',
        choices: [
          { name: generatedName, value: 'accept' },
          { name: 'Edit branch name', value: 'edit' },
          { name: 'Skip (stay on current branch)', value: 'skip' },
        ],
        default: 'accept',
      },
    ]);

    if (choice === 'skip') {
      console.log(chalk.cyan(`  Staying on ${sourceBranch}`));
      return null;
    }

    if (choice === 'edit') {
      const { customName } = await inquirer.prompt<{
        customName: string;
      }>([
        {
          type: 'input',
          name: 'customName',
          message: 'Enter branch name:',
          prefix: ' ',
          default: generatedName,
        },
      ]);
      return customName;
    }

    return generatedName;
  }

  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  private generateBranchName(
    ticketKey: string,
    summary: string,
    action: ResolutionAction,
    trackerName: string,
    patternOverride?: string
  ): string {
    const prefixMapping = this.configService.get<Record<ResolutionAction, string>>(
      'git.branchPrefixMapping',
      DEFAULT_PREFIX_MAPPING
    );
    const prefix = prefixMapping[action] || 'feature';

    // Atlassian platforms (jira, bitbucket) use uppercase ticket keys
    const isAtlassian = trackerName === 'jira' || trackerName === 'bitbucket';
    const formattedKey = isAtlassian ? ticketKey.toUpperCase() : ticketKey;

    const branchName = `${prefix}/${formattedKey}__${slugify(summary)}`;

    // Validate against branch pattern
    const pattern = patternOverride ?? this.configService.get<string>('git.branchNamePattern');
    if (pattern) {
      try {
        if (!new RegExp(pattern).test(branchName)) {
          console.log(chalk.yellow(`  Generated branch name "${branchName}" does not match pattern: ${pattern}`));
        }
      } catch {
        console.log(chalk.yellow(`  Invalid branch pattern in config (git.branchNamePattern): ${pattern}`));
      }
    }

    return branchName;
  }

  private generateCustomBranchName(artifactStem: string, action: ResolutionAction): string {
    const prefixMapping = this.configService.get<Record<ResolutionAction, string>>(
      'git.branchPrefixMapping',
      DEFAULT_PREFIX_MAPPING
    );
    const prefix = prefixMapping[action] || 'feature';

    return `${prefix}/${slugify(artifactStem)}`;
  }
}
