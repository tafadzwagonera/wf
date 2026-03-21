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

@Injectable()
export class ImplementerAgent {
  constructor(
    private configService: ConfigService,
    private gitService: GitService,
  ) {}

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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { plan } = planArtifact;
    if (plan) {
      console.log(chalk.bold('\n  Steps:'));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (plan.steps as string[]).forEach((step: string, i: number) => {
        console.log(chalk.white(`    ${i + 1}. ${step}`));
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if ((plan.filesAffected as string[] | undefined)?.length > 0) {
        console.log(chalk.bold('\n  Files to modify:'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (plan.filesAffected as string[]).forEach((file: string) =>
          console.log(chalk.gray(`    - ${file}`)),
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if ((plan.repositoriesAffected as string[] | undefined)?.length > 0) {
        console.log(chalk.bold('\n  Repositories affected:'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (plan.repositoriesAffected as string[]).forEach((repo: string) =>
          console.log(chalk.gray(`    - ${repo}`)),
        );
      }
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
    >('branching.prefixMapping', {
      implement: 'feature',
      fix: 'bugfix',
      investigate: 'chore',
    });
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
    if (pattern && !new RegExp(pattern).test(branchName)) {
      console.log(
        chalk.yellow(
          `⚠ Generated branch name "${branchName}" does not match platform pattern: ${pattern}`,
        ),
      );
    }

    return branchName;
  }
}
