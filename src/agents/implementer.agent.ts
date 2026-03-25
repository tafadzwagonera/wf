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

    console.log(chalk.bold.yellow('\n🔧 STAGE 3: Implementation Guide'));
    console.log(chalk.gray('─'.repeat(70)));

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
        const sceneContext = `${ticket.content}\n\n---\nPlan narration:\n${narration}`;
        const updatedContent = await this.aiService.generateFileChange({
          ticketContent: sceneContext,
          planSteps: planArtifact.plan.steps,
          filePath: relativePath,
          existingContent,
        });

        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, updatedContent, 'utf-8');
        console.log(chalk.green(`    ✓ Updated: ${filePath}`));
      }
    }

    if ((planArtifact.plan.repositoriesAffected?.length ?? 0) > 0) {
      console.log(chalk.bold('\n  Repositories affected:'));
      planArtifact.plan.repositoriesAffected!.forEach((repo: string) =>
        console.log(chalk.gray(`    - ${repo}`)),
      );
    }

    console.log(chalk.bold('\n  Status:'));
    console.log(chalk.cyan('    Changes generated and written to disk'));
    console.log(
      chalk.cyan(
        '    Next stages: review → commit (will execute automatically)',
      ),
    );

    return { type: 'implementation', branchName };
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
