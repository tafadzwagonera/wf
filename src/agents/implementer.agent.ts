import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { GitService } from '../integrations/git/git.service';
import type { BranchInfo } from '../shared/types/git.types';
import { AiService, normalizeFileEntries } from '../integrations/ai/ai.service';
import {
  ImplementBackendSelection,
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  ResolutionAction,
  FindingsArtifact,
  ImplementerResult,
  VerificationScript,
} from './interfaces';
import { extractSummary, slugify, truncateSlug, MAX_BRANCH_NAME_LENGTH } from './utils';
import { ConfigurationError, GitError, ValidationError } from '../shared/utils/errors';
import { formatBackendSelection, writeImplementVerificationRunFile } from '../shared/utils/implement-verification';
import { getWfStateDir } from '../shared/utils/wf-paths';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NormalizedVerificationConditionsConfig } from '../config/wf-config-loader';
import { loadVerificationManifest, mergeVerificationSteps, type VerificationStep } from '../shared/utils/verification-manifest';
import { AnthropicAgentAdapter } from '../integrations/ai/adapters/anthropic-agent.adapter';
import { OpenAIAgentAdapter } from '../integrations/ai/adapters/openai-agent.adapter';
import { ClaudeCliAdapter } from '../integrations/ai/adapters/claude-cli.adapter';
import { CodexCliAdapter } from '../integrations/ai/adapters/codex-cli.adapter';
import inquirer from 'inquirer';

interface FileResolution {
  repoName: string;
  repoDir: string;
  repoFiles: string[];
  contextFiles: string[];
}

type NormalizedEntry = ReturnType<typeof normalizeFileEntries>[number];

const DEFAULT_PREFIX_MAPPING: Record<ResolutionAction, string> = {
  feature: 'feature',
  fix: 'bugfix',
  investigate: 'chore',
};

@Injectable()
export class ImplementerAgent {
  constructor(
    private readonly configService: ConfigService,
    private readonly gitService: GitService,
    private readonly aiService: AiService
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

    const resolved = this.resolveFiles(planArtifact, options);
    const filteredSteps = this.filterStepsForRepo(planArtifact.plan.steps, resolved.repoFiles, resolved.repoName);
    this.logPlanSteps(filteredSteps);
    const scopedPlan = { ...planArtifact, plan: { ...planArtifact.plan, steps: filteredSteps } };
    return this.runBackend(ticket, scopedPlan, options, branchName, resolved);
  }

  private logPlanSteps(steps: string[]): void {
    console.log(chalk.bold('\n  Steps:'));
    for (const [i, step] of steps.entries()) {
      console.log(chalk.cyan(`    ${i + 1}. ${step}`));
    }
  }

  private resolveFiles(planArtifact: PlanArtifact, options: ImplementerOptions): FileResolution {
    const repoName = options.repoDir ? path.basename(options.repoDir) : '';
    const repoDir = options.repoDir ?? process.cwd();
    const repoFiles = this.resolveRepoFiles(planArtifact, repoName, repoDir);
    const contextFiles = this.resolveContextFiles(planArtifact, repoName, repoDir, repoFiles);
    return { repoName, repoDir, repoFiles, contextFiles };
  }

  /**
   * Filters plan steps to only those relevant to the given repo.
   * Steps that reference another repo's prefixed paths are excluded.
   * Generic steps (no repo-prefixed path) are always included.
   * @param steps - All plan steps from the plan artifact.
   * @param repoFiles - Resolved file paths for this repo (may include repo-name prefix).
   * @param repoName - The basename of the current repo directory.
   * @returns Filtered steps relevant to this repo.
   */
  private filterStepsForRepo(steps: string[], repoFiles: string[], repoName: string): string[] {
    if (!repoName || repoFiles.length === 0) return steps;

    const strippedPaths = repoFiles.map(f =>
      f.startsWith(`${repoName}/`) ? f.slice(repoName.length + 1) : f,
    );

    const repoPathPattern = /\b[\w-]+\/(?:src|test|lib|app)\//i;

    return steps.filter(step => {
      const referencesThisRepo = strippedPaths.some(p => step.includes(p));
      const referencesAnyRepo = repoPathPattern.exec(step) !== null;
      return referencesThisRepo || !referencesAnyRepo;
    });
  }

  private async runBackend(
    ticket: TicketArtifact,
    planArtifact: PlanArtifact,
    options: ImplementerOptions,
    branchName: string | null,
    resolved: FileResolution
  ): Promise<ImplementerResult> {
    const { repoName, contextFiles } = resolved;
    const verificationScripts = this.buildVerificationScripts(options.repoDir, planArtifact);
    const tracked = await this.alignTrackedFiles(resolved.repoFiles, repoName, options.repoDir);

    const backendSelection = this.resolveImplementBackendSelection();
    console.log(chalk.cyan(`  ${formatBackendSelection(backendSelection)}`));
    this.writeRunArtifact(ticket, options, backendSelection, verificationScripts);

    const result = await this.createAdapter(backendSelection).generateAndVerify({
      ticket, planArtifact, options, verificationScripts,
      ticketContext: ticket.content, contextFiles, repoName, ...tracked,
    });

    this.logCompletionStatus(planArtifact);
    return { type: 'implementation', branchName, sessionId: result.sessionId, verificationOutcomes: result.verificationOutcomes };
  }

  private async alignTrackedFiles(
    repoFiles: string[],
    repoName: string,
    optionsRepoDir?: string
  ): Promise<{ repoFiles: string[]; trackedFilePaths: string[] }> {
    const rawTracked = this.resolveTrackedFilePaths(repoFiles, repoName, optionsRepoDir);
    const { kept, keptIndices } = await this.validateTrackedFilePaths(rawTracked, optionsRepoDir);
    const aligned = keptIndices.length < repoFiles.length
      ? keptIndices.map(i => repoFiles[i])
      : repoFiles;
    return { repoFiles: aligned, trackedFilePaths: kept };
  }

  private logCompletionStatus(planArtifact: PlanArtifact): void {
    if ((planArtifact.plan.affectedRepositories?.length ?? 0) > 0) {
      console.log(chalk.bold('\n  Repositories affected:'));
      for (const repo of planArtifact.plan.affectedRepositories ?? []) {
        console.log(chalk.gray(`    - ${repo}`));
      }
    }
    console.log(chalk.bold('\n  Status:'));
    console.log(chalk.cyan('    Changes generated, verified, and written to disk'));
    console.log(chalk.cyan('    issue:implement completed for the selected repository'));
  }

  private resolveRepoFiles(planArtifact: PlanArtifact, repoName: string, repoDir: string): string[] {
    const normalizedAffected = normalizeFileEntries(planArtifact.plan.affectedFiles ?? []);
    const allFiles = normalizedAffected.filter(e => e.status !== 'not-found').map(e => e.filePath);
    let repoFiles = repoName ? allFiles.filter(f => f.startsWith(`${repoName}/`)) : allFiles;

    repoFiles = this.applyUnprefixedFallback(repoFiles, allFiles, planArtifact, repoName);
    repoFiles = this.filterPhantomRepoFiles(repoFiles, normalizedAffected, repoName, repoDir);
    if (repoFiles.length === 0) {
      console.log(chalk.yellow(
        '  ⚠️ No planned files to implement — the agent will be fully self-directed with no continuation passes.'
      ));
    }
    return repoFiles;
  }

  private applyUnprefixedFallback(
    repoFiles: string[],
    allFiles: string[],
    planArtifact: PlanArtifact,
    repoName: string
  ): string[] {
    if (repoFiles.length > 0 || allFiles.length === 0) return repoFiles;

    const planRepos = planArtifact.plan.affectedRepositories ?? [];
    const hasAnyRepoPrefix = allFiles.some(f => planRepos.some(repo => f.startsWith(`${repo}/`)));
    if (hasAnyRepoPrefix || (planRepos.length > 0 && !planRepos.includes(repoName))) return repoFiles;

    if (repoName) {
      console.log(chalk.yellow(
        `  ⚠️ affectedFiles lacks "${repoName}/" prefix — treating all paths as relative to ${repoName}`
      ));
    }
    return allFiles;
  }

  private filterPhantomRepoFiles(
    repoFiles: string[],
    normalizedAffected: NormalizedEntry[],
    repoName: string,
    repoDir: string
  ): string[] {
    const statusByPath = new Map(normalizedAffected.map(e => [e.filePath, e.status]));
    const phantomPaths: string[] = [];

    const filtered = repoFiles.filter(filePath => {
      if ((statusByPath.get(filePath) ?? 'found') === 'to-create') return true;
      return this.existsOnDisk(filePath, repoName, repoDir, phantomPaths);
    });

    this.logPhantomPaths(phantomPaths, 'path(s) from repoFiles (planner hallucination)');
    return filtered;
  }

  private existsOnDisk(filePath: string, repoName: string, repoDir: string, collector: string[]): boolean {
    const relativePath = repoName && filePath.startsWith(`${repoName}/`)
      ? filePath.slice(repoName.length + 1)
      : filePath;
    if (fs.existsSync(path.join(repoDir, relativePath))) return true;
    collector.push(filePath);
    return false;
  }

  private resolveContextFiles(
    planArtifact: PlanArtifact,
    repoName: string,
    repoDir: string,
    repoFiles: string[]
  ): string[] {
    const normalizedContext = normalizeFileEntries(planArtifact.plan.affectedFilesContext ?? []);
    const allContextPaths = normalizedContext.filter(e => e.status !== 'not-found').map(e => e.filePath);
    let contextFiles = repoName ? allContextPaths.filter(f => f.startsWith(`${repoName}/`)) : allContextPaths;
    contextFiles = this.applyContextFallback(contextFiles, allContextPaths, planArtifact, repoName);

    const repoFilesSet = new Set(repoFiles);
    contextFiles = contextFiles.filter(f => !repoFilesSet.has(f));
    return this.filterPhantomContextFiles(contextFiles, repoName, repoDir);
  }

  private applyContextFallback(
    contextFiles: string[],
    allContextPaths: string[],
    planArtifact: PlanArtifact,
    repoName: string
  ): string[] {
    if (contextFiles.length > 0 || allContextPaths.length === 0) return contextFiles;

    const planRepos = planArtifact.plan.affectedRepositories ?? [];
    const hasAnyRepoPrefix = allContextPaths.some(f => planRepos.some(repo => f.startsWith(`${repo}/`)));
    if (hasAnyRepoPrefix || (planRepos.length > 0 && !planRepos.includes(repoName))) return contextFiles;
    return allContextPaths;
  }

  private filterPhantomContextFiles(contextFiles: string[], repoName: string, repoDir: string): string[] {
    const phantomContextPaths: string[] = [];
    const filtered = contextFiles.filter(filePath => {
      return this.existsOnDisk(filePath, repoName, repoDir, phantomContextPaths);
    });
    this.logPhantomPaths(phantomContextPaths, 'context file(s)');
    return filtered;
  }

  private logPhantomPaths(phantomPaths: string[], label: string): void {
    if (phantomPaths.length === 0) return;
    console.log(chalk.yellow(`  ⚠️ Removed ${phantomPaths.length} nonexistent ${label}:`));
    for (const p of phantomPaths) {
      console.log(chalk.yellow(`      - ${p}`));
    }
  }

  /**
   * Ensures issue:implement only operates on the selected repository.
   *
   * @param planArtifact - Plan metadata including files/repositories affected
   * @param repoDir - Selected repository directory
   * @param allowMultiRepoScope
   * @returns Nothing; throws when the plan crosses repo boundaries
   */
  private validateImplementationScope(
    planArtifact: PlanArtifact,
    repoDir?: string,
    allowMultiRepoScope?: boolean
  ): void {
    const affectedRepositories = [...new Set(planArtifact.plan.affectedRepositories ?? [])];
    this.assertSingleRepoCount(affectedRepositories, allowMultiRepoScope);
    if (allowMultiRepoScope) return;

    const repoName = repoDir ? path.basename(repoDir) : '';
    if (repoName) this.assertNoForeignPaths(planArtifact, repoName);
  }

  private assertSingleRepoCount(affectedRepositories: string[], allowMultiRepoScope?: boolean): void {
    if (affectedRepositories.length <= 1 || allowMultiRepoScope) return;
    throw new ValidationError(
      `issue:implement only verifies a single repository. This plan affects multiple repositories: `
      + `${affectedRepositories.join(', ')}. Use wf issue or run wf issue:implement separately per repository.`
    );
  }

  private assertNoForeignPaths(planArtifact: PlanArtifact, repoName: string): void {
    const localPrefixes = new Set([
      'src', 'test', 'tests', 'apps', 'libs', 'docs', 'scripts', 'config', 'bin', 'dist',
      '.github', '.husky', '.changeset', 'package.json', 'tsconfig.json', 'tsconfig.build.json', 'README.md',
    ]);
    const normalizedPaths = normalizeFileEntries(planArtifact.plan.affectedFiles ?? []);
    const offending = normalizedPaths.filter(e => {
      const [prefix] = e.filePath.split('/');
      return prefix !== repoName && !localPrefixes.has(prefix);
    });
    if (offending.length === 0) return;
    throw new ValidationError(
      `issue:implement can only modify and verify files for ${repoName}. Found paths for other repositories: `
      + `${offending.map(e => e.filePath).join(', ')}. Use wf issue or run wf issue:implement separately per repository.`
    );
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
      const relativePath = repoName && filePath.startsWith(`${repoName}/`)
        ? filePath.slice(repoName.length + 1)
        : filePath;
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
    if (trackedPaths.length === 0) return { kept: [], keptIndices: [] };

    const ignoredSet = new Set(await this.gitService.checkIgnored(trackedPaths, repoDir));
    const { kept, keptIndices, ignored } = this.partitionTrackedPaths(trackedPaths, ignoredSet);
    this.logTrackedPathDiagnostics(kept, ignored);
    return { kept, keptIndices };
  }

  private partitionTrackedPaths(
    trackedPaths: string[],
    ignoredSet: Set<string>
  ): { kept: string[]; keptIndices: number[]; ignored: string[] } {
    const kept: string[] = [];
    const keptIndices: number[] = [];
    const ignored: string[] = [];

    for (let i = 0; i < trackedPaths.length; i++) {
      if (ignoredSet.has(trackedPaths[i])) {
        ignored.push(trackedPaths[i]);
        continue;
      }
      kept.push(trackedPaths[i]);
      keptIndices.push(i);
    }
    return { kept, keptIndices, ignored };
  }

  private logTrackedPathDiagnostics(kept: string[], ignored: string[]): void {
    if (ignored.length > 0) {
      console.log(chalk.yellow(`  ⚠️ Dropped ${ignored.length} gitignored path(s) from tracked files:`));
      for (const p of ignored) console.log(chalk.yellow(`      - ${p}`));
    }

    const existingCount = kept.filter(p => fs.existsSync(p)).length;
    const createdCount = kept.length - existingCount;
    if (existingCount > 0 || createdCount > 0) {
      console.log(chalk.gray(`  Tracked files: ${existingCount} existing, ${createdCount} new`));
    }
  }

  /**
   * Reads package.json scripts for alias reporting when available.
   *
   * @param repoDir - Repository directory to inspect
   * @returns package.json script mappings, or an empty object when unavailable
   */
  private readPackageScripts(repoDir?: string): Record<string, string> {
    const packageJsonPath = path.join(repoDir ?? process.cwd(), 'package.json');
    if (!fs.existsSync(packageJsonPath)) return {};

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { scripts?: Record<string, string> };
      return pkg.scripts ?? {};
    } catch {
      console.log(
        chalk.yellow(`  ⚠️ Unable to parse ${packageJsonPath}; continuing without package.json alias discovery.`)
      );
      return {};
    }
  }

  private buildVerificationScripts(repoDir: string | undefined, planArtifact: PlanArtifact): VerificationScript[] {
    const verificationConditions = this.getVerificationConditionsConfig();
    return this.prepareVerificationScripts(repoDir, verificationConditions, planArtifact.plan.verification);
  }

  /**
   * Builds the verification script list and resolves package.json aliases when possible.
   *
   * @param repoDir - Repository directory used for package.json alias discovery
   * @param verificationConditions - Normalized verification conditions config
   * @param planVerification
   * @returns Ordered verification scripts
   */
  private prepareVerificationScripts(
    repoDir: string | undefined,
    verificationConditions: NormalizedVerificationConditionsConfig | undefined,
    planVerification?: PlanArtifact['plan']['verification']
  ): VerificationScript[] {
    const packageScripts = this.readPackageScripts(repoDir);
    const baselineSteps = this.resolveBaselineVerificationSteps(repoDir, verificationConditions);
    const waiverIds = new Set((planVerification?.waivers ?? []).map(w => w.id));
    const targetedSteps = planVerification?.targeted ?? [];

    return mergeVerificationSteps(baselineSteps, targetedSteps)
      .filter(step => !waiverIds.has(step.id))
      .map(step => this.toVerificationScript(step, repoDir, packageScripts));
  }

  private toVerificationScript(
    step: VerificationStep,
    repoDir: string | undefined,
    packageScripts: Record<string, string>
  ): VerificationScript {
    const command = this.normalizeVerificationCommand(step.run, repoDir);
    // 'override' is a dedup-only directive; once merged, treat as 'enforced' for execution
    const effectivePolicy = step.policy === 'override' ? 'enforced' : step.policy;
    return {
      id: step.id,
      name: step.id,
      command,
      policy: effectivePolicy,
      reason: step.reason,
      aliases: this.findPackageAliases(command, packageScripts),
    };
  }

  private normalizeVerificationCommand(command: string, repoDir: string | undefined): string {
    const trimmed = command.trim();
    if (!repoDir) return trimmed;

    const cdPrefixMatch = /^cd\s+(.+?)\s*&&\s*(.+)$/.exec(trimmed);
    if (!cdPrefixMatch) return trimmed;

    const [, rawTarget, remainder] = cdPrefixMatch;
    return this.stripRedundantCdPrefix(rawTarget, remainder, repoDir) ?? trimmed;
  }

  private stripRedundantCdPrefix(rawTarget: string, remainder: string, repoDir: string): string | undefined {
    const target = rawTarget.trim().replaceAll(/(^['"])|(['"]$)/g, '');
    const normalizedRepoDir = path.resolve(repoDir);
    const repoName = path.basename(normalizedRepoDir);
    const relativeResolved = target === repoName || target === `./${repoName}`
      ? normalizedRepoDir
      : path.resolve(repoDir, target);
    const absoluteResolved = path.resolve(target);

    if (relativeResolved === normalizedRepoDir || absoluteResolved === normalizedRepoDir) {
      return remainder.trim();
    }
    return undefined;
  }

  private resolveBaselineVerificationSteps(
    repoDir: string | undefined,
    verificationConditions: NormalizedVerificationConditionsConfig | undefined
  ): VerificationStep[] {
    const manifestPath = this.resolveVerificationManifestPath(repoDir, verificationConditions);
    if (manifestPath) return loadVerificationManifest(manifestPath, 'implement').baseline;
    if (!verificationConditions) return [];

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
    const directMatch = /^(?:npm run|pnpm|yarn|nr)\s+([A-Za-z0-9:_-]+)$/.exec(command);
    if (directMatch && packageScripts[directMatch[1]]) {
      aliases.add(directMatch[1]);
    }

    for (const [scriptName, scriptCommand] of Object.entries(packageScripts)) {
      if (scriptCommand === command) aliases.add(scriptName);
    }
    return [...aliases];
  }

  /**
   * Resolves which implementation backend should run for the current config.
   *
   * @returns Selected backend plus the provider
   */
  private resolveImplementBackendSelection(): ImplementBackendSelection {
    const provider = this.configService.get<string>('stages.implement.provider')
      ?? this.configService.get<string>('ai.provider', 'anthropic');
    const backend = this.configService.get<string>('stages.implement.backend', 'agent');

    if (backend === 'standard') {
      throw new ConfigurationError('Implement stage does not support backend "standard". Use "agent" or "cli".');
    }
    if (backend === 'cli') return this.resolveCliBackend(provider);
    return this.resolveAgentBackend(provider);
  }

  private resolveCliBackend(provider: string): ImplementBackendSelection {
    if (provider === 'openai') return { configured: 'codex-cli', selected: 'codex-cli', provider };
    if (provider === 'anthropic') return { configured: 'claude-cli', selected: 'claude-cli', provider };
    throw new ConfigurationError(
      `Implement stage backend "cli" requires provider "anthropic" or "openai". Got "${provider}".`
    );
  }

  private resolveAgentBackend(provider: string): ImplementBackendSelection {
    if (provider === 'anthropic') return { configured: 'anthropic-agent', selected: 'anthropic-agent', provider };
    if (provider === 'openai') return { configured: 'openai-agent', selected: 'openai-agent', provider };
    throw new ConfigurationError(`Implement stage requires provider "anthropic" or "openai". Got "${provider}".`);
  }

  private createAdapter(backendSelection: ImplementBackendSelection) {
    switch (backendSelection.selected) {
      case 'claude-cli': return new ClaudeCliAdapter(this.configService);
      case 'codex-cli': return new CodexCliAdapter(this.configService);
      case 'openai-agent': return new OpenAIAgentAdapter(this.configService);
      default: return new AnthropicAgentAdapter(this.configService);
    }
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
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    return path.join(stateDirectory, 'implement-verification', repoName, `${ticketKey}-${timestamp}.json`);
  }

  private writeRunArtifact(
    ticket: TicketArtifact,
    options: ImplementerOptions,
    backendSelection: ImplementBackendSelection,
    verificationScripts: VerificationScript[]
  ): void {
    const filePath = this.getImplementVerificationRunPath(ticket.ticketKey, options.repoDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeImplementVerificationRunFile(filePath, {
      ticketKey: ticket.ticketKey,
      repoDir: options.repoDir ?? process.cwd(),
      backendConfigured: backendSelection.configured,
      backendSelected: backendSelection.selected,
      provider: backendSelection.provider,
      verificationScripts: verificationScripts.map(({ id, command }) => ({ id, command })),
      startedAt: new Date().toISOString(),
    });
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
    this.logInvestigationResults(artifact, findingsPath);
    return { type: 'investigation', artifact };
  }

  private logInvestigationResults(artifact: FindingsArtifact, findingsPath: string): void {
    console.log(chalk.green('\n✓ Investigation complete'));
    console.log(chalk.bold('  Summary:'), chalk.bold.cyan(artifact.summary));

    if (artifact.findings.length > 0) {
      console.log(chalk.bold('\n  Findings:'));
      for (const [i, f] of artifact.findings.entries()) console.log(chalk.cyan(`    ${i + 1}. ${f}`));
    }
    if (artifact.recommendations.length > 0) {
      console.log(chalk.bold('\n  Recommendations:'));
      for (const [i, r] of artifact.recommendations.entries()) console.log(chalk.cyan(`    ${i + 1}. ${r}`));
    }

    console.log(chalk.bold('\n  Conclusion:'));
    console.log(chalk.cyan(`    ${artifact.conclusion}`));
    console.log(chalk.gray(`\n  Saved to: ${findingsPath}`));
  }

  /**
   * Orchestrates the full branch creation workflow: dirty-tree check, source
   * branch selection, pull, and branch creation.
   *
   * @param ticket - Ticket artifact for branch name generation
   * @param planArtifact - Plan artifact with action and metadata
   * @param options - Implementation options including silent/noBranch flags
   * @returns The active or created branch name
   */
  private async handleBranchWorkflow(
    ticket: TicketArtifact,
    planArtifact: PlanArtifact,
    options: ImplementerOptions
  ): Promise<string | null> {
    const cwd = options.repoDir;
    const isTTY = this.isInteractiveSession();
    const stashInteractive = !options.silent && isTTY;
    const current = await this.gitService.getCurrentBranch(cwd).catch(() => '');

    if (options.noBranch) {
      return this.handleStayPath(current, planArtifact, options, isTTY, stashInteractive, cwd);
    }
    if (isTTY && await this.promptStayOnBranch(current)) {
      return this.handleStayPath(current, planArtifact, options, isTTY, stashInteractive, cwd);
    }
    return this.createBranchFromSource(ticket, planArtifact, options, isTTY, stashInteractive, cwd);
  }

  private async promptStayOnBranch(current: string): Promise<boolean> {
    const { branchAction } = await inquirer.prompt<{ branchAction: string }>([{
      type: 'list',
      name: 'branchAction',
      message: 'Branch workflow:',
      prefix: ' ',
      choices: [
        { name: 'Create new branch from source', value: 'create' },
        { name: `Stay on ${current}`, value: 'stay' },
      ],
      default: 'create',
    }]);
    return branchAction === 'stay';
  }

  private async createBranchFromSource(
    ticket: TicketArtifact,
    planArtifact: PlanArtifact,
    options: ImplementerOptions,
    interactive: boolean,
    stashInteractive: boolean,
    cwd: string | undefined
  ): Promise<string> {
    const { didStash } = await this.ensureCleanWorkingTree(planArtifact, stashInteractive, cwd);
    const sourceBranch = await this.detectAndSelectSource(interactive, cwd);
    await this.pullLatestFromSource(sourceBranch.name, sourceBranch.current, cwd);
    await this.restoreStash(didStash, cwd);

    return this.createOrReuseFeatureBranch(ticket, planArtifact, options, interactive, sourceBranch.name, cwd);
  }

  private async detectAndSelectSource(
    interactive: boolean,
    cwd: string | undefined
  ): Promise<{ name: string; current: string }> {
    console.log(chalk.gray('  Detecting source branches...'));
    const branchInfo = await this.gitService.getBranchInfo(cwd);
    const devBranches = this.gitService.detectDevelopmentBranches(branchInfo.all);
    const mainBranch = this.gitService.detectMainBranch(branchInfo.all);

    const name = await this.resolveSourceBranch({
      branchInfo, devBranches, mainBranch, interactive, cwd,
    });
    return { name, current: branchInfo.current };
  }

  private async createOrReuseFeatureBranch(
    ticket: TicketArtifact,
    planArtifact: PlanArtifact,
    options: ImplementerOptions,
    interactive: boolean,
    sourceBranch: string,
    cwd: string | undefined
  ): Promise<string> {
    const generatedName = this.generateBranchNameForTicket(ticket, planArtifact, options);
    const branchName = await this.promptBranchName({ generatedName, interactive });

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
    interactive: boolean,
    cwd: string | undefined
  ): Promise<{ didStash: boolean }> {
    console.log(chalk.gray('  Checking working tree status...'));
    const status = await this.gitService.getStatus(cwd);
    this.assertNoConflicts(status.conflicted);

    if (!this.hasTrackedChanges(status)) {
      console.log(chalk.green('  Working tree is clean'));
      return { didStash: false };
    }
    return this.promptOrAutoStash(planArtifact, interactive, cwd);
  }

  private assertNoConflicts(conflicted: string[]): void {
    if (conflicted.length === 0) return;
    throw new GitError(
      `Working tree has unresolved merge conflicts: ${conflicted.join(', ')}. `
      + `Resolve them before running implement.`
    );
  }

  private hasTrackedChanges(status: {
    modified: unknown[]; staged: unknown[]; deleted: unknown[]; renamed: unknown[];
  }): boolean {
    return status.modified.length > 0
      || status.staged.length > 0
      || status.deleted.length > 0
      || status.renamed.length > 0;
  }

  private async promptOrAutoStash(
    planArtifact: PlanArtifact,
    interactive: boolean,
    cwd: string | undefined
  ): Promise<{ didStash: boolean }> {
    const stashMessage = path.basename(planArtifact.path) || 'wf-auto-stash';

    if (interactive) {
      const action = await this.promptDirtyTreeAction();
      if (action === 'abort') {
        throw new GitError('Aborted: working tree has uncommitted changes. Commit or stash them first.');
      }
      if (action === 'continue') {
        console.log(chalk.yellow('  Continuing with uncommitted changes in working tree'));
        return { didStash: false };
      }
    }

    console.log(chalk.yellow(`  Working tree has uncommitted changes — stashing (${stashMessage})...`));
    await this.gitService.stashChanges(stashMessage, cwd);
    return { didStash: true };
  }

  private async promptDirtyTreeAction(): Promise<'stash' | 'continue' | 'abort'> {
    const { dirtyTreeAction } = await inquirer.prompt<{
      dirtyTreeAction: 'stash' | 'continue' | 'abort';
    }>([{
      type: 'list',
      name: 'dirtyTreeAction',
      message: 'Working tree has uncommitted changes.',
      prefix: ' ',
      choices: [
        { name: 'Stash and continue', value: 'stash' },
        { name: 'Continue without stashing', value: 'continue' },
        { name: 'Abort', value: 'abort' },
      ],
    }]);
    return dirtyTreeAction;
  }

  private async resolveSourceBranch(params: {
    branchInfo: BranchInfo;
    devBranches: string[];
    mainBranch: string | undefined;
    interactive: boolean;
    cwd: string | undefined;
  }): Promise<string> {
    const { branchInfo, devBranches, mainBranch, interactive, cwd } = params;

    if (devBranches.length === 1) return this.logSourceBranch(devBranches[0], cwd);
    if (devBranches.length > 1 && interactive) {
      const selected = await this.promptSourceBranch(devBranches, mainBranch);
      return this.logSourceBranch(selected, cwd);
    }
    if (devBranches.length > 1) return this.logSourceBranch(devBranches[0], cwd);
    if (mainBranch) return this.logSourceBranch(mainBranch, cwd);

    console.log(chalk.yellow(`  No dev or main branch detected — using current branch: ${branchInfo.current}`));
    return branchInfo.current;
  }

  private async promptSourceBranch(devBranches: string[], mainBranch: string | undefined): Promise<string> {
    const formatChoice = (b: string) => {
      const isRemote = b.startsWith('remotes/') || b.startsWith('origin/');
      return { name: isRemote ? chalk.gray(b) : chalk.cyan(b), value: b };
    };
    const choices = [...devBranches.map(formatChoice), ...(mainBranch ? [formatChoice(mainBranch)] : [])];
    const { selected } = await inquirer.prompt<{ selected: string }>([{
      type: 'list',
      name: 'selected',
      message: 'Multiple dev branches found. Select source branch:',
      prefix: ' ',
      choices,
      default: devBranches[0],
    }]);
    return selected;
  }

  private async logSourceBranch(branch: string, cwd: string | undefined): Promise<string> {
    const isRemote = branch.startsWith('remotes/') || branch.startsWith('origin/');
    const branchColor = isRemote ? chalk.gray : chalk.cyan;
    const hasUpstream = isRemote ? true : await this.gitService.hasUpstream(branch, cwd);
    console.log(chalk.cyan(`  Source branch: ${branchColor(branch)}${hasUpstream ? ' (has upstream)' : ''}`));
    return branch;
  }

  private async pullLatestFromSource(
    sourceBranch: string,
    currentBranch: string,
    cwd: string | undefined
  ): Promise<void> {
    const isRemote = sourceBranch.startsWith('remotes/') || sourceBranch.startsWith('origin/');
    if (isRemote) {
      console.log(chalk.gray(`  Skipping pull — ${sourceBranch} is a remote tracking ref`));
      return;
    }

    if (currentBranch !== sourceBranch) {
      const switched = await this.tryCheckoutSource(sourceBranch, cwd);
      if (!switched) {
        throw new GitError(
          `Cannot switch to source branch '${sourceBranch}' — working tree has conflicting changes.\n`
          + `Stash or commit your changes in ${cwd ?? 'the current directory'}, then retry.`,
          { sourceBranch, cwd },
        );
      }
    }
    await this.pullSafe(sourceBranch, cwd);
  }

  private async tryCheckoutSource(sourceBranch: string, cwd: string | undefined): Promise<boolean> {
    try {
      await this.gitService.checkoutBranch(sourceBranch, cwd);
      return true;
    } catch {
      return false;
    }
  }

  private async pullSafe(branch: string, cwd: string | undefined): Promise<void> {
    try {
      console.log(chalk.gray(`  Pulling latest from origin/${branch}...`));
      await this.gitService.pull('origin', branch, cwd);
    } catch {
      console.log(chalk.yellow(
        `  Could not pull ${branch} (no upstream or network issue) — continuing with local state`
      ));
    }
  }

  private async restoreStash(didStash: boolean, cwd: string | undefined): Promise<void> {
    if (!didStash) return;
    try {
      await this.gitService.stashPop(cwd);
    } catch {
      console.log(chalk.yellow(
        '  Stash pop encountered conflicts. Your changes are in stash@{0} — resolve manually after implementation.'
      ));
    }
  }

  private async resolveShouldPull(branch: string, interactive: boolean): Promise<boolean> {
    if (!branch) return false;
    if (!interactive) return true;

    const { shouldPull } = await inquirer.prompt<{ shouldPull: boolean }>([{
      type: 'confirm',
      name: 'shouldPull',
      message: `Pull latest changes on ${branch}?`,
      prefix: ' ',
      default: true,
    }]);
    return shouldPull;
  }

  private async handleStayPath(
    branch: string,
    planArtifact: PlanArtifact,
    options: ImplementerOptions,
    branchInteractive: boolean,
    stashInteractive: boolean,
    cwd: string | undefined
  ): Promise<string> {
    const shouldPull = await this.resolveShouldPull(branch, branchInteractive);
    if (shouldPull) {
      const { didStash } = await this.ensureCleanWorkingTree(planArtifact, stashInteractive, cwd);
      await this.pullSafe(branch, cwd);
      await this.restoreStash(didStash, cwd);
    }

    const label = options.noBranch ? `${branch} (--no-branch)` : branch;
    console.log(chalk.cyan(`  Staying on ${label}`));
    return branch;
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
    if (options.customBranchSlug) {
      return this.generateCustomBranchName(options.customBranchSlug, planArtifact.action);
    }
    const summary = extractSummary(ticket.content);
    return this.generateBranchName(
      ticket.ticketKey, summary, planArtifact.action, options.trackerName, options.branchNamePattern
    );
  }

  private async promptBranchName(params: { generatedName: string; interactive: boolean }): Promise<string> {
    if (!params.interactive) return params.generatedName;

    const { choice } = await inquirer.prompt<{ choice: string }>([{
      type: 'list',
      name: 'choice',
      message: 'Branch name:',
      prefix: ' ',
      choices: [
        { name: params.generatedName, value: 'accept' },
        { name: 'Edit branch name', value: 'edit' },
      ],
      default: 'accept',
    }]);

    if (choice !== 'edit') return params.generatedName;
    return this.promptCustomBranchName(params.generatedName);
  }

  private async promptCustomBranchName(defaultName: string): Promise<string> {
    const { customName } = await inquirer.prompt<{ customName: string }>([{
      type: 'input',
      name: 'customName',
      message: 'Enter branch name:',
      prefix: ' ',
      default: defaultName,
    }]);
    return customName;
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
    const prefix = this.resolveBranchPrefix(action);
    const isAtlassian = trackerName === 'jira' || trackerName === 'bitbucket';
    const formattedKey = isAtlassian ? ticketKey.toUpperCase() : ticketKey;
    const prefixPart = `${prefix}/${formattedKey}__`;

    const slug = slugify(summary);
    const truncatedSlug = truncateSlug(slug, prefixPart.length);
    if (truncatedSlug !== slug) {
      console.log(chalk.yellow(`  Branch name truncated to fit ${MAX_BRANCH_NAME_LENGTH} char limit`));
    }

    const branchName = `${prefixPart}${truncatedSlug}`;
    this.validateBranchPattern(branchName, patternOverride);
    return branchName;
  }

  private resolveBranchPrefix(action: ResolutionAction): string {
    const mapping = this.configService.get<Record<ResolutionAction, string>>(
      'git.branchPrefixMapping',
      DEFAULT_PREFIX_MAPPING
    );
    return mapping[action] || 'feature';
  }

  private validateBranchPattern(branchName: string, patternOverride?: string): void {
    const pattern = patternOverride ?? this.configService.get<string>('git.branchNamePattern');
    if (!pattern) return;

    try {
      if (!new RegExp(pattern).test(branchName)) {
        console.log(chalk.yellow(`  Generated branch name "${branchName}" does not match pattern: ${pattern}`));
      }
    } catch {
      console.log(chalk.yellow(`  Invalid branch pattern in config (git.branchNamePattern): ${pattern}`));
    }
  }

  private generateCustomBranchName(artifactStem: string, action: ResolutionAction): string {
    const prefix = this.resolveBranchPrefix(action);
    const slug = slugify(artifactStem);
    const prefixPart = `${prefix}/`;
    const truncatedSlug = truncateSlug(slug, prefixPart.length);

    if (truncatedSlug !== slug) {
      console.log(chalk.yellow(`  Branch name truncated to fit ${MAX_BRANCH_NAME_LENGTH} char limit`));
    }
    return `${prefixPart}${truncatedSlug}`;
  }
}
