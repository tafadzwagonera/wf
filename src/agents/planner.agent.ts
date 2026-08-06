import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import { TicketArtifact, PlanArtifact, PlannerOptions, ResolutionAction } from './interfaces';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { PlanStageService } from '../workflows/stages/plan-stage.service';
import { buildPlanArtifactResolutionNotice } from '../shared/utils/plan-artifact';

@Injectable()
export class PlannerAgent {
  constructor(
    private readonly planStageService: PlanStageService,
    private readonly presenter: CliPresenter
  ) {}

  /**
   * Generate an implementation plan for a ticket and save it as a JSON artifact.
   *
   * @param ticket - The ticket artifact containing the ticket key, content, and file path
   * @param options - Planner options including action type, affected repositories, and skipExisting flag
   * @returns The PlanArtifact with the generated plan, resolved action, and file path
   */
  async execute(ticket: TicketArtifact, options: PlannerOptions): Promise<PlanArtifact> {
    if (!options.silent) {
      this.presenter.stageHeader(2, 'Generate Implementation Plan');
      this.presenter.separator();
      this.presenter.progress(`  Action type: ${options.action}`);
    }

    const onProgress = options.silent ? undefined : (line: string) => this.presenter.progress(line);
    const artifact = await this.planStageService.createPlanArtifact(ticket, { ...options, onProgress });

    if (!options.silent) this.logPlanOutcome(artifact, options.skipExisting);
    return artifact;
  }

  private logPlanOutcome(artifact: PlanArtifact & { fromCache?: boolean }, skipExisting?: boolean): void {
    if (artifact.fromCache) {
      this.presenter.outcome('warning', `Skipping PLAN - artifact exists: ${artifact.path}`);
    }
    if (!artifact.fromCache && skipExisting === false) {
      this.presenter.outcome('warning', '--force enabled; regenerated plan artifact');
    }
    if (!artifact.fromCache) {
      this.presenter.outcome('success', 'Plan generated');
    }
    this.presenter.summaryBlock([
      { label: 'Summary', value: artifact.plan.summary },
      { label: 'Action', value: artifact.plan.action },
      { label: 'Complexity', value: artifact.plan.estimatedComplexity },
      { label: 'Saved to', value: artifact.path },
    ]);
  }

  /**
   * Load an existing plan artifact from disk, optionally scoped to a specific action.
   *
   * @param ticketPath - The file path to the ticket markdown artifact
   * @param action - Optional action type to load a specific plan; if omitted, the most recent plan is auto-discovered
   * @param silent
   * @param repoDir - Repository root for test infrastructure detection during plan validation
   * @returns Promise<PlanArtifact> with the loaded plan, resolved action, and file path
   * @throws Error if the specified plan file does not exist or contains invalid JSON
   */
  async loadFromDisk(
    ticketPath: string, action?: ResolutionAction, silent?: boolean, repoDir?: string
  ): Promise<PlanArtifact> {
    const artifact = await this.planStageService.loadPlanArtifact(ticketPath, action, repoDir);
    if (!silent) {
      const notice = buildPlanArtifactResolutionNotice({
        action: artifact.action,
        artifactPath: artifact.path,
        isLegacy: !!artifact.fromCache,
        ticketKey: path.basename(ticketPath, path.extname(ticketPath)),
      });
      if (notice) {
        this.presenter.outcome('warning', notice);
      }
      this.presenter.progress(`Using plan: ${path.basename(artifact.path)}`);
    }
    return artifact;
  }
}
