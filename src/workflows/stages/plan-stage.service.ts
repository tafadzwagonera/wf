import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AiService, ResolutionPlan } from '../../integrations/ai/ai.service';
import {
  parsePlanArtifact,
  SUPPORTED_PLAN_EXTENSIONS,
} from '../../shared/utils/plan-artifact';
import {
  PlanArtifact,
  PlannerOptions,
  ResolutionAction,
  TicketArtifact,
} from '../../agents/interfaces';

interface GeneratePlanOptions {
  action: ResolutionAction;
  ticketKey?: string;
  affectedRepositories?: string[];
}

@Injectable()
export class PlanStageService {
  constructor(private readonly aiService: AiService) {}

  async generatePlan(
    ticketContent: string,
    options: GeneratePlanOptions,
  ): Promise<ResolutionPlan> {
    return this.aiService.generatePlan(options.action as any, ticketContent, {
      ticketKey: options.ticketKey,
      summary: this.extractSummary(ticketContent),
      affectedRepositories: options.affectedRepositories,
    });
  }

  async createPlanArtifact(
    ticket: TicketArtifact,
    options: PlannerOptions,
  ): Promise<PlanArtifact> {
    const planPath = ticket.path.replace('.md', `-plan-${options.action}.json`);

    if (options.skipExisting && fs.existsSync(planPath)) {
      return {
        plan: this.readPlan(planPath),
        action: options.action,
        path: planPath,
        fromCache: true,
      };
    }

    const plan = await this.generatePlan(ticket.content, {
      action: options.action,
      ticketKey: ticket.ticketKey,
      affectedRepositories: options.affectedRepositories,
    });

    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    return { plan, action: options.action, path: planPath, fromCache: false };
  }

  loadPlanArtifact(
    ticketPath: string,
    action?: ResolutionAction,
  ): PlanArtifact {
    if (action) {
      const planPath = ticketPath.replace('.md', `-plan-${action}.json`);
      if (!fs.existsSync(planPath)) {
        throw new Error(
          `Plan file not found: ${path.basename(planPath)}\nRun with --from plan --action ${action} first.`,
        );
      }

      const plan = this.readPlan(planPath);
      const resolvedAction = (plan.action as ResolutionAction) || action;
      return { plan, action: resolvedAction, path: planPath };
    }

    return this.discoverPlanArtifact(ticketPath);
  }

  extractSummary(content: string): string {
    const match = content.match(/^#\s+[A-Z]+-\d+:\s+(.+)$/m);
    return match ? match[1] : 'Implementation';
  }

  private discoverPlanArtifact(ticketPath: string): PlanArtifact {
    const baseDir = path.dirname(ticketPath);
    const baseName = path.basename(ticketPath, '.md');
    const actions: ResolutionAction[] = ['feature', 'fix', 'investigate'];

    const found = actions
      .flatMap((action) =>
        SUPPORTED_PLAN_EXTENSIONS.map((extension) => {
          const planPath = path.join(
            baseDir,
            `${baseName}-plan-${action}.${extension}`,
          );
          return fs.existsSync(planPath)
            ? {
                action,
                path: planPath,
              }
            : null;
        }),
      )
      .filter(Boolean) as Array<{
      action: ResolutionAction;
      path: string;
    }>;

    if (found.length === 0) {
      throw new Error(
        'No plan file found for ticket.\nRun with --from plan --action <feature|fix|investigate> first.',
      );
    }

    if (found.length > 1) {
      throw new Error(
        `Multiple plan files found for ticket: ${found
          .map((artifact) => path.basename(artifact.path))
          .join(', ')}.\nRe-run issue:plan to replace stale artifacts.`,
      );
    }

    const selected = found[0];
    return {
      plan: this.readPlan(selected.path),
      action: selected.action,
      path: selected.path,
    };
  }

  private readPlan(planPath: string): ResolutionPlan {
    try {
      return parsePlanArtifact(fs.readFileSync(planPath, 'utf-8'), planPath);
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : `Plan file is not valid: ${path.basename(planPath)}`,
      );
    }
  }
}
