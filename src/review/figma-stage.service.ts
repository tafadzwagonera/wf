import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FigmaFrameContext, FigmaRestClient } from '../integrations/figma/figma-rest.client';
import { GitService } from '../integrations/git/git.service';
import { LoggerService } from '../shared/logger/logger.service';
import {
  findPlanArtifactManifestByBranchName,
  type PlanArtifactManifest,
} from '../shared/utils/plan-artifact';
import { resolveArtifactDir, resolveCustomArtifactDir } from '../agents/utils';
import type { StageProgressCallback } from '../shared/types/agent.types';

export interface FigmaStageOptions {
  repoDir: string;
  force?: boolean;
  /** Config key to consult when `force` is absent. Defaults to `'stages.review.figma'`. */
  configKey?: string;
  ticketKey?: string;
  trackerName?: string;
  artifactDir?: string;
  overrideLinks?: string[];
  onProgress?: StageProgressCallback;
}

export interface FigmaResolveResult {
  figmaLinks: string[];
  baseBranch?: string;
  frames: FigmaFrameContext[];
}

@Injectable()
export class FigmaStageService {
  constructor(
    private readonly configService: ConfigService,
    private readonly gitService: GitService,
    private readonly logger: LoggerService,
    private readonly figmaRestClient: FigmaRestClient,
  ) {}

  async resolveIfEnabled(options: FigmaStageOptions): Promise<FigmaResolveResult | undefined> {
    const key = options.configKey ?? 'stages.review.figma';
    const configEnabled = this.configService.get<boolean>(key) === true;
    if (!options.force && !configEnabled) return undefined;
    if (options.overrideLinks?.length) {
      const frames = await this.figmaRestClient.fetchFrames(options.overrideLinks);
      return { figmaLinks: options.overrideLinks, frames };
    }
    return this.resolveFromManifest(options);
  }

  private async resolveFromManifest(options: FigmaStageOptions): Promise<FigmaResolveResult | undefined> {
    const branchInfo = await this.gitService.getBranchInfo(options.repoDir);
    const manifest = this.findManifestByBranchName(options.repoDir, branchInfo.current, options);
    if (!manifest?.figmaLinks?.length) {
      const msg = '--figma enabled but no Figma links were captured during planning — skipping design-conformance check.';
      options.onProgress?.(msg);
      this.logger.warn(msg, 'figma-stage');
      return undefined;
    }
    const frames = await this.figmaRestClient.fetchFrames(manifest.figmaLinks);
    return { figmaLinks: manifest.figmaLinks, baseBranch: manifest.sourceBranch, frames };
  }

  private findManifestByBranchName(
    repoDir: string, branchName: string, options: FigmaStageOptions
  ): PlanArtifactManifest | undefined {
    const artifactDirs = [resolveCustomArtifactDir(repoDir)];
    if (options.artifactDir) artifactDirs.push(options.artifactDir);
    else if (options.trackerName) artifactDirs.push(resolveArtifactDir(repoDir, options.trackerName));
    return findPlanArtifactManifestByBranchName(branchName, artifactDirs);
  }
}
