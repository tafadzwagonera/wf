import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  ticketKey?: string;
  trackerName?: string;
  artifactDir?: string;
  onProgress?: StageProgressCallback;
}

export interface FigmaResolveResult {
  figmaLinks: string[];
  baseBranch?: string;
}

@Injectable()
export class FigmaStageService {
  constructor(
    private readonly configService: ConfigService,
    private readonly gitService: GitService,
    private readonly logger: LoggerService,
  ) {}

  async resolveIfEnabled(options: FigmaStageOptions): Promise<FigmaResolveResult | undefined> {
    const configEnabled = this.configService.get<boolean>('stages.review.figma') === true;
    if (!options.force && !configEnabled) return undefined;

    const branchInfo = await this.gitService.getBranchInfo(options.repoDir);
    const manifest = this.findManifestByBranchName(options.repoDir, branchInfo.current, options);

    if (!manifest?.figmaLinks?.length) {
      const msg = '--figma enabled but no Figma links were captured during planning — skipping design-conformance check.';
      options.onProgress?.(msg);
      this.logger.warn(msg, 'figma-stage');
      return undefined;
    }

    return { figmaLinks: manifest.figmaLinks, baseBranch: manifest.sourceBranch };
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
