// src/agents/planner.agent.ts
import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import * as path from 'path';
import { TicketArtifact, PlanArtifact, PlannerOptions, ResolutionAction } from './interfaces';
import { PlanStageService } from '../workflows/stages/plan-stage.service';
import { buildPlanArtifactResolutionNotice } from '../shared/utils/plan-artifact';

@Injectable()
export class PlannerAgent {
  constructor(private readonly planStageService: PlanStageService) {}

  /**
   * Generate an implementation plan for a ticket and save it as a JSON artifact.
   *
   * @param ticket - The ticket artifact containing the ticket key, content, and file path
   * @param options - Planner options including action type, affected repositories, and skipExisting flag
   * @returns The PlanArtifact with the generated plan, resolved action, and file path
   */
  async execute(ticket: TicketArtifact, options: PlannerOptions): Promise<PlanArtifact> {
    if (!options.silent) {
      console.log(chalk.bold.yellow('\n🤖 STAGE 2: Generate Implementation Plan'));
      console.log(chalk.gray('─'.repeat(70)));
      console.log(chalk.gray(`  Action type: ${options.action}`));
    }
    const artifact = await this.planStageService.createPlanArtifact(ticket, options);

    if (!options.silent) {
      if (artifact.fromCache) {
        console.log(chalk.yellow(`⚠️  Skipping PLAN - artifact exists: ${artifact.path}`));
      } else if (options.skipExisting === false) {
        console.log(chalk.yellow('⚠️  --force enabled; regenerated plan artifact'));
        console.log(chalk.green('✓ Plan generated'));
      } else {
        console.log(chalk.green('✓ Plan generated'));
      }
      console.log(chalk.bold('  Summary:'), chalk.bold.cyan(artifact.plan.summary));
      console.log(chalk.bold('  Action:'), chalk.cyan(artifact.plan.action));
      console.log(chalk.bold('  Complexity:'), chalk.cyan(artifact.plan.estimatedComplexity));
      console.log(chalk.gray(`  Saved to: ${artifact.path}`));
    }
    return artifact;
  }

  /**
   * Load an existing plan artifact from disk, optionally scoped to a specific action.
   *
   * @param ticketPath - The file path to the ticket markdown artifact
   * @param action - Optional action type to load a specific plan; if omitted, the most recent plan is auto-discovered
   * @returns The PlanArtifact with the loaded plan, resolved action, and file path
   * @throws Error if the specified plan file does not exist or contains invalid JSON
   */
  loadFromDisk(ticketPath: string, action?: ResolutionAction, silent?: boolean): PlanArtifact {
    const artifact = this.planStageService.loadPlanArtifact(ticketPath, action);
    if (!silent) {
      const notice = buildPlanArtifactResolutionNotice({
        action: artifact.action,
        artifactPath: artifact.path,
        isLegacy: !!artifact.fromCache,
        ticketKey: path.basename(ticketPath, path.extname(ticketPath)),
      });
      if (notice) {
        console.log(chalk.yellow(`⚠️  ${notice}`));
      }
      console.log(chalk.gray(`🤖 Using plan: ${path.basename(artifact.path)}`));
    }
    return artifact;
  }
}
