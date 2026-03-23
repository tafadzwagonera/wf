// src/agents/planner.agent.ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import {
  ClaudeService,
  ResolutionPlan,
} from '../integrations/ai/claude.service';
import {
  TicketArtifact,
  PlanArtifact,
  PlannerOptions,
  ResolutionAction,
} from './interfaces';
import { extractSummary } from './utils';

@Injectable()
export class PlannerAgent {
  constructor(private claudeService: ClaudeService) {}

  /**
   * Generate an implementation plan for a ticket and save it as a JSON artifact.
   *
   * @param ticket - The ticket artifact containing the ticket key, content, and file path
   * @param options - Planner options including action type, affected repositories, and skipExisting flag
   * @returns The PlanArtifact with the generated plan, resolved action, and file path
   */
  async execute(
    ticket: TicketArtifact,
    options: PlannerOptions,
  ): Promise<PlanArtifact> {
    const planPath = ticket.path.replace('.md', `-plan-${options.action}.json`);

    if (options.skipExisting && fs.existsSync(planPath)) {
      console.log(
        chalk.gray(`🤖 Skipping PLAN - artifact exists: ${planPath}`),
      );
      let plan: ResolutionPlan;
      try {
        plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as ResolutionPlan;
      } catch {
        throw new Error(
          `Plan file is not valid JSON: ${path.basename(planPath)}`,
        );
      }
      return { plan, action: options.action, path: planPath, fromCache: true };
    }

    console.log(
      chalk.bold.yellow('\n🤖 STAGE 2: Generate Implementation Plan'),
    );
    console.log(chalk.gray('─'.repeat(70)));
    console.log(chalk.gray(`  Action type: ${options.action}`));

    const plan = await this.claudeService.generatePlan(
      options.action as any,
      ticket.content,
      {
        ticketKey: ticket.ticketKey,
        summary: extractSummary(ticket.content),
        affectedRepositories: options.affectedRepositories,
      },
    );

    console.log(chalk.green('✓ Plan generated'));
    console.log(chalk.bold('  Summary:'), chalk.white(plan.summary));
    console.log(chalk.bold('  Action:'), chalk.white(plan.action));
    console.log(
      chalk.bold('  Complexity:'),
      chalk.white(plan.estimatedComplexity),
    );

    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    console.log(chalk.gray(`  Saved to: ${planPath}`));

    return { plan, action: options.action, path: planPath, fromCache: false };
  }

  /**
   * Load an existing plan artifact from disk, optionally scoped to a specific action.
   *
   * @param ticketPath - The file path to the ticket markdown artifact
   * @param action - Optional action type to load a specific plan; if omitted, the most recent plan is auto-discovered
   * @returns The PlanArtifact with the loaded plan, resolved action, and file path
   * @throws Error if the specified plan file does not exist or contains invalid JSON
   */
  loadFromDisk(ticketPath: string, action?: ResolutionAction): PlanArtifact {
    if (action) {
      const planPath = ticketPath.replace('.md', `-plan-${action}.json`);
      if (!fs.existsSync(planPath)) {
        throw new Error(
          `Plan file not found: ${path.basename(planPath)}\nRun with --from plan --action ${action} first.`,
        );
      }
      let plan: ResolutionPlan;
      try {
        plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as ResolutionPlan;
      } catch {
        throw new Error(
          `Plan file is not valid JSON: ${path.basename(planPath)}`,
        );
      }
      if (plan.action && action !== plan.action) {
        console.log(
          chalk.yellow(
            `⚠ --action ${action} differs from plan's action: ${plan.action}`,
          ),
        );
        console.log(chalk.yellow(`  Using plan's action: ${plan.action}`));
      }
      const resolvedAction = (plan.action as ResolutionAction) || action;
      console.log(chalk.gray(`🤖 Using plan: ${path.basename(planPath)}`));
      return { plan, action: resolvedAction, path: planPath };
    }
    return this.discoverPlan(ticketPath);
  }

  private discoverPlan(ticketPath: string): PlanArtifact {
    const baseDir = path.dirname(ticketPath);
    const baseName = path.basename(ticketPath, '.md');
    const actions: ResolutionAction[] = ['feature', 'fix', 'investigate'];

    const found = actions
      .map((a) => {
        const p = path.join(baseDir, `${baseName}-plan-${a}.json`);
        return fs.existsSync(p)
          ? { path: p, action: a, mtime: fs.statSync(p).mtime }
          : null;
      })
      .filter(Boolean) as Array<{
      path: string;
      action: ResolutionAction;
      mtime: Date;
    }>;

    if (found.length === 0) {
      throw new Error(
        'No plan file found for ticket.\nRun with --from plan --action <feature|fix|investigate> first.',
      );
    }

    found.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (found.length > 1) {
      console.log(
        chalk.yellow(
          `⚠ Multiple plans found (${found.map((p) => p.action).join(', ')})`,
        ),
      );
      console.log(chalk.yellow(`  Using most recent: ${found[0].action}`));
    }

    const selected = found[0];
    let plan: ResolutionPlan;
    try {
      plan = JSON.parse(
        fs.readFileSync(selected.path, 'utf-8'),
      ) as ResolutionPlan;
    } catch {
      throw new Error(
        `Plan file is not valid JSON: ${path.basename(selected.path)}`,
      );
    }
    console.log(
      chalk.gray(
        `🤖 Auto-discovered plan: ${path.basename(selected.path)} (action: ${selected.action})`,
      ),
    );
    return { plan, action: selected.action, path: selected.path };
  }
}
