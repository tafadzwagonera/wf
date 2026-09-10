import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FigmaFrameContext, FigmaRestClient } from '../integrations/figma/figma-rest.client';
import { GitService } from '../integrations/git/git.service';
import { LoggerService } from '../shared/logger/logger.service';
import {
  findPlanArtifactManifestByBranchName,
  buildPlanArtifactManifestPath,
  readPlanArtifactManifest,
  readFigmaLinksFromPlanArtifact,
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
  artifactPath?: string;
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
    if (!options.force && !options.artifactPath && !configEnabled) return undefined;
    if (options.overrideLinks?.length) {
      const frames = await this.figmaRestClient.fetchFrames(options.overrideLinks);
      this.warnIfFramesDegenerate(frames, options.overrideLinks, options);
      return { figmaLinks: options.overrideLinks, frames };
    }
    return this.resolveFromManifest(options);
  }

  private async resolveFromManifest(options: FigmaStageOptions): Promise<FigmaResolveResult | undefined> {
    const { artifactPath, repoDir } = options;
    let figmaLinks: string[] | undefined;
    let sourceBranch: string | undefined;
    if (artifactPath) {
      figmaLinks = readFigmaLinksFromPlanArtifact(artifactPath);
      sourceBranch = readPlanArtifactManifest(buildPlanArtifactManifestPath(artifactPath))?.sourceBranch;
    } else {
      const manifest = this.findManifestByBranchName(
        repoDir, (await this.gitService.getBranchInfo(repoDir)).current, options,
      );
      figmaLinks = manifest?.figmaLinks;
      sourceBranch = manifest?.sourceBranch;
    }
    if (!figmaLinks?.length) {
      const msg = '--figma enabled but no Figma links were captured during planning — skipping design-conformance check.';
      options.onProgress?.(msg);
      this.logger.warn(msg, 'figma-stage');
      return undefined;
    }
    const frames = await this.figmaRestClient.fetchFrames(figmaLinks);
    this.warnIfFramesDegenerate(frames, figmaLinks, options);
    return { figmaLinks, baseBranch: sourceBranch, frames };
  }

  private warnIfFramesDegenerate(
    frames: FigmaFrameContext[],
    figmaLinks: string[],
    options: FigmaStageOptions,
  ): void {
    if (frames.length > 0 || figmaLinks.length === 0) return;
    const msg = '--figma enabled but all Figma frame fetches failed — check figma.token validity and node IDs.';
    options.onProgress?.(msg);
    this.logger.warn(msg, 'figma-stage');
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
