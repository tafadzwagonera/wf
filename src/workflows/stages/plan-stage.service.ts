import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { AiService, ResolutionPlan } from '../../integrations/ai/ai.service';
import { StageAgentService } from '../../integrations/ai/stage-agent.service';
import { resolveSkills, collectQualityRules } from '../../skills';
import type { SkillQualityRule } from '../../skills/skill.types';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  parsePlanArtifact,
  hashPlanArtifactSources,
  resolvePlanArtifactReference,
  writePlanArtifactManifest,
} from '../../shared/utils/plan-artifact';
import { PlanArtifact, PlannerOptions, ResolutionAction, TicketArtifact } from '../../agents/interfaces';
import { AIError, isAIErrorLike, ValidationError } from '../../shared/utils/errors';
import { detectTestInfra, type TestInfraContext } from '../../shared/utils/detect-test-infra';
import { validatePlanQuality } from '../../shared/utils/plan-quality';
import type { RepoConventionsContext,
  PriorPlanContext,
  PlanCorrelationResult,
  CrossRepoContext
} from '../../shared/types/detection.types';

interface GeneratePlanOptions {
  action: ResolutionAction;
  ticketKey?: string;
  affectedRepositories?: string[];
  repoDir?: string;
  conventions?: RepoConventionsContext;
  priorPlans?: PriorPlanContext;
  planCorrelation?: PlanCorrelationResult;
  crossRepoPatterns?: CrossRepoContext;
  onProgress?: (line: string) => void;
  priorStageSummary?: string;
  resumeProviderSessionId?: string;
  testInfra?: TestInfraContext;
}

@Injectable()
export class PlanStageService {
  constructor(
    private readonly aiService: AiService,
    private readonly stageAgentService: StageAgentService,
    private readonly configService: ConfigService
  ) {}

  // eslint-disable-next-line max-lines-per-function
  async generatePlan(
    ticketContent: string,
    options: GeneratePlanOptions
  ): Promise<{ plan: ResolutionPlan; sessionId?: string }> {
    const testInfra = detectTestInfra(options.repoDir ?? process.cwd());
    const skillIds = this.configService.get<string[]>('stages.plan.skills') ?? [];
    const skills = skillIds.length
      ? await resolveSkills(skillIds, { interactive: this.isInteractiveSession(), stage: 'plan' })
      : [];
    const skillRules = collectQualityRules(skills);

    const standardContext = {
      ticketKey: options.ticketKey,
      summary: this.extractSummary(ticketContent),
      affectedRepositories: options.affectedRepositories,
      testInfra,
      conventions: options.conventions,
      priorPlans: options.priorPlans,
      planCorrelation: options.planCorrelation,
      crossRepoPatterns: options.crossRepoPatterns,
      skillNames: skillIds.length ? skillIds : undefined,
    };

    // eslint-disable-next-line max-lines-per-function
    const generatePlanAttempt = async (
      planQualityFeedback?: string[]
    ): Promise<{ plan: ResolutionPlan; sessionId?: string }> => {
      if (this.stageAgentService.isEnabledForStage('plan')) {
        try {
          return await this.stageAgentService.generatePlan({
            action: options.action,
            issueContent: ticketContent,
            ticketKey: options.ticketKey,
            affectedRepositories: options.affectedRepositories,
            planQualityFeedback,
            testInfra,
            conventions: options.conventions,
            priorPlans: options.priorPlans,
            planCorrelation: options.planCorrelation,
            crossRepoPatterns: options.crossRepoPatterns,
            skillNames: skillIds.length ? skillIds : undefined,
            onProgress: options.onProgress,
            priorStageSummary: options.priorStageSummary,
            resumeProviderSessionId: options.resumeProviderSessionId,
          });
        } catch (error) {
          const isFallbackEligible
            = isAIErrorLike(error)
              && (error.message.includes('Failed to parse resolution plan')
                || error.message.includes('CLI finished without returning a result'));

          if (!isFallbackEligible) {
            throw error;
          }

          const agentProse
            = typeof error.details?.response === 'string' && error.details.response.trim()
              ? error.details.response
              : undefined;

          const sessionId = typeof error.details?.sessionId === 'string' ? error.details.sessionId : undefined;

          const repairedPlan = await this.recoverPlanFromParseError(error, sessionId);
          if (repairedPlan) {
            return repairedPlan;
          }

          const fallbackReason = agentProse ? 'prose' : 'no result';
          console.log(chalk.yellow(`  \u26A0\uFE0F Agent returned ${fallbackReason} \u2014 falling back to structured completion`));
          const fallbackResult = await this.aiService.generatePlan(options.action, ticketContent, {
            ...standardContext,
            planQualityFeedback,
            ...(agentProse ? { agentAnalysis: agentProse } : {}),
          });

          if (!fallbackResult?.action || !fallbackResult?.summary || !Array.isArray(fallbackResult?.steps)) {
            throw new AIError(
              'Fallback completion did not produce a valid resolution plan. Both agent and standard completion failed to return JSON.',
              { agentResponse: agentProse?.slice(0, 500), fallbackResult },
              true,
              'parse'
            );
          }

          console.log(chalk.green('  ✔ Fallback produced valid plan'));
          return { plan: fallbackResult, sessionId };
        }
      }

      const plan = await this.aiService.generatePlan(
        options.action,
        ticketContent,
        {
          ...standardContext,
          planQualityFeedback,
        }
      );
      return { plan };
    };

    const validatePlan = (plan: ResolutionPlan): string[] => {
      const violations = validatePlanQuality({
        plan,
        affectedRepositories: options.affectedRepositories,
        testInfra,
        skillRules,
      });
      return violations.map(violation => `[${violation.ruleId}] ${violation.message}`);
    };

    const firstAttempt = await generatePlanAttempt();
    const firstAttemptViolations = validatePlan(firstAttempt.plan);

    if (firstAttemptViolations.length === 0) {
      return firstAttempt;
    }

    const retryAttempt = await generatePlanAttempt(firstAttemptViolations);
    const retryViolations = validatePlan(retryAttempt.plan);

    if (retryViolations.length > 0) {
      console.log(
        chalk.yellow(
          `  ⚠ Plan quality violations persisted after retry:\n${retryViolations.map(v => `      ${v}`).join('\n')}`
        )
      );
      const existingRisks = retryAttempt.plan.risks ?? [];
      return {
        ...retryAttempt,
        plan: {
          ...retryAttempt.plan,
          risks: [...existingRisks, ...retryViolations.map(v => `[plan-quality] ${v}`)],
        },
      };
    }

    return retryAttempt;
  }

  private async recoverPlanFromParseError(
    error: unknown,
    sessionId?: string
  ): Promise<{ plan: ResolutionPlan; sessionId?: string } | undefined> {
    if (!isAIErrorLike(error) || error.category !== 'parse' || typeof error.details?.response !== 'string') {
      return undefined;
    }

    return this.aiService
      .validatePlanJson(error.details.response)
      .then(plan => ({ plan, sessionId }))
      .catch(repairError => {
        if (!isAIErrorLike(repairError) || repairError.category !== 'parse') throw repairError;
        return undefined;
      });
  }

  private async returnValidatedCachedPlan(
    plan: ResolutionPlan, artifactPath: string, repoDir?: string
  ): Promise<PlanArtifact> {
    await this.validateLoadedPlan(plan, repoDir);
    return { plan, action: plan.action, path: artifactPath, fromCache: true };
  }

  private async resolveCachedPlan(
    ticket: TicketArtifact, options: PlannerOptions, artifactDir: string
  ): Promise<PlanArtifact | null> {
    const existing = resolvePlanArtifactReference(ticket.ticketKey, { artifactDir, action: options.action });
    const plan = this.readPlan(existing.artifactPath);
    if (plan.action !== options.action) {
      const picked = await this.resolveActionMismatch(
        plan.action, options.action, path.basename(existing.artifactPath)
      );
      if (picked !== plan.action) return null;
    }
    return this.returnValidatedCachedPlan(plan, existing.artifactPath, options.repoDir);
  }

  private async tryReuseCachedPlan(
    ticket: TicketArtifact, options: PlannerOptions, artifactDir: string
  ): Promise<PlanArtifact | null> {
    if (!options.skipExisting) return null;
    try {
      return await this.resolveCachedPlan(ticket, options, artifactDir);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      return null;
    }
  }

  private persistPlanArtifact(
    plan: ResolutionPlan, action: ResolutionAction, artifactDir: string,
    planHash: string, sourceName: string, sourceKind: 'ticket' | 'custom' | undefined
  ): PlanArtifact {
    const createdAt = new Date();
    const filename = buildPlanArtifactFilename({ createdAt, hash: planHash, action, format: 'json' });
    const planPath = path.join(artifactDir, filename);
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    const manifest = buildPlanArtifactManifest(planPath, action, 'json', planHash, sourceName, sourceKind ?? 'ticket', createdAt);
    writePlanArtifactManifest(manifest);
    this.deleteStalePlanArtifacts(artifactDir, planHash, action, planPath);
    return { plan, action, path: planPath, fromCache: false };
  }

  async createPlanArtifact(ticket: TicketArtifact, options: PlannerOptions): Promise<PlanArtifact> {
    const artifactDir = path.dirname(ticket.path);
    const sourceName = ticket.ticketKey;
    const planHash = hashPlanArtifactSources([sourceName]);
    const cached = await this.tryReuseCachedPlan(ticket, options, artifactDir);
    if (cached) return cached;
    const { plan, sessionId } = await this.generatePlan(ticket.content, {
      action: options.action, ticketKey: ticket.ticketKey,
      affectedRepositories: options.affectedRepositories, onProgress: options.onProgress,
    });
    const result = this.persistPlanArtifact(
      plan, options.action, artifactDir, planHash, sourceName, options.sourceKind
    );
    return { ...result, sessionId };
  }

  // eslint-disable-next-line max-lines-per-function
  async loadPlanArtifact(ticketPath: string, action?: ResolutionAction, repoDir?: string): Promise<PlanArtifact> {
    const artifactDir = path.dirname(ticketPath);
    const sourceName = path.basename(ticketPath, '.md');
    const resolved = resolvePlanArtifactReference(sourceName, {
      artifactDir,
      action,
    });

    const plan = this.readPlan(resolved.artifactPath);
    const filename = path.basename(resolved.artifactPath);

    if (!action || plan.action === action) {
      await this.validateLoadedPlan(plan, repoDir);
      return { plan, action: plan.action, path: resolved.artifactPath, fromCache: true };
    }

    const resolvedAction = await this.resolveActionMismatch(plan.action, action, filename);

    if (resolvedAction === plan.action) {
      await this.validateLoadedPlan(plan, repoDir);
      return { plan, action: plan.action, path: resolved.artifactPath, fromCache: true };
    }

    throw new ValidationError(
      `Plan action '${plan.action}' in '${filename}' does not match requested '${action}'. `
      + `Re-run with --from plan to regenerate.`
    );
  }

  extractSummary(content: string): string {
    const match = /^#\s+[A-Z]+-\d+:\s+(.+)$/m.exec(content);
    return match ? match[1] : 'Implementation';
  }

  private readPlan(planPath: string): ResolutionPlan {
    try {
      return parsePlanArtifact(fs.readFileSync(planPath, 'utf-8'), planPath);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : `Plan file is not valid: ${path.basename(planPath)}`);
    }
  }

  /**
   * Validate a plan loaded from disk against quality rules.
   * Violations are downgraded to plan.risks[] with a warning log.
   *
   * @throws ValidationError when the resolved directory does not exist on disk
   */
  private async resolveSkillRulesForPlan(): Promise<SkillQualityRule[]> {
    const skillIds = this.configService.get<string[]>('stages.plan.skills') ?? [];
    if (!skillIds.length) return [];
    const skills = await resolveSkills(skillIds, { interactive: this.isInteractiveSession(), stage: 'plan' });
    return collectQualityRules(skills);
  }

  private resolveRepoDirOrThrow(repoDir: string | undefined): string {
    const resolved = repoDir ?? process.cwd();
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new ValidationError(
        `Plan validation failed: '${resolved}' is not a valid directory. `
        + `Pass --repos with a local repository path.`
      );
    }
    return resolved;
  }

  private async validateLoadedPlan(plan: ResolutionPlan, repoDir?: string): Promise<void> {
    const testInfra = detectTestInfra(this.resolveRepoDirOrThrow(repoDir));
    const skillRules = await this.resolveSkillRulesForPlan();
    const violations = validatePlanQuality({
      plan, affectedRepositories: plan.affectedRepositories, testInfra, skillRules,
    });
    if (violations.length === 0) return;
    const formatted = violations.map(v => `[${v.ruleId}] ${v.message}`);
    const bullets = formatted.map(v => '      ' + v).join('\n');
    console.log(chalk.yellow('  ⚠ Plan quality violations (loaded plan):\n' + bullets));
    plan.risks = [...(plan.risks ?? []), ...formatted.map(v => `[plan-quality] ${v}`)];
  }

  /**
   * Warn about a cached plan action mismatch and let the user pick the correct action.
   *
   * @param planAction - The action stored inside the cached plan file
   * @param requestedAction - The action requested by the caller
   * @returns The action the user selected
   * @throws ValidationError when the session is non-interactive
   */
  private async promptActionChoice(
    planAction: ResolutionAction, requestedAction: ResolutionAction
  ): Promise<ResolutionAction> {
    const { selectedAction } = await inquirer.prompt<{ selectedAction: ResolutionAction }>([{
      type: 'list', name: 'selectedAction',
      message: 'Which action should be used?', prefix: ' ',
      choices: [
        { name: `Use '${planAction}' (from cached plan)`, value: planAction },
        { name: `Use '${requestedAction}' (requested — may require re-running from plan stage)`, value: requestedAction },
      ],
      default: planAction,
    }]);
    return selectedAction;
  }

  private async resolveActionMismatch(
    planAction: ResolutionAction, requestedAction: ResolutionAction, filename: string
  ): Promise<ResolutionAction> {
    console.log(chalk.yellow(`  ⚠  Cached plan action mismatch for ${filename}: plan contains '${planAction}', requested '${requestedAction}'.`));
    if (!this.isInteractiveSession()) {
      throw new ValidationError(
        `Cached plan action mismatch: '${filename}' contains '${planAction}' but '${requestedAction}' was requested. `
        + `Re-run with --from plan to regenerate, or re-run interactively to choose.`
      );
    }
    return this.promptActionChoice(planAction, requestedAction);
  }

  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  private removeArtifactAndManifest(filePath: string): void {
    fs.unlinkSync(filePath);
    const manifestPath = filePath.replace(/\.[^.]+$/, '.sources.json');
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
  }

  private deleteStalePlanArtifacts(
    artifactDir: string, sourceHash: string, action: ResolutionAction, retainedPlanPath: string
  ): void {
    if (!fs.existsSync(artifactDir)) return;
    const stalePattern = new RegExp(`^(?:\\d{4}-\\d{2}-\\d{2}-)?${sourceHash}-${action}-plan\\.json$`, 'i');
    for (const name of fs.readdirSync(artifactDir).filter(n => n.endsWith('.json'))) {
      if (!stalePattern.test(name)) continue;
      const siblingPath = path.join(artifactDir, name);
      if (siblingPath !== retainedPlanPath && fs.existsSync(siblingPath)) this.removeArtifactAndManifest(siblingPath);
    }
  }
}
