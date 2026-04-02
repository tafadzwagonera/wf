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
} from './interfaces';
import { extractSummary, slugify } from './utils';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const MAX_VERIFICATION_ATTEMPTS = 3;
const TSC_OUTPUT_LINES = 200;

interface VerificationCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PackageScripts {
  build?: string;
  format?: string;
  lint?: string;
}

interface VerificationFailure {
  attempt: number;
  results: VerificationCommandResult[];
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
   * Displays the implementation guide for the given ticket and plan.
   * Generates a branch name, checks the current git branch, and logs
   * the implementation steps from the plan. For investigate actions,
   * calls Claude to generate structured findings and saves a findings artifact.
   *
   * @param ticket - The fetched ticket artifact containing key and content
   * @param planArtifact - The generated plan artifact with steps and metadata
   * @param options - Implementation options including the platform name
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
    const branchName = this.generateBranchName(
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

    const packageScripts = this.readPackageScripts(options.repoDir);
    const sceneContext = `${ticket.content}\n\n---\nPlan narration:\n${narration}`;
    let retryContext = options.conversationContext;

    for (
      let attemptNumber = 1;
      attemptNumber <= MAX_VERIFICATION_ATTEMPTS;
      attemptNumber += 1
    ) {
      if (repoFiles.length > 0) {
        console.log(chalk.bold('\n  Generating code changes...'));
        for (const filePath of repoFiles) {
          // Strip repo-name prefix only when present; bare paths are used as-is.
          const relativePath =
            repoName && filePath.startsWith(`${repoName}/`)
              ? filePath.slice(repoName.length + 1)
              : filePath;
          const absolutePath = options.repoDir
            ? path.join(options.repoDir, relativePath)
            : path.resolve(relativePath);

          const existingContent = fs.existsSync(absolutePath)
            ? fs.readFileSync(absolutePath, 'utf-8')
            : '';

          console.log(chalk.gray(`\n    → ${filePath}`));
          const updatedContent = await this.aiService.generateFileChange({
            ticketContent: sceneContext,
            planSteps: planArtifact.plan.steps,
            filePath: relativePath,
            existingContent,
            conversationContext: retryContext,
          });

          fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
          fs.writeFileSync(absolutePath, updatedContent, 'utf-8');
          console.log(chalk.green(`    ✓ Updated: ${filePath}`));
        }
      }

      console.log(chalk.bold('\n  Verification:'));
      const verificationFailure = await this.verifyImplementation(
        options.repoDir,
        packageScripts,
        attemptNumber,
      );
      if (!verificationFailure) {
        break;
      }

      if (attemptNumber === MAX_VERIFICATION_ATTEMPTS) {
        throw new Error(
          this.formatVerificationFailureMessage(verificationFailure),
        );
      }

      retryContext = this.buildRetryContext(
        options.conversationContext,
        verificationFailure,
      );
      console.log(
        chalk.yellow(
          `    Verification failed on attempt ${attemptNumber}. Regenerating files with diagnostics...`,
        ),
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
        `issue:implement only verifies a single repository. This plan affects multiple repositories: ${repositoriesAffected.join(', ')}. Use wf issue:all or run wf issue:implement separately per repository.`,
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
        `issue:implement can only modify and verify files for ${repoName}. Found paths for other repositories: ${offendingPaths.join(', ')}. Use wf issue:all or run wf issue:implement separately per repository.`,
      );
    }
  }

  /**
   * Reads the current package scripts for the selected repository.
   *
   * @param repoDir - Repository directory where package.json is expected
   * @returns Relevant script names for verification
   */
  private readPackageScripts(repoDir?: string): PackageScripts {
    const packageJsonPath = path.join(repoDir ?? process.cwd(), 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(
        `package.json not found in ${repoDir ?? process.cwd()}. issue:implement requires a Node-based repository to verify format, lint, TypeScript, and build steps.`,
      );
    }

    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf-8'),
    ) as { scripts?: PackageScripts };
    const scripts = packageJson.scripts ?? {};
    if (!scripts.build) {
      throw new Error(
        `package.json in ${repoDir ?? process.cwd()} does not define a build script. issue:implement requires a build script so it can run nr build before succeeding.`,
      );
    }

    return scripts;
  }

  /**
   * Executes the strict verification sequence for the selected repository.
   *
   * @param repoDir - Repository directory to verify
   * @param packageScripts - Available package.json scripts
   * @param attempt - Current retry attempt number
   * @returns Verification failure details, or null when all checks pass
   */
  private async verifyImplementation(
    repoDir: string | undefined,
    packageScripts: PackageScripts,
    attempt: number,
  ): Promise<VerificationFailure | null> {
    const commands: string[] = [];
    if (packageScripts.format) {
      commands.push('nr format');
    }
    if (packageScripts.lint) {
      commands.push('nr lint');
    }
    commands.push(
      `npx tsc --noEmit --pretty 2>&1 | head -n ${TSC_OUTPUT_LINES}`,
    );
    commands.push('nr build');

    const results: VerificationCommandResult[] = [];
    for (const command of commands) {
      const result = await this.runCommand(command, repoDir);
      results.push(result);
      if (result.exitCode !== 0) {
        return { attempt, results };
      }
    }

    return null;
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
   * Builds retry context that feeds verification diagnostics back into the next AI pass.
   *
   * @param baseContext - Existing conversation context from the caller
   * @param failure - Verification failure details from the last attempt
   * @returns Combined context string
   */
  private buildRetryContext(
    baseContext: string | undefined,
    failure: VerificationFailure,
  ): string {
    const diagnostics = this.formatVerificationFailureMessage(failure);
    return [baseContext, diagnostics].filter(Boolean).join('\n\n');
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
}
