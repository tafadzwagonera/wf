import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitService } from '../integrations/git/git.service';
import { SessionService } from '../shared/session/session.service';
import { LoggerService } from '../shared/logger/logger.service';
import { runSonarScan, type SonarScanResult } from './sonar-scanner';
import { resolveArtifactDir, resolveCustomArtifactDir } from '../agents/utils';
import {
  findPlanArtifactManifestByBranchName,
  updatePlanArtifactManifestSourceBranch,
  type PlanArtifactManifest,
} from '../shared/utils/plan-artifact';
import { promptForSourceBranch } from '../shared/utils/source-branch-prompt';
import type { StageProgressCallback } from '../shared/types/agent.types';
import type { BranchInfo } from '../shared/types/git.types';
import type { SessionState } from '../shared/types/session.types';

/**
 * Options controlling a SonarQube pre-review scan.
 * All scope-selection and fallback logic is encapsulated here.
 */
export interface SonarStageOptions {
  repoDir: string;
  force?: boolean;
  ticketKey?: string;
  providerSessionId?: string;
  trackerName?: string;
  allowPrompt?: boolean;
  onProgress?: StageProgressCallback;
}

/**
 * Orchestrates the SonarQube pre-review scan gate, scope selection, and
 * source-branch fallback. Consumed by both IssueReviewCommand (standalone)
 * and ReviewerAgent (orchestrator pipeline).
 */
@Injectable()
export class SonarStageService {
  constructor(
    private readonly configService: ConfigService,
    private readonly gitService: GitService,
    private readonly sessionService: SessionService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Runs the SonarQube scan when enabled by `force` or config; returns
   * `undefined` when disabled. Throws ConfigurationError/ExecutionError on
   * scan failure — callers are responsible for containment.
   */
  async scanIfEnabled(options: SonarStageOptions): Promise<SonarScanResult | undefined> {
    const configEnabled = this.configService.get<boolean>('stages.review.sonar') === true;
    if (!options.force && !configEnabled) return undefined;
    const { staged } = await this.gitService.getStatus(options.repoDir);
    if (staged.length) {
      return runSonarScan({
        repoDir: options.repoDir,
        scope: { kind: 'staged' },
        secretPaths: staged,
        onProgress: options.onProgress,
      });
    }
    return this.runSonarAgainstMergeBase(options);
  }

  private async runSonarAgainstMergeBase(options: SonarStageOptions): Promise<SonarScanResult> {
    if (options.ticketKey && !options.providerSessionId) {
      return this.runSonarForTicketKeyOnly(options.ticketKey, options);
    }
    const branchInfo = await this.gitService.getBranchInfo(options.repoDir);
    const baseRef = await this.resolveMergeBaseRef(options.repoDir, branchInfo, options);
    const mergeBase = baseRef
      ? await this.gitService.getMergeBase(baseRef, branchInfo.current, options.repoDir)
      : null;
    if (!mergeBase) return this.logAndRunBareAnalyze(options);
    return this.runSonarWithMergeBase(mergeBase, options);
  }

  private logAndRunBareAnalyze(options: SonarStageOptions): Promise<SonarScanResult> {
    const message = 'SonarQube CLI: no base branch to diff against — running a bare analyze instead';
    options.onProgress?.(message);
    this.logger.warn(message, 'sonar-stage');
    return this.runBareAnalyze(options.repoDir, options.onProgress);
  }

  private async runSonarWithMergeBase(
    mergeBase: string, options: SonarStageOptions
  ): Promise<SonarScanResult> {
    const changedFiles = await this.gitService.getChangedFilesSince(mergeBase, options.repoDir);
    return runSonarScan({
      repoDir: options.repoDir,
      scope: { kind: 'base', ref: mergeBase },
      secretPaths: changedFiles,
      onProgress: options.onProgress,
    });
  }

  private async resolveMergeBaseRef(
    repoDir: string, branchInfo: BranchInfo, options: SonarStageOptions
  ): Promise<string | null> {
    const recordedSourceBranch = await this.resolveRecordedSourceBranch(repoDir, branchInfo, options);
    if (recordedSourceBranch) return recordedSourceBranch;
    if (branchInfo.development && branchInfo.development !== branchInfo.current) return branchInfo.development;
    return this.gitService.getUpstreamRef(branchInfo.current, repoDir);
  }

  private async resolveRecordedSourceBranch(
    repoDir: string, branchInfo: BranchInfo, options: SonarStageOptions
  ): Promise<string | undefined> {
    try {
      if (options.providerSessionId) {
        const originSession = await this.sessionService.findByProviderSessionId(options.providerSessionId, 'plan');
        if (originSession?.sourceBranch) return originSession.sourceBranch;
      }
      return await this.resolveSourceBranchFromManifestChain(repoDir, branchInfo, options);
    } catch {
      return undefined;
    }
  }

  private async resolveSourceBranchFromManifestChain(
    repoDir: string, branchInfo: BranchInfo, options: SonarStageOptions
  ): Promise<string | undefined> {
    const manifest = this.findManifestByBranchName(repoDir, branchInfo.current, options);
    const manifestSession = await this.findSessionForManifest(manifest);
    if (manifestSession?.sourceBranch) return manifestSession.sourceBranch;
    if (manifest?.sourceBranch) return manifest.sourceBranch;

    const reflogSource = await this.gitService.getBranchCreationSource(branchInfo.current, repoDir);
    if (reflogSource) {
      this.persistSourceBranch(manifest, reflogSource, branchInfo.current);
      return reflogSource;
    }

    return await this.promptForMissingSourceBranch(branchInfo, manifest, options);
  }

  private async findSessionForManifest(
    manifest: PlanArtifactManifest | undefined
  ): Promise<SessionState | null> {
    const identifier = manifest?.ticketKey ?? manifest?.customArtifactName ?? manifest?.sourceName;
    if (!identifier) return null;
    return this.sessionService.findByTicketKey(identifier);
  }

  private findManifestByBranchName(
    repoDir: string, branchName: string, options: SonarStageOptions
  ): PlanArtifactManifest | undefined {
    const artifactDirs = [resolveCustomArtifactDir(repoDir)];
    if (options.trackerName) artifactDirs.push(resolveArtifactDir(repoDir, options.trackerName));
    return findPlanArtifactManifestByBranchName(branchName, artifactDirs);
  }

  private persistSourceBranch(
    manifest: PlanArtifactManifest | undefined, sourceBranch: string, branchName: string
  ): void {
    if (manifest) updatePlanArtifactManifestSourceBranch(manifest.artifactPath, sourceBranch, branchName);
  }

  private async promptForMissingSourceBranch(
    branchInfo: BranchInfo, manifest: PlanArtifactManifest | undefined, options: SonarStageOptions
  ): Promise<string | undefined> {
    if (!options.allowPrompt || !this.isInteractiveSession()) return undefined;
    const devBranches = this.gitService.detectDevelopmentBranches(branchInfo.all);
    const mainBranch = this.gitService.detectMainBranch(branchInfo.all);
    const selected = devBranches.length > 1
      ? await promptForSourceBranch(devBranches, mainBranch)
      : devBranches[0] ?? mainBranch;
    if (!selected) return undefined;
    this.persistSourceBranch(manifest, selected, branchInfo.current);
    return selected;
  }

  private async runSonarForTicketKeyOnly(
    ticketKey: string, options: SonarStageOptions
  ): Promise<SonarScanResult> {
    const session = await this.sessionService.findByTicketKey(ticketKey);
    if (!session?.sourceBranch) {
      return this.logAndRunBareAnalyze(options);
    }
    const branchInfo = await this.gitService.getBranchInfo(options.repoDir);
    const mergeBase = await this.gitService.getMergeBase(session.sourceBranch, branchInfo.current, options.repoDir);
    if (!mergeBase) {
      return this.logAndRunBareAnalyze(options);
    }
    return this.runSonarWithMergeBase(mergeBase, options);
  }

  private async runBareAnalyze(
    repoDir: string, onProgress?: (line: string) => void
  ): Promise<SonarScanResult> {
    return runSonarScan({ repoDir, scope: { kind: 'branch' }, secretPaths: [], onProgress });
  }

  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }
}
