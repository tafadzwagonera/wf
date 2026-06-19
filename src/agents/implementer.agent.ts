// src/agents/implementer.agent.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { GitService } from '../integrations/git/git.service';
import { AiService } from '../integrations/ai/ai.service';
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
import {
  formatBackendSelection,
  writeImplementVerificationRunFile,
} from '../shared/utils/implement-verification';
import { getWfStateDir } from '../shared/utils/wf-paths';
import * as fs from 'fs';
import * as path from 'path';
import type { NormalizedVerificationConditionsConfig } from '../config/wf-config-loader';
import {
  loadVerificationManifest,
  type VerificationStep,
} from '../shared/utils/verification-manifest';
import { AnthropicAgentAdapter } from '../integrations/ai/adapters/anthropic-agent.adapter';
import { OpenAIAgentAdapter } from '../integrations/ai/adapters/openai-agent.adapter';
import { ClaudeCliAdapter } from '../integrations/ai/adapters/claude-cli.adapter';

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
    private aiService: AiService,
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
    options: ImplementerOptions,
  ): Promise<ImplementerResult> {
    if (planArtifact.action === 'investigate') {
      return this.executeInvestigation(ticket, planArtifact);
    }

    if (!options.suppressHeader) {
      console.log(chalk.bold.yellow('\n🔧 STAGE 3: Implementation Guide'));
      console.log(chalk.gray('─'.repeat(70)));
    }

    this.validateImplementationScope(
      planArtifact,
      options.repoDir,
      options.allowMultiRepoScope,
    );

    const summary = extractSummary(ticket.content);
    const branchName = options.customBranchSlug
      ? this.generateCustomBranchName(
          options.customBranchSlug,
          planArtifact.action,
        )
      : this.generateBranchName(
          ticket.ticketKey,
          summary,
          planArtifact.action,
          options.trackerName,
        );

    const currentBranch = await this.gitService
      .getCurrentBranch(options.repoDir)
      .catch(() => '');
    if (currentBranch === branchName) {
      console.log(chalk.green(`✓ Already on branch: ${branchName}`));
    } else {
      await this.gitService.createBranch(
        branchName,
        undefined,
        options.repoDir,
      );
      console.log(chalk.green(`✓ Switched to branch: ${branchName}`));
    }

    console.log(chalk.bold('\n  Steps:'));
    planArtifact.plan.steps.forEach((step: string, i: number) => {
      console.log(chalk.cyan(`    ${i + 1}. ${step}`));
    });

    // Narrate the plan before touching any files (opt-in via stages.implement.narrate)
    const shouldNarrate =
      this.configService.get<boolean>('stages.implement.narrate') === true;
    let narration = '';
    if (shouldNarrate) {
      console.log(chalk.gray('\n  Narrating plan...'));
      narration = await this.aiService.narrateImplementationPlan(
        ticket.content,
        planArtifact.plan,
      );
      console.log('');
      narration.split('\n').forEach((line) => {
        if (line.startsWith('## ')) {
          console.log(chalk.bold(`  ${line}`));
        } else if (line.trim()) {
          console.log(chalk.cyan(`    ${line}`));
        } else {
          console.log('');
        }
      });
    }

    // Generate and write code changes for files belonging to this repo
    const repoName = options.repoDir ? path.basename(options.repoDir) : '';
    const allFiles = planArtifact.plan.filesAffected ?? [];

    // Primary: files explicitly prefixed with this repo's name.
    let repoFiles = repoName
      ? allFiles.filter((f) => f.startsWith(`${repoName}/`))
      : allFiles;

    // Fallback: plan was generated without repo-name prefixes (older format or
    // AI non-compliance). Safe to apply only when NO file in the plan carries ANY
    // known repo prefix — if some files are prefixed and this repo's aren't, the
    // empty result is intentional and we must not override it.
    if (repoFiles.length === 0 && allFiles.length > 0) {
      const planRepos = planArtifact.plan.repositoriesAffected ?? [];
      const hasAnyRepoPrefix = allFiles.some((f) =>
        planRepos.some((repo) => f.startsWith(`${repo}/`)),
      );
      if (
        !hasAnyRepoPrefix &&
        (planRepos.includes(repoName) || planRepos.length === 0)
      ) {
        repoFiles = allFiles;
        if (repoName) {
          console.log(
            chalk.yellow(
              `  ⚠ filesAffected lacks "${repoName}/" prefix — treating all paths as relative to ${repoName}`,
            ),
          );
        }
      }
    }

    const verificationConditions = this.getVerificationConditionsConfig();
    const verificationScripts = this.prepareVerificationScripts(
      options.repoDir,
      verificationConditions,
      planArtifact.plan.verification,
    );
    const trackedFilePaths = this.resolveTrackedFilePaths(
      repoFiles,
      repoName,
      options.repoDir,
    );
    const sceneContext = narration
      ? `${ticket.content}\n\n---\nPlan narration:\n${narration}`
      : ticket.content;

    const backendSelection = this.resolveImplementBackendSelection();
    console.log(chalk.cyan(`  ${formatBackendSelection(backendSelection)}`));

    const verificationRunFilePath = this.getImplementVerificationRunPath(
      ticket.ticketKey,
      options.repoDir,
    );
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
      if (backendSelection.selected === 'claude-cli')
        return new ClaudeCliAdapter(this.configService);
      if (backendSelection.selected === 'openai-agent')
        return new OpenAIAgentAdapter(this.configService);
      return new AnthropicAgentAdapter(this.configService);
    })();
    await adapter.generateAndVerify({
      ticket,
      planArtifact,
      options,
      verificationScripts,
      sceneContext,
      repoFiles,
      repoName,
      trackedFilePaths,
    });

    if ((planArtifact.plan.repositoriesAffected?.length ?? 0) > 0) {
      console.log(chalk.bold('\n  Repositories affected:'));
      planArtifact.plan.repositoriesAffected!.forEach((repo: string) =>
        console.log(chalk.gray(`    - ${repo}`)),
      );
    }

    console.log(chalk.bold('\n  Status:'));
    console.log(
      chalk.cyan('    Changes generated, verified, and written to disk'),
    );
    console.log(
      chalk.cyan('    issue:implement completed for the selected repository'),
    );

    return { type: 'implementation', branchName };
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
    allowMultiRepoScope?: boolean,
  ): void {
    const repoName = repoDir ? path.basename(repoDir) : '';
    const repositoriesAffected = [
      ...new Set(planArtifact.plan.repositoriesAffected ?? []),
    ];
    if (repositoriesAffected.length > 1 && !allowMultiRepoScope) {
      throw new Error(
        `issue:implement only verifies a single repository. This plan affects multiple repositories: ${repositoriesAffected.join(', ')}. Use wf issue or run wf issue:implement separately per repository.`,
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
    const offendingPaths = (planArtifact.plan.filesAffected ?? []).filter(
      (filePath) => {
        const [prefix] = filePath.split('/');
        return prefix !== repoName && !localPathPrefixes.has(prefix);
      },
    );
    if (offendingPaths.length > 0) {
      throw new Error(
        `issue:implement can only modify and verify files for ${repoName}. Found paths for other repositories: ${offendingPaths.join(', ')}. Use wf issue or run wf issue:implement separately per repository.`,
      );
    }
  }

  /**
   * Loads the normalized implement-stage verification configuration.
   *
   * @returns Configured verification conditions, if any
   */
  private getVerificationConditionsConfig():
    | NormalizedVerificationConditionsConfig
    | undefined {
    return this.configService.get<
      NormalizedVerificationConditionsConfig | undefined
    >('stages.implement.verificationConditions');
  }

  /**
   * Resolves the absolute file paths tracked for verification rewrite detection.
   *
   * @param repoFiles - Files assigned to the current repository
   * @param repoName - Repository name prefix
   * @param repoDir - Repository directory
   * @returns Absolute file paths for tracked files
   */
  private resolveTrackedFilePaths(
    repoFiles: string[],
    repoName: string,
    repoDir?: string,
  ): string[] {
    return repoFiles.map((filePath) => {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`)
          ? filePath.slice(repoName.length + 1)
          : filePath;

      return repoDir
        ? path.join(repoDir, relativePath)
        : path.resolve(relativePath);
    });
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
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, 'utf-8'),
      ) as { scripts?: Record<string, string> };
      return packageJson.scripts ?? {};
    } catch {
      console.log(
        chalk.yellow(
          `  ⚠ Unable to parse ${packageJsonPath}; continuing without package.json alias discovery.`,
        ),
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
    planVerification?: PlanArtifact['plan']['verification'],
  ): VerificationScript[] {
    const packageScripts = this.readPackageScripts(repoDir);
    const baselineSteps = this.resolveBaselineVerificationSteps(
      repoDir,
      verificationConditions,
    );
    const waiverIds = new Set(
      (planVerification?.waivers ?? []).map((waiver) => waiver.id),
    );
    const targetedSteps = planVerification?.targeted ?? [];
    const resolvedSteps = [...baselineSteps, ...targetedSteps].filter(
      (step) => !waiverIds.has(step.id),
    );

    return resolvedSteps.map((step) => {
      const normalizedCommand = this.normalizeVerificationCommand(
        step.run,
        repoDir,
      );

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

  private normalizeVerificationCommand(
    command: string,
    repoDir: string | undefined,
  ): string {
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
      target === repoName || target === `./${repoName}`
        ? normalizedRepoDir
        : path.resolve(repoDir, target);
    const normalizedAbsoluteTarget = path.resolve(target);

    if (
      normalizedRelativeTarget === normalizedRepoDir ||
      normalizedAbsoluteTarget === normalizedRepoDir
    ) {
      return remainder.trim();
    }

    return trimmed;
  }

  private resolveBaselineVerificationSteps(
    repoDir: string | undefined,
    verificationConditions: NormalizedVerificationConditionsConfig | undefined,
  ): VerificationStep[] {
    const manifestPath = this.resolveVerificationManifestPath(
      repoDir,
      verificationConditions,
    );

    if (manifestPath) {
      return loadVerificationManifest(manifestPath, 'implement').baseline;
    }

    if (!verificationConditions) {
      return [];
    }

    return Object.entries(verificationConditions.scripts).map(
      ([name, command]) => ({
        id: name,
        run: command,
        policy: 'enforced',
      }),
    );
  }

  private resolveVerificationManifestPath(
    repoDir: string | undefined,
    verificationConditions: NormalizedVerificationConditionsConfig | undefined,
  ): string | undefined {
    const baseDir = repoDir ?? process.cwd();
    const configuredPath = verificationConditions?.policyFile;
    if (configuredPath) {
      return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(baseDir, configuredPath);
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
  private findPackageAliases(
    command: string,
    packageScripts: Record<string, string>,
  ): string[] {
    const aliases = new Set<string>();
    const directScriptMatch = command.match(
      /^(?:npm run|pnpm|yarn|nr)\s+([A-Za-z0-9:_-]+)$/,
    );

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
    const backend = this.configService.get<string>(
      'stages.implement.backend',
      'agent',
    );

    if (backend === 'standard') {
      throw new Error(
        'Implement stage does not support backend "standard". Use "agent" or "cli".',
      );
    }

    if (backend === 'cli') {
      if (provider !== 'anthropic') {
        throw new Error(
          `Implement stage backend "cli" requires provider "anthropic". Got "${provider}".`,
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

    throw new Error(
      `Implement stage requires provider "anthropic" or "openai". Got "${provider}".`,
    );
  }

  /**
   * Builds the filesystem path for the current implementation verification run.
   *
   * @param ticketKey - Ticket identifier used to scope the persisted run
   * @param repoDir - Selected repository directory, used for namespacing
   * @returns Absolute path to the persisted verification run file
   */
  private getImplementVerificationRunPath(
    ticketKey: string,
    repoDir?: string,
  ): string {
    const stateDirectory = getWfStateDir();
    const repoName = repoDir ? path.basename(repoDir) : 'repo';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    return path.join(
      stateDirectory,
      'implement-verification',
      repoName,
      `${ticketKey}-${timestamp}.json`,
    );
  }

  /**
   * Writes the initial run artifact and ensures its directory exists.
   *
   * @param filePath - Destination path for the run artifact
   * @param run - Run metadata to persist before generation starts
   * @returns Nothing
   */
  private writeImplementVerificationRunArtifact(
    filePath: string,
    run: ImplementRunArtifact,
  ): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeImplementVerificationRunFile(filePath, run);
  }

  private async executeInvestigation(
    ticket: TicketArtifact,
    planArtifact: PlanArtifact,
  ): Promise<ImplementerResult> {
    console.log(chalk.bold.yellow('\n🔍 STAGE 3: Investigation Findings'));
    console.log(chalk.gray('─'.repeat(70)));
    console.log(chalk.gray('  Generating findings and recommendations...'));

    const findings = await this.aiService.generateFindings(
      planArtifact.plan,
      ticket.content,
    );

    const findingsPath = planArtifact.path.replace(
      '.json',
      '-findings-and-recommendations.json',
    );

    fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
    fs.writeFileSync(findingsPath, JSON.stringify(findings, null, 2), 'utf-8');

    const artifact: FindingsArtifact = { ...findings, path: findingsPath };

    console.log(chalk.green('\n✓ Investigation complete'));
    console.log(chalk.bold('  Summary:'), chalk.bold.cyan(artifact.summary));

    if (artifact.findings.length > 0) {
      console.log(chalk.bold('\n  Findings:'));
      artifact.findings.forEach((f, i) =>
        console.log(chalk.cyan(`    ${i + 1}. ${f}`)),
      );
    }

    if (artifact.recommendations.length > 0) {
      console.log(chalk.bold('\n  Recommendations:'));
      artifact.recommendations.forEach((r, i) =>
        console.log(chalk.cyan(`    ${i + 1}. ${r}`)),
      );
    }

    console.log(chalk.bold('\n  Conclusion:'));
    console.log(chalk.cyan(`    ${artifact.conclusion}`));
    console.log(chalk.gray(`\n  Saved to: ${findingsPath}`));

    return { type: 'investigation', artifact };
  }

  private generateBranchName(
    ticketKey: string,
    summary: string,
    action: ResolutionAction,
    trackerName: string,
  ): string {
    const prefixMapping = this.configService.get<
      Record<ResolutionAction, string>
    >('branching.prefixMapping', DEFAULT_PREFIX_MAPPING);
    const prefix = prefixMapping[action] || 'feature';

    // Atlassian platforms (jira, bitbucket) use uppercase ticket keys
    const isAtlassian = trackerName === 'jira' || trackerName === 'bitbucket';
    const formattedKey = isAtlassian ? ticketKey.toUpperCase() : ticketKey;

    const branchName = `${prefix}/${formattedKey}__${slugify(summary)}`;

    // Validate against platform-configured branch pattern if present
    const patternKey = isAtlassian
      ? 'branching.atlassianPattern'
      : 'branching.githubPattern';
    const pattern = this.configService.get<string>(patternKey);
    if (pattern) {
      try {
        if (!new RegExp(pattern).test(branchName)) {
          console.log(
            chalk.yellow(
              `⚠ Generated branch name "${branchName}" does not match platform pattern: ${pattern}`,
            ),
          );
        }
      } catch {
        console.log(
          chalk.yellow(
            `⚠ Invalid branch pattern in config (${patternKey}): ${pattern}`,
          ),
        );
      }
    }

    return branchName;
  }

  private generateCustomBranchName(
    artifactStem: string,
    action: ResolutionAction,
  ): string {
    const prefixMapping = this.configService.get<
      Record<ResolutionAction, string>
    >('branching.prefixMapping', DEFAULT_PREFIX_MAPPING);
    const prefix = prefixMapping[action] || 'feature';

    return `${prefix}/${slugify(artifactStem)}`;
  }
}
