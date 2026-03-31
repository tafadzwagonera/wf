// src/agents/planner.agent.ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { AiService, ResolutionPlan } from '../integrations/ai/ai.service';
import {
  TicketArtifact,
  PlanArtifact,
  PlannerOptions,
  ResolutionAction,
} from './interfaces';
import { extractSummary } from './utils';

/**
 * Normalizes plan steps to strings, handling AI providers that return step objects
 * (e.g. `{ step: number, description: string }`) instead of plain strings.
 * @param steps Raw steps array from a parsed plan JSON
 * @returns Array of plain strings
 */
const normalizeSteps = (steps: unknown[]): string[] =>
  steps.map((step) => {
    if (typeof step === 'string') return step;
    if (step && typeof step === 'object') {
      const s = step as Record<string, unknown>;
      const text = s['description'] ?? s['text'] ?? s['title'] ?? s['content'];
      if (typeof text === 'string') return text;
    }
    return String(step);
  });

@Injectable()
export class PlannerAgent {
  constructor(private aiService: AiService) {}

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
        plan = { ...plan, steps: normalizeSteps(plan.steps ?? []) };
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

    const plan = await this.aiService.generatePlan(
      options.action as any,
      ticket.content,
      {
        ticketKey: ticket.ticketKey,
        summary: extractSummary(ticket.content),
        affectedRepositories: options.affectedRepositories,
      },
    );

    console.log(chalk.green('✓ Plan generated'));
    console.log(chalk.bold('  Summary:'), chalk.bold.cyan(plan.summary));
    console.log(chalk.bold('  Action:'), chalk.cyan(plan.action));
    console.log(
      chalk.bold('  Complexity:'),
      chalk.cyan(plan.estimatedComplexity),
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
        plan = { ...plan, steps: normalizeSteps(plan.steps ?? []) };
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
