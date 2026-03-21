// src/agents/implementer.agent.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { GitService } from '../integrations/git/git.service';
import {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  ResolutionAction,
} from './interfaces';
import { extractSummary, slugify } from './utils';

const DEFAULT_PREFIX_MAPPING: Record<ResolutionAction, string> = {
  implement: 'feature',
  fix: 'bugfix',
  investigate: 'chore',
};

@Injectable()
export class ImplementerAgent {
  constructor(
    private configService: ConfigService,
    private gitService: GitService,
  ) {}

  /**
   * Displays the implementation guide for the given ticket and plan.
   * Generates a branch name, checks the current git branch, and logs
   * the implementation steps from the plan.
   *
   * @param ticket - The fetched ticket artifact containing key and content
   * @param planArtifact - The generated plan artifact with steps and metadata
   * @param options - Implementation options including the platform name
   * @returns The generated git branch name for this ticket
   */
  async execute(
    ticket: TicketArtifact,
    planArtifact: PlanArtifact,
    options: ImplementerOptions,
  ): Promise<{ branchName: string }> {
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
      .getCurrentBranch()
      .catch(() => '');
    if (currentBranch === branchName) {
      console.log(chalk.green(`✓ Already on branch: ${branchName}`));
    } else {
      console.log(chalk.bold('  Branch:'), chalk.cyan(branchName));
      console.log(chalk.gray('  Command:'));
      console.log(chalk.cyan(`    git checkout -b ${branchName}`));
    }

    console.log(chalk.bold('\n  Steps:'));
    planArtifact.plan.steps.forEach((step: string, i: number) => {
      console.log(chalk.white(`    ${i + 1}. ${step}`));
    });

    if (planArtifact.plan.filesAffected?.length > 0) {
      console.log(chalk.bold('\n  Files to modify:'));
      planArtifact.plan.filesAffected.forEach((file: string) =>
        console.log(chalk.gray(`    - ${file}`)),
      );
    }

    if (planArtifact.plan.repositoriesAffected?.length > 0) {
      console.log(chalk.bold('\n  Repositories affected:'));
      planArtifact.plan.repositoriesAffected.forEach((repo: string) =>
        console.log(chalk.gray(`    - ${repo}`)),
      );
    }

    console.log(chalk.bold('\n  Status:'));
    console.log(
      chalk.white('    Ready to implement changes according to the plan'),
    );
    console.log(
      chalk.white(
        '    Next stages: review → commit (will execute automatically)',
      ),
    );

    return { branchName };
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
