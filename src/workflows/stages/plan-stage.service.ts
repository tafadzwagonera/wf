import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AiService, ResolutionPlan } from '../../integrations/ai/ai.service';
import { StageAgentService } from '../../integrations/ai/stage-agent.service';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  parsePlanArtifact,
  hashPlanArtifactSources,
  resolvePlanArtifactReference,
  writePlanArtifactManifest,
} from '../../shared/utils/plan-artifact';
import { PlanArtifact, PlannerOptions, ResolutionAction, TicketArtifact } from '../../agents/interfaces';
import { detectTestInfra } from '../../shared/utils/detect-test-infra';
import type { RepoConventionsContext } from '../../shared/utils/detect-repo-conventions';
import type { PriorTicketContext } from '../../shared/utils/detect-prior-tickets';
import type { CrossRepoContext } from '../../shared/utils/detect-cross-repo-patterns';
import type { RecurrenceGapAnalysis } from '../../shared/utils/detect-recurrence-gaps';

interface GeneratePlanOptions {
  action: ResolutionAction;
  ticketKey?: string;
  affectedRepositories?: string[];
  repoDir?: string;
  conventions?: RepoConventionsContext;
  priorTickets?: PriorTicketContext;
  crossRepoPatterns?: CrossRepoContext;
  recurrenceGaps?: RecurrenceGapAnalysis | null;
}

@Injectable()
export class PlanStageService {
  constructor(
    private readonly aiService: AiService,
    private readonly stageAgentService: StageAgentService
  ) {}

  async generatePlan(ticketContent: string, options: GeneratePlanOptions): Promise<ResolutionPlan> {
    const testInfra = detectTestInfra(options.repoDir ?? process.cwd());

    if (this.stageAgentService.isEnabledForStage('plan')) {
      return this.stageAgentService.generatePlan({
        action: options.action,
        issueContent: ticketContent,
        ticketKey: options.ticketKey,
        affectedRepositories: options.affectedRepositories,
        testInfra,
        conventions: options.conventions,
        priorTickets: options.priorTickets,
        crossRepoPatterns: options.crossRepoPatterns,
        recurrenceGaps: options.recurrenceGaps,
      });
    }

    return this.aiService.generatePlan(options.action as any, ticketContent, {
      ticketKey: options.ticketKey,
      summary: this.extractSummary(ticketContent),
      affectedRepositories: options.affectedRepositories,
      testInfra,
      conventions: options.conventions,
      priorTickets: options.priorTickets,
      crossRepoPatterns: options.crossRepoPatterns,
      recurrenceGaps: options.recurrenceGaps,
    });
  }

  async createPlanArtifact(ticket: TicketArtifact, options: PlannerOptions): Promise<PlanArtifact> {
    const artifactDir = path.dirname(ticket.path);
    const sourceName = ticket.ticketKey;
    const planHash = hashPlanArtifactSources([sourceName]);

    if (options.skipExisting) {
      try {
        const existing = resolvePlanArtifactReference(sourceName, {
          artifactDir,
          action: options.action,
        });
        return {
          plan: this.readPlan(existing.artifactPath),
          action: options.action,
          path: existing.artifactPath,
          fromCache: true,
        };
      } catch {
        // No existing plan artifact could be resolved; fall through to generation.
      }
    }

    const plan = await this.generatePlan(ticket.content, {
      action: options.action,
      ticketKey: ticket.ticketKey,
      affectedRepositories: options.affectedRepositories,
    });

    const createdAt = new Date();
    const planPath = path.join(
      artifactDir,
      buildPlanArtifactFilename({
        createdAt,
        hash: planHash,
        action: options.action,
        format: 'json',
      })
    );

    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    writePlanArtifactManifest(
      buildPlanArtifactManifest(planPath, options.action, 'json', planHash, sourceName, 'ticket', createdAt)
    );
    this.deleteStalePlanArtifacts(artifactDir, planHash, options.action, planPath);
    return { plan, action: options.action, path: planPath, fromCache: false };
  }

  loadPlanArtifact(ticketPath: string, action?: ResolutionAction): PlanArtifact {
    const artifactDir = path.dirname(ticketPath);
    const sourceName = path.basename(ticketPath, '.md');
    const resolved = resolvePlanArtifactReference(sourceName, {
      artifactDir,
      action,
    });

    const plan = this.readPlan(resolved.artifactPath);
    if (action && plan.action !== action) {
      throw new Error(
        `Plan action mismatch for ${path.basename(resolved.artifactPath)}: expected ${action}, found ${plan.action}.`
      );
    }

    return {
      plan,
      action: plan.action,
      path: resolved.artifactPath,
      fromCache: true,
    };
  }

  extractSummary(content: string): string {
    const match = content.match(/^#\s+[A-Z]+-\d+:\s+(.+)$/m);
    return match ? match[1] : 'Implementation';
  }

  private readPlan(planPath: string): ResolutionPlan {
    try {
      return parsePlanArtifact(fs.readFileSync(planPath, 'utf-8'), planPath);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : `Plan file is not valid: ${path.basename(planPath)}`);
    }
  }

  private deleteStalePlanArtifacts(
    artifactDir: string,
    sourceHash: string,
    action: ResolutionAction,
    retainedPlanPath: string
  ): void {
    if (!fs.existsSync(artifactDir)) {
      return;
    }

    const candidateFiles = fs.readdirSync(artifactDir).filter(name => name.endsWith('.json'));
    const stalePattern = new RegExp(`^(?:\\d{4}-\\d{2}-\\d{2}-)?${sourceHash}-${action}-plan\\.json$`, 'i');

    for (const name of candidateFiles) {
      if (!stalePattern.test(name)) {
        continue;
      }
      const siblingPath = path.join(artifactDir, name);
      if (siblingPath === retainedPlanPath || !fs.existsSync(siblingPath)) {
        continue;
      }

      fs.unlinkSync(siblingPath);
      const manifestPath = siblingPath.replace(/\.[^.]+$/, '.sources.json');
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
      }
    }
  }
}
