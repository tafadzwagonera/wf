// src/agents/implementer.agent.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { GitService } from '../integrations/git/git.service';
import { AiService } from '../integrations/ai/ai.service';
import {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  ResolutionAction,
  FindingsArtifact,
  ImplementerResult,
  FixPlan,
  VerificationScript,
} from './interfaces';
import { extractSummary, slugify } from './utils';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import type { NormalizedAfterImplementConfig } from '../config/wf-config-loader';
import {
  loadVerificationManifest,
  type VerificationStep,
} from '../shared/utils/verification-manifest';
import { AnthropicAgentAdapter } from '../integrations/ai/adapters/anthropic-agent.adapter';

const execAsync = promisify(exec);
const DEFAULT_BASE_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_PROGRESS_EXTENSIONS = 2;
const DEFAULT_ABSOLUTE_MAX_ATTEMPTS = 5;
const DEFAULT_FINGERPRINT_LINE_COUNT = 40;
const ACTIONABLE_DIAGNOSTIC_PATTERN =
  /(error|failed|exception|cannot|can't|not found|syntaxerror|referenceerror|typeerror|ts\d+|format|prettier|code style|lint|● |expect\(|received|assertion|✕|✗|FAIL\s|0 passing|[0-9]+ failing)/i;
const MAX_RELATED_TYPE_FILES = 10;
const ERROR_CLASS_SEVERITY: Record<string, number> = {
  syntax: 6,
  module: 5,
  reference: 5,
  type: 4,
  test: 3,
  generic: 3,
  lint: 2,
  format: 1,
};

interface VerificationCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface VerificationFailure {
  attempt: number;
  results: VerificationCommandResult[];
}

interface VerificationOutcome {
  failure: VerificationFailure | null;
  rewroteTrackedFiles: boolean;
}

interface VerificationProgress {
  isMeaningful: boolean;
  summary: string;
}

interface VerificationSetupIssue {
  summary: string;
}

interface RetryRepoContext {
  packageJson?: string;
  configFiles: Record<string, string>;
}

interface FileWriteResult {
  filePath: string;
  changed: boolean;
}

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
   * Generates a branch name, runs code generation, and verifies the result.
   *
   * On verification failure, uses a **two-phase retry** strategy (attempt 2+):
   * 1. Diagnosis — collects failing file contents, depth-1 related type files
   *    (across repoDir and additionalRepoDirs), repo-level test-runner context,
   *    and test sources, then calls the AI for a structured FixPlan.
   * 2. Execution — re-generates each file using the FixPlan as shared context.
   *    When diagnostics implicate a spec/test file, the retry scope expands to
   *    include its paired implementation file, and vice versa.
   *
   * Retry extension decisions are history-aware, not just attempt-to-attempt:
   * the agent tracks the deepest verification stage reached so far and the
   * highest-severity error classes seen there. This allows one more retry when
   * a deeper test/type/module failure collapses into a smaller earlier-stage
   * lint/type residue, while still rejecting genuine oscillation.
   *
   * When `stages.implement.experimentalAgent: true` and `ai.provider` is
   * `'anthropic'`, delegates the entire generate-and-verify loop to
   * AnthropicAgentAdapter (tool-use inner loop). Falls back to the standard
   * two-phase retry path for all other providers.
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

    this.validateImplementationScope(planArtifact, options.repoDir);

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
          options.platformName,
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

    // Narrate the plan before touching any files (Superpowers: writing-plans pattern)
    console.log(chalk.gray('\n  Narrating plan...'));
    const narration = await this.aiService.narrateImplementationPlan(
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

    const afterImplement = this.getAfterImplementConfig();
    const verificationScripts = this.prepareVerificationScripts(
      options.repoDir,
      afterImplement,
      planArtifact.plan.verification,
    );
    const trackedFilePaths = this.resolveTrackedFilePaths(
      repoFiles,
      repoName,
      options.repoDir,
    );
    const sceneContext = `${ticket.content}\n\n---\nPlan narration:\n${narration}`;

    // Experimental Anthropic agent backend (behind config flag)
    const useAgent =
      this.configService.get<boolean>(
        'stages.implement.experimentalAgent',
        false,
      ) === true;
    const aiProvider = this.configService.get<string>(
      'ai.provider',
      'anthropic',
    );
    if (useAgent) {
      if (aiProvider !== 'anthropic') {
        console.log(
          chalk.yellow(
            `  ⚠ stages.implement.experimentalAgent requires provider: anthropic (current: ${aiProvider}). Falling back to standard two-phase retry.`,
          ),
        );
      } else {
        const adapter = new AnthropicAgentAdapter(this.configService);
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
        return { type: 'implementation', branchName };
      }
    }

    let retryRepoFiles = repoFiles;
    let retryContext = options.conversationContext;
    let retryFixPlan: FixPlan | undefined;
    let previousFailureFingerprint: string | undefined;
    let previousVerificationFailure: VerificationFailure | undefined;
    let furthestVerificationFailure: VerificationFailure | undefined;
    let lastVerificationFailure: VerificationFailure | undefined;
    let verificationRewroteTrackedFiles = false;
    let progressExtensionsUsed = 0;
    const baseMaxAttempts =
      afterImplement?.baseMaxAttempts ?? DEFAULT_BASE_MAX_ATTEMPTS;
    const maxProgressExtensions =
      afterImplement?.maxProgressExtensions ?? DEFAULT_MAX_PROGRESS_EXTENSIONS;
    const absoluteMaxAttempts =
      afterImplement?.absoluteMaxAttempts ?? DEFAULT_ABSOLUTE_MAX_ATTEMPTS;

    for (
      let attemptNumber = 1;
      attemptNumber <= absoluteMaxAttempts;
      attemptNumber += 1
    ) {
      const fileWriteResults = await this.generateRepoFiles({
        repoFiles: retryRepoFiles,
        repoName,
        repoDir: options.repoDir,
        sceneContext,
        planSteps: planArtifact.plan.steps,
        retryContext,
        fixPlan: retryFixPlan,
        repoContext: this.collectRetryRepoContext(options.repoDir),
      });

      if (verificationScripts.length === 0) {
        break;
      }

      if (
        attemptNumber > 1 &&
        afterImplement?.requireStateChangeForRetry !== false &&
        fileWriteResults.every((result) => !result.changed) &&
        !verificationRewroteTrackedFiles
      ) {
        throw new Error(
          this.formatVerificationExitMessage({
            ticketKey: ticket.ticketKey,
            repoDir: options.repoDir,
            summary:
              'Verification failed and the next AI pass did not produce a state change. Refusing to rerun hooks against stale files.',
            failure: lastVerificationFailure,
          }),
        );
      }

      console.log(chalk.bold('\n  Verification:'));
      this.printVerificationScripts(verificationScripts);
      const verificationOutcome = await this.verifyImplementation(
        options.repoDir,
        verificationScripts,
        trackedFilePaths,
        attemptNumber,
      );
      verificationRewroteTrackedFiles = verificationOutcome.rewroteTrackedFiles;
      const verificationFailure = verificationOutcome.failure;
      if (!verificationFailure) {
        break;
      }

      lastVerificationFailure = verificationFailure;
      const setupIssue = this.detectVerificationSetupIssue(
        verificationFailure,
        options.repoDir,
      );
      if (setupIssue) {
        throw new Error(
          this.formatVerificationExitMessage({
            ticketKey: ticket.ticketKey,
            repoDir: options.repoDir,
            summary: setupIssue.summary,
            failure: verificationFailure,
          }),
        );
      }
      const failureFingerprint = this.buildFailureFingerprint(
        verificationFailure,
        afterImplement?.fingerprintLineCount ?? DEFAULT_FINGERPRINT_LINE_COUNT,
      );
      const trackedFilesChanged =
        fileWriteResults.some((result) => result.changed) ||
        verificationOutcome.rewroteTrackedFiles;
      const hasActionableDiagnostics =
        this.hasActionableDiagnostics(verificationFailure);
      const progress = this.assessVerificationProgress({
        previousFailure: previousVerificationFailure,
        furthestFailure: furthestVerificationFailure,
        currentFailure: verificationFailure,
        trackedFilesChanged,
      });
      const hasBaseRetryBudget = attemptNumber < baseMaxAttempts;
      const canUseProgressExtension =
        !hasBaseRetryBudget &&
        progress.isMeaningful &&
        progressExtensionsUsed < maxProgressExtensions &&
        attemptNumber < absoluteMaxAttempts;

      if (!hasActionableDiagnostics) {
        throw new Error(
          this.formatVerificationExitMessage({
            ticketKey: ticket.ticketKey,
            repoDir: options.repoDir,
            summary:
              'Verification failed without actionable diagnostics. User intervention is required before retrying.',
            failure: verificationFailure,
          }),
        );
      }

      if (
        previousFailureFingerprint &&
        previousFailureFingerprint === failureFingerprint &&
        afterImplement?.retryOnSameFailure !== true
      ) {
        throw new Error(
          this.formatVerificationExitMessage({
            ticketKey: ticket.ticketKey,
            repoDir: options.repoDir,
            summary:
              'Verification failure fingerprint did not change between attempts. User intervention is required.',
            failure: verificationFailure,
          }),
        );
      }

      if (!hasBaseRetryBudget && !canUseProgressExtension) {
        const retrySummary = progress.summary
          ? `Verification retry budget exhausted. ${progress.summary}`
          : 'Verification retry budget exhausted.';
        throw new Error(
          this.formatVerificationExitMessage({
            ticketKey: ticket.ticketKey,
            repoDir: options.repoDir,
            summary: retrySummary,
            failure: verificationFailure,
          }),
        );
      }

      if (canUseProgressExtension) {
        progressExtensionsUsed += 1;
      }

      previousFailureFingerprint = failureFingerprint;
      previousVerificationFailure = verificationFailure;
      furthestVerificationFailure = this.selectFurthestFailure(
        furthestVerificationFailure,
        verificationFailure,
      );
      // Two-phase retry: on attempt 2+ run diagnosis before regeneration
      console.log(
        chalk.yellow(
          `    Verification failed on attempt ${attemptNumber}. Running two-phase diagnosis...`,
        ),
      );
      const inferredRetryRepoFiles = this.inferRetryRepoFiles(
        verificationFailure,
        repoFiles,
        repoName,
        options.repoDir,
      );
      retryFixPlan =
        (await this.diagnoseRetryFailure(
          verificationFailure,
          inferredRetryRepoFiles ?? retryRepoFiles,
          repoName,
          planArtifact.plan.steps,
          options.repoDir,
          options.additionalRepoDirs,
        )) ?? undefined;
      retryRepoFiles = this.selectRetryRepoFiles({
        currentRetryRepoFiles: retryRepoFiles,
        repoFiles,
        repoName,
        repoDir: options.repoDir,
        failure: verificationFailure,
        fixPlan: retryFixPlan,
      });
      retryContext = this.buildRetryContext(
        options.conversationContext,
        verificationFailure,
        retryRepoFiles,
        repoName,
      );
    }

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
  ): void {
    const repoName = repoDir ? path.basename(repoDir) : '';
    const repositoriesAffected = [
      ...new Set(planArtifact.plan.repositoriesAffected ?? []),
    ];
    if (repositoriesAffected.length > 1) {
      throw new Error(
        `issue:implement only verifies a single repository. This plan affects multiple repositories: ${repositoriesAffected.join(', ')}. Use wf issue or run wf issue:implement separately per repository.`,
      );
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
   * @returns Configured afterImplement settings, if any
   */
  private getAfterImplementConfig():
    | NormalizedAfterImplementConfig
    | undefined {
    return this.configService.get<NormalizedAfterImplementConfig | undefined>(
      'stages.implement.afterImplement',
    );
  }

  /**
   * Generates the updated file contents for the selected repository.
   *
   * @param params - File generation context
   * @returns Changed-state metadata for each written file
   */
  private async generateRepoFiles(params: {
    repoFiles: string[];
    repoName: string;
    repoDir?: string;
    sceneContext: string;
    planSteps: string[];
    retryContext?: string;
    fixPlan?: FixPlan;
    repoContext?: RetryRepoContext;
  }): Promise<FileWriteResult[]> {
    const results: FileWriteResult[] = [];

    if (params.repoFiles.length === 0) {
      return results;
    }

    console.log(chalk.bold('\n  Generating code changes...'));
    for (const filePath of params.repoFiles) {
      const relativePath =
        params.repoName && filePath.startsWith(`${params.repoName}/`)
          ? filePath.slice(params.repoName.length + 1)
          : filePath;
      const absolutePath = params.repoDir
        ? path.join(params.repoDir, relativePath)
        : path.resolve(relativePath);
      const existingContent = fs.existsSync(absolutePath)
        ? fs.readFileSync(absolutePath, 'utf-8')
        : '';

      // Build per-file fix context from FixPlan when available
      let fixContext: string | undefined;
      if (params.fixPlan) {
        const fileFix = params.fixPlan.fixes.find(
          (f) => f.file === relativePath || f.file === filePath,
        );
        const relatedContents = (fileFix?.relatedFiles ?? [])
          .map((rf) => {
            const rfAbs = params.repoDir
              ? path.join(params.repoDir, rf)
              : path.resolve(rf);
            if (fs.existsSync(rfAbs)) {
              return `// ${rf}\n${fs.readFileSync(rfAbs, 'utf-8')}`;
            }
            return null;
          })
          .filter(Boolean)
          .join('\n\n---\n\n');

        const parts: string[] = [`Fix plan summary: ${params.fixPlan.summary}`];
        if (fileFix) {
          parts.push(`Rationale for this file: ${fileFix.rationale}`);
        }
        if (relatedContents) {
          parts.push(`Related files:\n${relatedContents}`);
        }
        if (params.fixPlan.testContext) {
          parts.push(`Test context: ${params.fixPlan.testContext}`);
        }
        fixContext = parts.join('\n\n');
      }

      const conversationContext =
        [params.retryContext, fixContext].filter(Boolean).join('\n\n') ||
        undefined;

      console.log(chalk.gray(`\n    → ${filePath}`));
      const updatedContent = await this.aiService.generateFileChange({
        ticketContent: params.sceneContext,
        planSteps: params.planSteps,
        filePath: relativePath,
        existingContent,
        conversationContext,
        repoContext: params.repoContext,
      });

      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, updatedContent, 'utf-8');
      console.log(chalk.green(`    ✓ Updated: ${filePath}`));
      results.push({
        filePath,
        changed: updatedContent !== existingContent,
      });
    }

    return results;
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
   * @param afterImplement - Normalized afterImplement hook config
   * @returns Ordered verification scripts
   */
  private prepareVerificationScripts(
    repoDir: string | undefined,
    afterImplement: NormalizedAfterImplementConfig | undefined,
    planVerification?: PlanArtifact['plan']['verification'],
  ): VerificationScript[] {
    const packageScripts = this.readPackageScripts(repoDir);
    const baselineSteps = this.resolveBaselineVerificationSteps(
      repoDir,
      afterImplement,
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
    afterImplement: NormalizedAfterImplementConfig | undefined,
  ): VerificationStep[] {
    const manifestPath = this.resolveVerificationManifestPath(
      repoDir,
      afterImplement,
    );

    if (manifestPath) {
      return loadVerificationManifest(manifestPath).baseline;
    }

    if (!afterImplement) {
      return [];
    }

    return Object.entries(afterImplement.scripts).map(([name, command]) => ({
      id: name,
      run: command,
      policy: 'enforced',
    }));
  }

  private resolveVerificationManifestPath(
    repoDir: string | undefined,
    afterImplement: NormalizedAfterImplementConfig | undefined,
  ): string | undefined {
    const baseDir = repoDir ?? process.cwd();
    const configuredPath = afterImplement?.policyFile;
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
   * Logs the configured verification scripts and any discovered package aliases.
   *
   * @param scripts - Ordered verification scripts
   * @returns Nothing
   */
  private printVerificationScripts(scripts: VerificationScript[]): void {
    if (scripts.length === 0) {
      console.log(chalk.gray('    No afterImplement scripts configured.'));
      return;
    }

    console.log(chalk.bold('    Discovered scripts:'));
    scripts.forEach((script, index) => {
      const policySuffix =
        script.policy === 'best_effort' ? ' (best-effort)' : '';
      console.log(
        chalk.cyan(
          `      ${index + 1}. ${script.name}: ${script.command}${policySuffix}`,
        ),
      );
      if (script.aliases.length > 0) {
        console.log(
          chalk.gray(
            `         package.json aliases: ${script.aliases.join(', ')}`,
          ),
        );
      }
    });
  }

  /**
   * Executes the configured verification sequence for the selected repository.
   *
   * @param repoDir - Repository directory to verify
   * @param scripts - Configured afterImplement scripts
   * @param attempt - Current retry attempt number
   * @returns Verification failure details, or null when all checks pass
   */
  private async verifyImplementation(
    repoDir: string | undefined,
    scripts: VerificationScript[],
    trackedFilePaths: string[],
    attempt: number,
  ): Promise<VerificationOutcome> {
    const trackedFileContentsBefore =
      this.captureTrackedFileContents(trackedFilePaths);
    const results: VerificationCommandResult[] = [];
    for (const script of scripts) {
      const result = await this.runCommand(script.command, repoDir);
      results.push(result);
      if (result.exitCode !== 0) {
        if (script.policy === 'best_effort') {
          this.printBestEffortWarning(script.name, result);
          continue;
        }
        this.printVerificationErrors(script.name, result);
        return {
          failure: { attempt, results },
          rewroteTrackedFiles: this.didTrackedFilesChange(
            trackedFileContentsBefore,
            this.captureTrackedFileContents(trackedFilePaths),
          ),
        };
      }
    }

    return {
      failure: null,
      rewroteTrackedFiles: this.didTrackedFilesChange(
        trackedFileContentsBefore,
        this.captureTrackedFileContents(trackedFilePaths),
      ),
    };
  }

  /**
   * Captures current contents for the tracked files.
   *
   * @param trackedFilePaths - Absolute tracked file paths
   * @returns File content snapshot keyed by path
   */
  private captureTrackedFileContents(
    trackedFilePaths: string[],
  ): Map<string, string | null> {
    return new Map(
      trackedFilePaths.map((filePath) => [
        filePath,
        fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null,
      ]),
    );
  }

  /**
   * Compares tracked file snapshots to determine whether verification rewrote them.
   *
   * @param previousSnapshot - Snapshot captured before running verification hooks
   * @param nextSnapshot - Snapshot captured after running verification hooks
   * @returns True when any tracked file changed
   */
  private didTrackedFilesChange(
    previousSnapshot: Map<string, string | null>,
    nextSnapshot: Map<string, string | null>,
  ): boolean {
    for (const [filePath, previousContent] of previousSnapshot.entries()) {
      if ((nextSnapshot.get(filePath) ?? null) !== previousContent) {
        return true;
      }
    }

    return false;
  }

  /**
   * Logs a failed verification command with its diagnostics.
   *
   * @param scriptName - Hook script name
   * @param result - Failed command result
   * @returns Nothing
   */
  private printVerificationErrors(
    scriptName: string,
    result: VerificationCommandResult,
  ): void {
    console.log(chalk.red(`    ${scriptName} failed: ${result.command}`));
    const outputs = [result.stdout, result.stderr].filter(Boolean);
    if (outputs.length === 0) {
      console.log(chalk.red('      No diagnostics were emitted.'));
      return;
    }

    outputs.forEach((output) => {
      output.split('\n').forEach((line) => {
        if (line.trim()) {
          console.log(chalk.red(`      ${line}`));
        }
      });
    });
  }

  private printBestEffortWarning(
    scriptName: string,
    result: VerificationCommandResult,
  ): void {
    console.log(
      chalk.yellow(
        `    ${scriptName} failed but is best-effort: ${result.command}`,
      ),
    );
  }

  /**
   * Runs a shell command in the selected repository and captures the output.
   *
   * @param command - Exact shell command to execute
   * @param cwd - Repository directory
   * @returns Exit code plus captured stdout/stderr
   */
  private async runCommand(
    command: string,
    cwd?: string,
  ): Promise<VerificationCommandResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: cwd ?? process.cwd(),
        maxBuffer: 1024 * 1024 * 10,
      });
      return {
        command,
        exitCode: 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
    } catch (error: any) {
      return {
        command,
        exitCode: error.code ?? 1,
        stdout: error.stdout?.trim?.() ?? '',
        stderr: error.stderr?.trim?.() ?? error.message ?? '',
      };
    }
  }

  /**
   * Collects current disk contents for files implicated in the failure diagnostics.
   *
   * @param repoFiles - All repo files tracked for this run
   * @param repoName - Repository name prefix
   * @param repoDir - Repository directory
   * @returns Map of relative path → file content
   */
  private collectImplicatedFileContents(
    repoFiles: string[],
    repoName: string,
    repoDir?: string,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const filePath of repoFiles) {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`)
          ? filePath.slice(repoName.length + 1)
          : filePath;
      const absolutePath = repoDir
        ? path.join(repoDir, relativePath)
        : path.resolve(relativePath);
      if (fs.existsSync(absolutePath)) {
        result[relativePath] = fs.readFileSync(absolutePath, 'utf-8');
      }
    }
    return result;
  }

  /**
   * Resolves depth-1 import-chain files from the implicated files.
   * Caps at MAX_RELATED_TYPE_FILES total; excludes already-implicated files.
   *
   * @param implicatedRelativePaths - Relative paths of implicated files
   * @param repoDir - Primary repository directory
   * @param additionalRepoDirs - Sibling repository directories for cross-repo reads
   * @returns Map of relative path → file content
   */
  private collectRelatedTypeFiles(
    implicatedRelativePaths: string[],
    repoDir?: string,
    additionalRepoDirs?: string[],
  ): Record<string, string> {
    const allRepoDirs = [repoDir, ...(additionalRepoDirs ?? [])].filter(
      Boolean,
    ) as string[];
    const implicatedSet = new Set(implicatedRelativePaths);
    const collected: Record<string, string> = {};
    const importPattern = /from\s+['"]([^'"]+)['"]/g;

    for (const relativePath of implicatedRelativePaths) {
      if (Object.keys(collected).length >= MAX_RELATED_TYPE_FILES) break;
      const absolutePath = repoDir
        ? path.join(repoDir, relativePath)
        : path.resolve(relativePath);
      if (!fs.existsSync(absolutePath)) continue;

      const content = fs.readFileSync(absolutePath, 'utf-8');
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(content)) !== null) {
        if (Object.keys(collected).length >= MAX_RELATED_TYPE_FILES) break;
        const importPath = match[1];
        if (importPath.startsWith('.')) {
          const importDir = path.dirname(absolutePath);
          for (const ext of ['.ts', '.tsx', '']) {
            const candidate = path.resolve(importDir, `${importPath}${ext}`);
            for (const baseDir of allRepoDirs) {
              const rel = path.relative(baseDir, candidate);
              if (
                !rel.startsWith('..') &&
                !implicatedSet.has(rel) &&
                !(rel in collected)
              ) {
                if (fs.existsSync(candidate)) {
                  collected[rel] = fs.readFileSync(candidate, 'utf-8');
                }
              }
            }
          }
        }
      }
      importPattern.lastIndex = 0;
    }

    return collected;
  }

  /**
   * Collects test source files related to the failure, when test patterns are detected.
   *
   * @param failure - Verification failure details
   * @param repoDir - Primary repository directory
   * @param additionalRepoDirs - Sibling repository directories
   * @returns Map of relative path → file content (empty when no test failure detected)
   */
  private collectTestSources(
    failure: VerificationFailure,
    repoDir?: string,
    additionalRepoDirs?: string[],
  ): Record<string, string> {
    const diagnosticText = failure.results
      .flatMap((r) => [r.stdout, r.stderr])
      .filter(Boolean)
      .join('\n');

    const isTestFailure =
      /● |expect\(|received|assertion|✕|✗|FAIL\s|0 passing|[0-9]+ failing/i.test(
        diagnosticText,
      );

    if (!isTestFailure) return {};

    const allRepoDirs = [repoDir, ...(additionalRepoDirs ?? [])].filter(
      Boolean,
    ) as string[];
    const result: Record<string, string> = {};

    for (const baseDir of allRepoDirs) {
      // Find test files referenced in the diagnostic output
      const specPattern = /([^\s'"]+\.spec\.[jt]sx?)/g;
      const testPattern = /([^\s'"]+\.test\.[jt]sx?)/g;
      const matchedFiles: string[] = [];

      for (const pat of [specPattern, testPattern]) {
        let m: RegExpExecArray | null;
        while ((m = pat.exec(diagnosticText)) !== null) {
          matchedFiles.push(m[1]);
        }
      }

      for (const matched of matchedFiles) {
        const absPath = path.isAbsolute(matched)
          ? matched
          : path.resolve(baseDir, matched);
        if (fs.existsSync(absPath)) {
          const rel = path.relative(baseDir, absPath);
          if (!(rel in result)) {
            result[rel] = fs.readFileSync(absPath, 'utf-8');
          }
        }
      }
    }

    return result;
  }

  /**
   * Orchestrates the two-phase diagnosis: collects file evidence then calls AI for a FixPlan.
   * Returns null when the AI call fails (caller falls back to prose retry).
   *
   * @param failure - Verification failure from the last attempt
   * @param retryRepoFiles - Files targeted for this retry pass
   * @param repoName - Repository name prefix
   * @param planSteps - Original plan steps
   * @param repoDir - Primary repository directory
   * @param additionalRepoDirs - Sibling repository directories
   * @returns Structured FixPlan or null on parse failure
   */
  private async diagnoseRetryFailure(
    failure: VerificationFailure,
    retryRepoFiles: string[],
    repoName: string,
    planSteps: string[],
    repoDir?: string,
    additionalRepoDirs?: string[],
  ): Promise<FixPlan | null> {
    const implicatedFileContents = this.collectImplicatedFileContents(
      retryRepoFiles,
      repoName,
      repoDir,
    );
    const implicatedRelativePaths = Object.keys(implicatedFileContents);
    const relatedFileContents = this.collectRelatedTypeFiles(
      implicatedRelativePaths,
      repoDir,
      additionalRepoDirs,
    );
    const testSources = this.collectTestSources(
      failure,
      repoDir,
      additionalRepoDirs,
    );
    const repoContext = this.collectRetryRepoContext(repoDir);
    const diagnostics = this.formatVerificationFailureMessage(failure);

    try {
      const fixPlan = await this.aiService.diagnoseVerificationFailure({
        implicatedFileContents,
        relatedFileContents,
        testSources,
        repoContext,
        diagnostics,
        planSteps,
      });
      return fixPlan;
    } catch (err) {
      console.log(
        chalk.yellow(
          `    ⚠ diagnoseVerificationFailure returned malformed JSON; falling back to prose retry. ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return null;
    }
  }

  /**
   * Builds retry context that feeds verification diagnostics back into the next AI pass.
   *
   * @param baseContext - Existing conversation context from the caller
   * @param failure - Verification failure details from the last attempt
   * @returns Combined context string
   */
  private buildRetryContext(
    baseContext: string | undefined,
    failure: VerificationFailure,
    retryRepoFiles: string[],
    repoName: string,
  ): string {
    const diagnostics = this.formatVerificationFailureMessage(failure);
    const relativeRetryFiles = retryRepoFiles.map((filePath) =>
      repoName && filePath.startsWith(`${repoName}/`)
        ? filePath.slice(repoName.length + 1)
        : filePath,
    );
    const retryGuidance = [
      'Retry guidance:',
      'Treat verification diagnostics as evidence of a mismatch, not as the source of truth.',
      'Apply the minimum code change that fixes the diagnostic. Do not output explanation, reasoning, or commentary.',
      `Only update the implicated file(s) for this retry: ${relativeRetryFiles.join(', ')}`,
      'Do not widen the change scope beyond those files unless the diagnostics explicitly require it.',
    ].join('\n');

    return [baseContext, retryGuidance, diagnostics]
      .filter(Boolean)
      .join('\n\n');
  }

  private inferRetryRepoFiles(
    failure: VerificationFailure,
    repoFiles: string[],
    repoName: string,
    repoDir?: string,
  ): string[] | null {
    const diagnosticText = failure.results
      .flatMap((result) => [result.stdout, result.stderr])
      .filter(Boolean)
      .join('\n');

    const implicatedFiles = repoFiles.filter((filePath) => {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`)
          ? filePath.slice(repoName.length + 1)
          : filePath;
      const absolutePath = repoDir
        ? path.join(repoDir, relativePath)
        : path.resolve(relativePath);

      return (
        diagnosticText.includes(filePath) ||
        diagnosticText.includes(relativePath) ||
        diagnosticText.includes(absolutePath)
      );
    });

    if (implicatedFiles.length === 0) {
      return null;
    }

    const relativeRepoFiles = repoFiles.map((filePath) =>
      repoName && filePath.startsWith(`${repoName}/`)
        ? filePath.slice(repoName.length + 1)
        : filePath,
    );
    const impliedRelativePaths = new Set<string>();

    for (const filePath of implicatedFiles) {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`)
          ? filePath.slice(repoName.length + 1)
          : filePath;
      impliedRelativePaths.add(relativePath);

      for (const companionPath of this.findRetryCompanionFiles(
        relativePath,
        relativeRepoFiles,
      )) {
        impliedRelativePaths.add(companionPath);
      }
    }

    return repoFiles.filter((filePath) => {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`)
          ? filePath.slice(repoName.length + 1)
          : filePath;
      return impliedRelativePaths.has(relativePath);
    });
  }

  /**
   * Chooses the file set for the next retry attempt.
   *
   * Prefers explicit diagnosis output, then the latest path-based diagnostics,
   * and finally preserves the current narrowed retry scope when newer errors
   * do not mention any additional files.
   *
   * @param params - Retry selection context
   * @returns Repo-prefixed file paths for the next retry pass
   */
  private selectRetryRepoFiles(params: {
    currentRetryRepoFiles: string[];
    repoFiles: string[];
    repoName: string;
    repoDir?: string;
    failure: VerificationFailure;
    fixPlan?: FixPlan;
  }): string[] {
    const inferredRetryRepoFiles =
      this.inferRetryRepoFiles(
        params.failure,
        params.repoFiles,
        params.repoName,
        params.repoDir,
      ) ?? [];
    const fixPlanRetryRepoFiles = this.resolveFixPlanRetryRepoFiles(
      params.fixPlan,
      params.repoFiles,
      params.repoName,
    );

    if (fixPlanRetryRepoFiles.length > 0) {
      return fixPlanRetryRepoFiles;
    }

    if (inferredRetryRepoFiles.length > 0) {
      return inferredRetryRepoFiles;
    }

    return params.currentRetryRepoFiles;
  }

  /**
   * Maps diagnosis fix-plan entries back to the tracked repo file set.
   *
   * Includes paired source/spec companions so source and regression edits stay
   * synchronized on the next retry attempt.
   *
   * @param fixPlan - Structured diagnosis output for the failed verification pass
   * @param repoFiles - Files assigned to the selected repository
   * @param repoName - Repository name prefix
   * @returns Repo-prefixed file paths selected from the fix plan
   */
  private resolveFixPlanRetryRepoFiles(
    fixPlan: FixPlan | undefined,
    repoFiles: string[],
    repoName: string,
  ): string[] {
    if (!fixPlan || fixPlan.fixes.length === 0) {
      return [];
    }

    const repoFileByRelativePath = new Map<string, string>();
    for (const filePath of repoFiles) {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`)
          ? filePath.slice(repoName.length + 1)
          : filePath;
      repoFileByRelativePath.set(relativePath, filePath);
    }

    const selectedRelativePaths = new Set<string>();
    for (const fix of fixPlan.fixes) {
      const relativePath =
        repoName && fix.file.startsWith(`${repoName}/`)
          ? fix.file.slice(repoName.length + 1)
          : fix.file;
      if (!repoFileByRelativePath.has(relativePath)) {
        continue;
      }

      selectedRelativePaths.add(relativePath);
      for (const companionPath of this.findRetryCompanionFiles(relativePath, [
        ...repoFileByRelativePath.keys(),
      ])) {
        selectedRelativePaths.add(companionPath);
      }
    }

    return [...selectedRelativePaths]
      .map((relativePath) => repoFileByRelativePath.get(relativePath))
      .filter((filePath): filePath is string => Boolean(filePath));
  }

  private findRetryCompanionFiles(
    relativePath: string,
    repoRelativePaths: string[],
  ): string[] {
    const fileExtension = path.extname(relativePath);
    const fileWithoutExtension = fileExtension
      ? relativePath.slice(0, -fileExtension.length)
      : relativePath;
    const companionBases = new Set<string>();

    if (fileWithoutExtension.endsWith('.spec')) {
      companionBases.add(fileWithoutExtension.slice(0, -'.spec'.length));
    } else if (fileWithoutExtension.endsWith('.test')) {
      companionBases.add(fileWithoutExtension.slice(0, -'.test'.length));
    } else {
      companionBases.add(`${fileWithoutExtension}.spec`);
      companionBases.add(`${fileWithoutExtension}.test`);
    }

    return repoRelativePaths.filter((candidatePath) => {
      if (candidatePath === relativePath) {
        return false;
      }

      const candidateExtension = path.extname(candidatePath);
      const candidateWithoutExtension = candidateExtension
        ? candidatePath.slice(0, -candidateExtension.length)
        : candidatePath;

      return companionBases.has(candidateWithoutExtension);
    });
  }

  /**
   * Fingerprints the leading verification diagnostics to detect repeated failures.
   *
   * @param failure - Verification failure details from the last attempt
   * @param lineCount - Maximum number of diagnostic lines to hash
   * @returns Stable failure fingerprint
   */
  private buildFailureFingerprint(
    failure: VerificationFailure,
    lineCount: number,
  ): string {
    const leadingLines = failure.results
      .flatMap((result) => {
        const outputs = [result.stdout, result.stderr]
          .filter(Boolean)
          .join('\n')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        return [`Command: ${result.command}`, ...outputs];
      })
      .slice(0, lineCount)
      .join('\n')
      .toLowerCase();

    return createHash('sha256').update(leadingLines).digest('hex');
  }

  /**
   * Determines whether the captured diagnostics contain actionable error text.
   *
   * @param failure - Verification failure details from the last attempt
   * @returns True when diagnostics contain actionable content
   */
  private hasActionableDiagnostics(failure: VerificationFailure): boolean {
    return failure.results.some((result) =>
      [result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .split('\n')
        .some((line) => ACTIONABLE_DIAGNOSTIC_PATTERN.test(line)),
    );
  }

  private detectVerificationSetupIssue(
    failure: VerificationFailure,
    repoDir?: string,
  ): VerificationSetupIssue | null {
    const failedResult = failure.results.find(
      (result) => result.exitCode !== 0,
    );
    if (!failedResult) {
      return null;
    }

    const cdPrefixMatch = failedResult.command
      .trim()
      .match(/^cd\s+(.+?)\s*&&\s*(.+)$/);
    if (!cdPrefixMatch) {
      return null;
    }

    const output = [failedResult.stdout, failedResult.stderr]
      .filter(Boolean)
      .join('\n');
    if (!/no such file or directory|can't cd to|cannot cd to/i.test(output)) {
      return null;
    }

    const repoName = repoDir ? path.basename(repoDir) : undefined;

    return {
      summary: repoName
        ? `Verification command "${failedResult.command}" assumes a different working directory. issue:implement already runs inside ${repoName}, so fix the verification command instead of retrying code generation.`
        : `Verification command "${failedResult.command}" assumes a missing working directory. Fix the verification command instead of retrying code generation.`,
    };
  }

  /**
   * Determines whether verification is converging enough to justify another retry.
   *
   * @param params - Consecutive failure snapshots plus state-change signal
   * @returns Progress assessment for retry extension decisions
   */
  private assessVerificationProgress(params: {
    previousFailure?: VerificationFailure;
    furthestFailure?: VerificationFailure;
    currentFailure: VerificationFailure;
    trackedFilesChanged: boolean;
  }): VerificationProgress {
    if (!params.previousFailure) {
      return {
        isMeaningful: true,
        summary:
          'First verification failure captured; using base retry budget.',
      };
    }

    const previousFailureScriptIndex =
      params.previousFailure.results.length - 1;
    const currentFailureScriptIndex = params.currentFailure.results.length - 1;
    const furthestFailure = params.furthestFailure ?? params.previousFailure;
    const furthestFailureScriptIndex = furthestFailure.results.length - 1;
    const previousDiagnosticLineCount = this.countDiagnosticLines(
      params.previousFailure,
    );
    const currentDiagnosticLineCount = this.countDiagnosticLines(
      params.currentFailure,
    );
    const furthestDiagnosticLineCount =
      this.countDiagnosticLines(furthestFailure);
    const previousErrorClasses = this.extractErrorClasses(
      params.previousFailure,
    );
    const currentErrorClasses = this.extractErrorClasses(params.currentFailure);
    const furthestErrorClasses = this.extractErrorClasses(furthestFailure);
    const resolvedErrorClasses = [...previousErrorClasses].filter(
      (errorClass) => !currentErrorClasses.has(errorClass),
    );
    const resolvedHigherSeverityClasses = [...furthestErrorClasses].filter(
      (errorClass) => !currentErrorClasses.has(errorClass),
    );
    const introducedErrorClasses = [...currentErrorClasses].filter(
      (errorClass) => !previousErrorClasses.has(errorClass),
    );
    const stageAdvanced =
      currentFailureScriptIndex > previousFailureScriptIndex;
    const stageRegressed =
      currentFailureScriptIndex < previousFailureScriptIndex;
    const regressedFromFurthest =
      currentFailureScriptIndex < furthestFailureScriptIndex;
    const diagnosticLinesReduced =
      currentDiagnosticLineCount < previousDiagnosticLineCount;
    const diagnosticsMuchSmallerThanFurthest =
      currentDiagnosticLineCount < furthestDiagnosticLineCount;
    const errorClassesImproved =
      resolvedErrorClasses.length > 0 &&
      introducedErrorClasses.length <= resolvedErrorClasses.length;
    const previousHighestSeverity =
      this.getHighestErrorSeverity(previousErrorClasses);
    const currentHighestSeverity =
      this.getHighestErrorSeverity(currentErrorClasses);
    const furthestHighestSeverity =
      this.getHighestErrorSeverity(furthestErrorClasses);
    const severityImprovedFromPrevious =
      currentHighestSeverity < previousHighestSeverity;
    const severityImprovedFromFurthest =
      currentHighestSeverity < furthestHighestSeverity;
    const convergingResidualRegression =
      params.trackedFilesChanged &&
      regressedFromFurthest &&
      diagnosticsMuchSmallerThanFurthest &&
      severityImprovedFromFurthest;
    const isMeaningful =
      (!stageRegressed && stageAdvanced) ||
      (params.trackedFilesChanged &&
        !stageRegressed &&
        (diagnosticLinesReduced ||
          errorClassesImproved ||
          severityImprovedFromPrevious)) ||
      convergingResidualRegression;

    const reasons: string[] = [];
    if (stageAdvanced) {
      reasons.push('verification advanced to a later script');
    }
    if (stageRegressed) {
      reasons.push('verification regressed to an earlier script');
    }
    if (params.trackedFilesChanged && diagnosticLinesReduced) {
      reasons.push('diagnostic output shrank after file changes');
    }
    if (params.trackedFilesChanged && errorClassesImproved) {
      reasons.push(
        `resolved error classes: ${resolvedErrorClasses.join(', ')}`,
      );
    }
    if (
      params.trackedFilesChanged &&
      !stageRegressed &&
      severityImprovedFromPrevious
    ) {
      reasons.push('highest-severity diagnostics decreased');
    }
    if (convergingResidualRegression) {
      reasons.push(
        `higher-severity failure classes resolved despite regression: ${resolvedHigherSeverityClasses.join(', ') || 'previous blockers removed'}`,
      );
      reasons.push(
        'remaining diagnostics shrank to a smaller residual lint/type failure',
      );
    }

    return {
      isMeaningful,
      summary: isMeaningful
        ? `Progress detected: ${reasons.join('; ')}.`
        : stageRegressed
          ? `Verification regressed to an earlier script. ${reasons.join('; ')}.`
          : 'Verification did not advance to a later script or materially reduce the diagnostics.',
    };
  }

  private getHighestErrorSeverity(errorClasses: Set<string>): number {
    return [...errorClasses].reduce(
      (highestSeverity, errorClass) =>
        Math.max(highestSeverity, ERROR_CLASS_SEVERITY[errorClass] ?? 0),
      0,
    );
  }

  private selectFurthestFailure(
    currentBest: VerificationFailure | undefined,
    candidate: VerificationFailure,
  ): VerificationFailure {
    if (!currentBest) {
      return candidate;
    }

    if (candidate.results.length > currentBest.results.length) {
      return candidate;
    }

    if (candidate.results.length < currentBest.results.length) {
      return currentBest;
    }

    const candidateSeverity = this.getHighestErrorSeverity(
      this.extractErrorClasses(candidate),
    );
    const currentBestSeverity = this.getHighestErrorSeverity(
      this.extractErrorClasses(currentBest),
    );

    return candidateSeverity >= currentBestSeverity ? candidate : currentBest;
  }

  private collectRetryRepoContext(repoDir?: string): RetryRepoContext {
    const configFiles: Record<string, string> = {};
    const candidateConfigFiles = [
      'jest.config.ts',
      'jest.config.js',
      'jest.config.cjs',
      'jest.config.mjs',
      'vitest.config.ts',
      'vitest.config.js',
      'mocha.opts',
      '.mocharc.json',
      '.mocharc.js',
      'tsconfig.json',
    ];
    const packageJsonPath = path.join(repoDir ?? process.cwd(), 'package.json');
    const packageJson = fs.existsSync(packageJsonPath)
      ? fs.readFileSync(packageJsonPath, 'utf-8')
      : undefined;

    for (const fileName of candidateConfigFiles) {
      const configPath = path.join(repoDir ?? process.cwd(), fileName);
      if (fs.existsSync(configPath)) {
        configFiles[fileName] = fs.readFileSync(configPath, 'utf-8');
      }
    }

    return {
      packageJson,
      configFiles,
    };
  }

  /**
   * Counts non-empty diagnostic lines across command stdout/stderr outputs.
   *
   * @param failure - Verification failure details
   * @returns Number of diagnostic lines
   */
  private countDiagnosticLines(failure: VerificationFailure): number {
    return failure.results.reduce((lineCount, result) => {
      const diagnosticLines = [result.stdout, result.stderr]
        .filter(Boolean)
        .flatMap((output) => output.split('\n'))
        .map((line) => line.trim())
        .filter(Boolean);

      return lineCount + diagnosticLines.length;
    }, 0);
  }

  /**
   * Classifies diagnostic output into coarse error categories for progress checks.
   *
   * @param failure - Verification failure details
   * @returns Set of detected error classes
   */
  private extractErrorClasses(failure: VerificationFailure): Set<string> {
    const errorClasses = new Set<string>();
    const diagnosticText = failure.results
      .flatMap((result) => [result.stdout, result.stderr])
      .filter(Boolean)
      .join('\n')
      .toLowerCase();

    if (/prettier|format|code style/.test(diagnosticText)) {
      errorClasses.add('format');
    }
    if (/eslint|lint|no-[a-z-]+/.test(diagnosticText)) {
      errorClasses.add('lint');
    }
    if (
      /syntaxerror|parsing error|unexpected token|ts1005/.test(diagnosticText)
    ) {
      errorClasses.add('syntax');
    }
    if (
      /typeerror|type .* assignable|ts2322|ts2345|ts2741|ts2769/.test(
        diagnosticText,
      )
    ) {
      errorClasses.add('type');
    }
    if (
      /referenceerror|cannot find name|not defined|ts2304/.test(diagnosticText)
    ) {
      errorClasses.add('reference');
    }
    if (/cannot find module|module not found|ts2307/.test(diagnosticText)) {
      errorClasses.add('module');
    }
    if (/fail\s|expected:|received:|expect\(|assertion/.test(diagnosticText)) {
      errorClasses.add('test');
    }

    if (errorClasses.size === 0 && diagnosticText.trim()) {
      errorClasses.add('generic');
    }

    return errorClasses;
  }

  /**
   * Formats the latest verification failure for logs and AI retry prompts.
   *
   * @param failure - Verification failure details from the last attempt
   * @returns Concise failure summary with command outputs
   */
  private formatVerificationFailureMessage(
    failure: VerificationFailure,
  ): string {
    const renderedResults = failure.results
      .map((result) => {
        const outputs = [result.stdout, result.stderr]
          .filter(Boolean)
          .join('\n');
        return [`Command: ${result.command}`, outputs && `Output:\n${outputs}`]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');

    return `Verification failed on attempt ${failure.attempt}.\n\n${renderedResults}`.trim();
  }

  /**
   * Formats a terminal verification exit message with workflow resume guidance.
   *
   * @param params - Exit message details
   * @returns Combined error message
   */
  private formatVerificationExitMessage(params: {
    ticketKey: string;
    repoDir?: string;
    summary: string;
    failure?: VerificationFailure;
  }): string {
    const repoName = params.repoDir ? path.basename(params.repoDir) : '';
    const repoOption = repoName ? ` --repos ${repoName}` : '';
    const resumeCommand = `wf issue ${params.ticketKey} --from review${repoOption}`;
    const failureDetails = params.failure
      ? `\n\n${this.formatVerificationFailureMessage(params.failure)}`
      : '';

    return `${params.summary}${failureDetails}\n\nResolve the underlying problem, then resume the workflow with:\n${resumeCommand}`.trim();
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

    const dir = path.dirname(findingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.writeFile(
      findingsPath,
      JSON.stringify(findings, null, 2),
      'utf-8',
    );

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
    platformName: string,
  ): string {
    const prefixMapping = this.configService.get<
      Record<ResolutionAction, string>
    >('branching.prefixMapping', DEFAULT_PREFIX_MAPPING);
    const prefix = prefixMapping[action] || 'feature';

    // Atlassian platforms (jira, bitbucket) use uppercase ticket keys
    const isAtlassian = platformName === 'jira' || platformName === 'bitbucket';
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
