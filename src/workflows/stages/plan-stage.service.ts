import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AiService, ResolutionPlan } from '../../integrations/ai/ai.service';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  parsePlanArtifact,
  hashPlanArtifactSources,
  resolvePlanArtifactReference,
  writePlanArtifactManifest,
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
    const artifactDir = path.dirname(ticket.path);
    const sourceName = ticket.ticketKey;
    const planHash = hashPlanArtifactSources([sourceName]);
    const planPath = path.join(
      artifactDir,
      buildPlanArtifactFilename({
        hash: planHash,
        action: options.action,
        format: 'json',
      }),
    );

    if (options.skipExisting && fs.existsSync(planPath)) {
      return {
        plan: this.readPlan(planPath),
        action: options.action,
        path: planPath,
        fromCache: true,
      };
    }

    if (options.skipExisting) {
      try {
        const existing = resolvePlanArtifactReference(sourceName, {
          artifactDir,
          action: options.action,
        });
        const plan = this.readPlan(existing.artifactPath);
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
        writePlanArtifactManifest(
          buildPlanArtifactManifest(
            planPath,
            options.action,
            'json',
            planHash,
            sourceName,
            'ticket',
            new Date(),
          ),
        );
        this.deleteLegacyPlanArtifacts(
          artifactDir,
          sourceName,
          options.action,
          planPath,
        );
        return {
          plan,
          action: options.action,
          path: planPath,
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

    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    writePlanArtifactManifest(
      buildPlanArtifactManifest(
        planPath,
        options.action,
        'json',
        planHash,
        sourceName,
        'ticket',
        new Date(),
      ),
    );
    this.deleteLegacyPlanArtifacts(
      artifactDir,
      sourceName,
      options.action,
      planPath,
    );
    return { plan, action: options.action, path: planPath, fromCache: false };
  }

  loadPlanArtifact(
    ticketPath: string,
    action?: ResolutionAction,
  ): PlanArtifact {
    const artifactDir = path.dirname(ticketPath);
    const sourceName = path.basename(ticketPath, '.md');
    const resolved = resolvePlanArtifactReference(sourceName, {
      artifactDir,
      action,
    });

    const plan = this.readPlan(resolved.artifactPath);
    if (action && plan.action !== action) {
      throw new Error(
        `Plan action mismatch for ${path.basename(resolved.artifactPath)}: expected ${action}, found ${plan.action}.`,
      );
    }

    return {
      plan,
      action: plan.action,
      path: resolved.artifactPath,
      fromCache: resolved.isLegacy,
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
      throw new Error(
        error instanceof Error
          ? error.message
          : `Plan file is not valid: ${path.basename(planPath)}`,
      );
    }
  }

  private deleteLegacyPlanArtifacts(
    artifactDir: string,
    sourceName: string,
    action: ResolutionAction,
    retainedPlanPath: string,
  ): void {
    const siblingHash = hashPlanArtifactSources([sourceName]);
    const extensions: Array<'json' | 'md' | 'yaml' | 'yml'> = [
      'json',
      'md',
      'yaml',
      'yml',
    ];
    const siblingActions: ResolutionAction[] = [
      'feature',
      'fix',
      'investigate',
    ];

    for (const siblingAction of siblingActions) {
      for (const extension of extensions) {
        const hashedSiblingPath = path.join(
          artifactDir,
          buildPlanArtifactFilename({
            hash: siblingHash,
            action: siblingAction,
            format: extension,
          }),
        );
        const legacySiblingPath = path.join(
          artifactDir,
          `${sourceName}-plan-${siblingAction}.${extension}`,
        );

        for (const siblingPath of [hashedSiblingPath, legacySiblingPath]) {
          if (
            siblingPath === retainedPlanPath ||
            siblingAction === action ||
            !fs.existsSync(siblingPath)
          ) {
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
  }
}
