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
} from '../../common/utils/plan-artifact';
import { estimatePlanComplexity } from '../../common/utils/estimate-plan-complexity';
import type { PlanRisk } from '../../common/types/ai.types';
import { extractFigmaLinks, resolvePostParseFigmaLinks } from '../../common/utils/extract-figma-links';
import { PlanArtifact, PlannerOptions, ResolutionAction, TicketArtifact } from '../../agents/interfaces';
import { AiProviderError, AppError, isAiProviderErrorLike, PlanArtifactNotFoundError, ValidationError, WorkflowParseError } from '../../common/utils/errors';
import { appendToLogFile } from '../../common/logger/log-file-writer';
import { detectTestInfra, type TestInfraContext } from '../../common/utils/detect-test-infra';
import { detectPackageManager, detectRepoConventions } from '../../common/utils/detect-repo-conventions';
import { formatPlanQualityViolations, validatePlanQualityWithLookups } from '../../common/utils/plan-quality';
import { DUPLICATE_RESOLVER_RULE_ID } from '../../common/utils/plan-quality-duplicate-resolver';
import type { RepoConventionsContext,
  PriorPlanContext,
  PlanCorrelationResult,
  CrossRepoContext
} from '../../common/types/detection.types';
import type { ReuseCandidateContext } from '../../common/utils/detect-reuse-candidates';
import { executeAsyncWithCatch } from '../../common/utils/execute-with-catch';

type PlanResult = { plan: ResolutionPlan; sessionId?: string; modelUsed?: string };

interface PlanGenerationContext {
  ticketContent: string;
  options: GeneratePlanOptions;
  testInfra: TestInfraContext;
  skillIds: string[];
  skillRules: SkillQualityRule[];
}

interface GeneratePlanOptions {
  action: ResolutionAction;
  ticketKey?: string;
  affectedRepositories?: string[];
  repoDir?: string;
  conventions?: RepoConventionsContext;
  priorPlans?: PriorPlanContext;
  planCorrelation?: PlanCorrelationResult;
  crossRepoPatterns?: CrossRepoContext;
  figmaLinks?: string[];
  uiDesignScreenshots?: string[];
  reuseCandidates?: ReuseCandidateContext;
  onProgress?: (line: string) => void;
  priorStageSummary?: string;
  resumeProviderSessionId?: string;
  testInfra?: TestInfraContext;
}

interface PlanQualityViolations {
  blocking: string[];
  advisory: string[];
}

const formatViolations = (violations: { ruleId: string; message: string }[]): string[] =>
  violations.map(v => `[${v.ruleId}] ${v.message}`);

const splitViolations = (violations: { ruleId: string; message: string }[]): PlanQualityViolations => ({
  blocking: formatViolations(violations.filter(v => v.ruleId !== DUPLICATE_RESOLVER_RULE_ID)),
  advisory: formatViolations(violations.filter(v => v.ruleId === DUPLICATE_RESOLVER_RULE_ID)),
});

const toQualityRisk = (violation: string): PlanRisk => ({
  description: `[plan-quality] ${violation}`,
  severity: 'medium',
});

@Injectable()
export class PlanStageService {
  constructor(
    private readonly aiService: AiService,
    private readonly stageAgentService: StageAgentService,
    private readonly configService: ConfigService
  ) {}

  async generatePlan(
    ticketContent: string,
    options: GeneratePlanOptions
  ): Promise<PlanResult> {
    const ctx = await this.buildPlanContext(ticketContent, options);
    const firstAttempt = await this.generatePlanAttempt(ctx);
    const first = await this.validatePlanViolations(firstAttempt.plan, ctx);
    if (first.blocking.length === 0) return this.withAdvisoryRisks(firstAttempt, first.advisory);
    console.log(formatPlanQualityViolations(first.blocking, 'Plan quality violations (retrying with feedback)'));
    const retryAttempt = await this.generatePlanAttempt(ctx, first.blocking);
    const retry = await this.validatePlanViolations(retryAttempt.plan, ctx);
    return this.withAdvisoryRisks(retryAttempt, [...retry.blocking, ...retry.advisory]);
  }

  /**
   * Records the agent failure that triggered the fallback. The caught error is otherwise
   * discarded here, so when the fallback itself fails the original cause is unrecoverable.
   *
   * @param error - The agent error being swallowed by the fallback
   * @param context - Why the fallback fired and the provider session it came from
   */
  private logFallbackDecision(
    error: unknown,
    context: { fallbackReason: string; sessionId?: string }
  ): void {
    const category = isAiProviderErrorLike(error) ? error.category ?? 'none' : 'none';
    const message = error instanceof Error ? error.message : String(error);
    const fields = [
      `reason=${context.fallbackReason}`,
      `category=${category}`,
      `session=${context.sessionId ?? 'none'}`,
      'billing=api-key',
    ].join(' ');
    appendToLogFile('WARN', `plan.fallback ${fields} cause=${message.replaceAll('\n', ' | ')}`, 'plan-stage');
  }

  private async recoverPlanFromParseError(
    error: unknown,
    sessionId?: string
  ): Promise<{ plan: ResolutionPlan; sessionId?: string } | undefined> {
    if (!isAiProviderErrorLike(error) || error.category !== 'parse' || typeof error.details?.response !== 'string') return undefined;
    return this.aiService.validatePlanJson(error.details.response)
      .then(plan => ({ plan, sessionId }))
      .catch(repairError => {
        const msg = repairError instanceof Error ? repairError.message : String(repairError);
        appendToLogFile('WARN', `plan.repair failed cause=${msg.replaceAll('\n', ' | ')}`, 'plan-stage');
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
    const [cached] = await executeAsyncWithCatch({
      fn: () => this.resolveCachedPlan(ticket, options, artifactDir),
      rethrowIf: error => !(error instanceof PlanArtifactNotFoundError),
      onError: () => null,
    });
    return cached ?? null;
  }

  private writePlanFile(
    plan: ResolutionPlan, planPath: string,
    figmaLinks: string[], uiDesignScreenshots: string[],
  ): void {
    const planToWrite = {
      ...plan,
      ...(figmaLinks.length ? { figmaLinks } : {}),
      ...(uiDesignScreenshots.length ? { uiDesignScreenshots } : {}),
    };
    fs.writeFileSync(planPath, JSON.stringify(planToWrite, null, 2));
  }

  private writeManifest(
    planPath: string, action: ResolutionAction, planHash: string,
    sourceName: string, sourceKind: 'ticket' | 'custom' | undefined,
    createdAt: Date, figmaLinks: string[],
  ): void {
    writePlanArtifactManifest(buildPlanArtifactManifest({
      artifactPath: planPath, action, format: 'json', hash: planHash,
      sourceName, sourceKind: sourceKind ?? 'ticket', createdAt,
      figmaLinks: figmaLinks.length ? figmaLinks : undefined,
    }));
  }

  private persistPlanArtifact(
    plan: ResolutionPlan, action: ResolutionAction, artifactDir: string,
    planHash: string, sourceName: string, sourceKind: 'ticket' | 'custom' | undefined,
    links: { figmaLinks: string[]; uiDesignScreenshots: string[] }
  ): PlanArtifact {
    const { figmaLinks, uiDesignScreenshots } = links;
    const createdAt = new Date();
    const planPath = path.join(artifactDir, buildPlanArtifactFilename({ createdAt, hash: planHash, action, format: 'json' }));
    this.writePlanFile(plan, planPath, figmaLinks, uiDesignScreenshots);
    this.writeManifest(planPath, action, planHash, sourceName, sourceKind, createdAt, figmaLinks);
    this.deleteStalePlanArtifacts(artifactDir, planHash, action, planPath);
    return { plan, action, path: planPath, fromCache: false };
  }

  private warnNoFigmaLinks(reason: 'no-links-found' | 'non-interactive-session'): void {
    appendToLogFile('WARN', `No Figma frame links found in ticket (${reason}) — Figma REST API design context injection will be skipped.`, 'figma-stage');
  }

  async createPlanArtifact(ticket: TicketArtifact, options: PlannerOptions): Promise<PlanArtifact> {
    const cached = await this.tryReuseCachedPlan(ticket, options, path.dirname(ticket.path));
    if (cached) return cached;
    const { plan, sessionId, modelUsed, figmaLinks } = await this.executePlanGeneration(ticket, options);
    if (this.isFigmaEnabled(options) && !figmaLinks.length) this.warnNoFigmaLinks(this.isInteractiveSession() ? 'no-links-found' : 'non-interactive-session');
    this.enrichPlanWithDirectoryConfigs(plan, options.repoDir ?? process.cwd());
    const result = this.persistPlanArtifact(
      plan, options.action, path.dirname(ticket.path),
      hashPlanArtifactSources([ticket.ticketKey]), ticket.ticketKey, options.sourceKind,
      { figmaLinks, uiDesignScreenshots: options.uiDesignScreenshots ?? [] },
    );
    return { ...result, sessionId, modelUsed };
  }

  private isFigmaEnabled(options: PlannerOptions): boolean {
    return options.figma === true || this.configService.get<boolean>('stages.plan.figma') === true;
  }

  private buildPlanGenerationOptions(ticket: TicketArtifact, options: PlannerOptions, figmaLinks: string[]) {
    return {
      action: options.action, ticketKey: ticket.ticketKey,
      affectedRepositories: options.affectedRepositories, onProgress: options.onProgress,
      figmaLinks, uiDesignScreenshots: options.uiDesignScreenshots, repoDir: options.repoDir,
    };
  }

  private async executePlanGeneration(ticket: TicketArtifact, options: PlannerOptions) {
    const figmaEnabled = this.isFigmaEnabled(options);
    const autoLinks = figmaEnabled ? extractFigmaLinks(ticket.content) : [];
    const { plan, sessionId, modelUsed } = await this.generatePlan(
      ticket.content, this.buildPlanGenerationOptions(ticket, options, autoLinks)
    );
    const figmaLinks = figmaEnabled
      ? await resolvePostParseFigmaLinks(
          ticket.content, autoLinks, { allowPrompt: this.isInteractiveSession(), repoDir: options.repoDir }
        )
      : [];
    return { plan, sessionId, modelUsed, figmaLinks };
  }

  async loadPlanArtifact(ticketPath: string, action?: ResolutionAction, repoDir?: string): Promise<PlanArtifact> {
    const artifactDir = path.dirname(ticketPath);
    const sourceName = path.basename(ticketPath, '.md');
    const resolved = resolvePlanArtifactReference(sourceName, { artifactDir, action });
    const plan = this.readPlan(resolved.artifactPath);
    return this.resolveLoadedPlanAction(plan, resolved.artifactPath, action, repoDir);
  }

  private async resolveLoadedPlanAction(
    plan: ResolutionPlan, artifactPath: string, action?: ResolutionAction, repoDir?: string
  ): Promise<PlanArtifact> {
    const filename = path.basename(artifactPath);
    if (!action || plan.action === action) return this.buildLoadedArtifact(plan, artifactPath, repoDir);
    const resolvedAction = await this.resolveActionMismatch(plan.action, action, filename);
    if (resolvedAction === plan.action) return this.buildLoadedArtifact(plan, artifactPath, repoDir);
    throw new ValidationError(
      `Plan action '${plan.action}' in '${filename}' does not match requested '${action}'. `
      + `Re-run with --from plan to regenerate.`
    );
  }

  private async buildLoadedArtifact(
    plan: ResolutionPlan, artifactPath: string, repoDir?: string
  ): Promise<PlanArtifact> {
    await this.validateLoadedPlan(plan, repoDir);
    return { plan, action: plan.action, path: artifactPath, fromCache: true };
  }

  extractSummary(content: string): string {
    const match = /^#\s+[A-Z]+-\d+:\s+(.+)$/m.exec(content);
    return match ? match[1] : 'Implementation';
  }

  enrichPlanWithDirectoryConfigs(plan: ResolutionPlan, repoDir: string): void {
    this.stageAgentService.enrichPlanWithDirectoryConfigs(plan, repoDir);
  }

  private readPlan(planPath: string): ResolutionPlan {
    try {
      return parsePlanArtifact(fs.readFileSync(planPath, 'utf-8'), planPath);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new WorkflowParseError(error instanceof Error ? error.message : `Plan file is not valid: ${path.basename(planPath)}`);
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

  private async getLoadedPlanViolations(
    plan: ResolutionPlan, repoDir: string
  ): Promise<Awaited<ReturnType<typeof validatePlanQualityWithLookups>>> {
    const testInfra = detectTestInfra(repoDir);
    const skillRules = await this.resolveSkillRulesForPlan();
    return await validatePlanQualityWithLookups({
      plan,
      affectedRepositories: plan.affectedRepositories,
      testInfra,
      skillRules,
      packageManager: detectPackageManager(repoDir),
      repoDir,
    });
  }

  private async validateLoadedPlan(plan: ResolutionPlan, repoDir?: string): Promise<void> {
    const resolvedRepoDir = this.resolveRepoDirOrThrow(repoDir);
    const violations = await this.getLoadedPlanViolations(plan, resolvedRepoDir);
    if (violations.length === 0) return;
    const formatted = violations.map(v => `[${v.ruleId}] ${v.message}`);
    console.log(formatPlanQualityViolations(formatted, 'Plan quality violations (loaded plan)'));
    plan.risks = [...(plan.risks ?? []), ...formatted.map(toQualityRisk)];
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

  private async buildPlanContext(
    ticketContent: string, options: GeneratePlanOptions
  ): Promise<PlanGenerationContext> {
    const repoDir = options.repoDir ?? process.cwd();
    const testInfra = detectTestInfra(repoDir);
    const conventions = options.conventions ?? detectRepoConventions(repoDir);
    const skillIds = this.configService.get<string[]>('stages.plan.skills') ?? [];
    const skills = skillIds.length
      ? await resolveSkills(skillIds, { interactive: this.isInteractiveSession(), stage: 'plan' })
      : [];
    const skillRules = collectQualityRules(skills);
    return { ticketContent, options: { ...options, repoDir, conventions }, testInfra, skillIds, skillRules };
  }

  private async validatePlanViolations(
    plan: ResolutionPlan, ctx: PlanGenerationContext
  ): Promise<PlanQualityViolations> {
    const violations = await validatePlanQualityWithLookups({
      plan,
      affectedRepositories: ctx.options.affectedRepositories,
      testInfra: ctx.testInfra,
      skillRules: ctx.skillRules,
      packageManager: ctx.options.conventions?.packageManager,
      repoDir: ctx.options.repoDir,
    });
    return splitViolations(violations);
  }

  private withAdvisoryRisks(attempt: PlanResult, violations: string[]): PlanResult {
    return violations.length === 0 ? attempt : this.applyQualityViolationsToRisks(attempt, violations);
  }

  private applyQualityViolationsToRisks(attempt: PlanResult, violations: string[]): PlanResult {
    console.log(formatPlanQualityViolations(violations, 'Plan quality violations persisted after retry'));
    const existingRisks = attempt.plan.risks ?? [];
    const risks = [...existingRisks, ...violations.map(toQualityRisk)];
    const plan = { ...attempt.plan, risks };
    return {
      ...attempt,
      plan: { ...plan, estimatedComplexity: estimatePlanComplexity(plan) },
    };
  }

  private buildStandardContext(ctx: PlanGenerationContext) {
    const { options: o, ticketContent, testInfra, skillIds } = ctx;
    return {
      ticketKey: o.ticketKey,
      summary: this.extractSummary(ticketContent),
      affectedRepositories: o.affectedRepositories,
      testInfra,
      conventions: o.conventions,
      priorPlans: o.priorPlans,
      planCorrelation: o.planCorrelation,
      crossRepoPatterns: o.crossRepoPatterns,
      figmaLinks: o.figmaLinks, uiDesignScreenshots: o.uiDesignScreenshots,
      reuseCandidates: o.reuseCandidates, skillNames: skillIds.length ? skillIds : undefined,
    };
  }

  private buildAgentPlanParams(ctx: PlanGenerationContext, feedback?: string[]) {
    const { options: o, ticketContent, testInfra, skillIds } = ctx;
    return {
      action: o.action, issueContent: ticketContent, planQualityFeedback: feedback,
      ticketKey: o.ticketKey, affectedRepositories: o.affectedRepositories, testInfra,
      conventions: o.conventions, priorPlans: o.priorPlans, planCorrelation: o.planCorrelation,
      crossRepoPatterns: o.crossRepoPatterns, figmaLinks: o.figmaLinks, uiDesignScreenshots: o.uiDesignScreenshots,
      reuseCandidates: o.reuseCandidates,
      skillNames: skillIds.length ? skillIds : undefined,
      onProgress: o.onProgress, priorStageSummary: o.priorStageSummary,
      resumeProviderSessionId: o.resumeProviderSessionId,
    };
  }

  private async generatePlanViaAgent(
    ctx: PlanGenerationContext, feedback?: string[]
  ): Promise<PlanResult> {
    try {
      return await this.stageAgentService.generatePlan(this.buildAgentPlanParams(ctx, feedback));
    } catch (error) {
      return this.handleAgentPlanError(error, ctx, feedback);
    }
  }

  private isFallbackEligible(error: AiProviderError): boolean {
    if (error.category === 'rate-limit') return false;
    return error.message.includes('Failed to parse resolution plan')
      || error.message.includes('CLI finished without returning a result');
  }

  private async handleAgentPlanError(
    error: unknown, ctx: PlanGenerationContext, feedback?: string[]
  ): Promise<PlanResult> {
    if (!isAiProviderErrorLike(error)) throw error;
    if (!this.isFallbackEligible(error)) throw error;
    const agentProse = typeof error.details?.response === 'string' && error.details.response.trim()
      ? error.details.response
      : undefined;
    const sessionId = typeof error.details?.sessionId === 'string' ? error.details.sessionId : undefined;
    const repaired = await this.recoverPlanFromParseError(error, sessionId);
    if (repaired) return repaired;
    return this.executeFallbackCompletion(error, agentProse, sessionId, ctx, feedback);
  }

  private notifyFallback(error: unknown, fallbackReason: string, sessionId?: string): void {
    this.logFallbackDecision(error, { fallbackReason, sessionId });
    console.log(chalk.yellow(`  ⚠ Agent returned ${fallbackReason} — falling back to structured completion billed to the configured API key`));
  }

  private isValidPlan(result: unknown): result is ResolutionPlan {
    const r = result as Partial<ResolutionPlan>;
    return Boolean(r?.action && r?.summary && Array.isArray(r?.steps));
  }

  private throwInvalidFallbackPlan(agentProse: string | undefined, result: unknown): never {
    throw new AiProviderError(
      'Fallback completion did not produce a valid resolution plan.'
      + ' Both agent and standard completion failed to return JSON.',
      { agentResponse: agentProse?.slice(0, 500), fallbackResult: result },
      true, 'parse'
    );
  }

  private async executeFallbackCompletion(
    error: unknown, agentProse: string | undefined, sessionId: string | undefined,
    ctx: PlanGenerationContext, feedback?: string[]
  ): Promise<PlanResult> {
    const fallbackReason = agentProse ? 'prose' : 'no result';
    this.notifyFallback(error, fallbackReason, sessionId);
    const result = await this.aiService.generatePlan(ctx.options.action, ctx.ticketContent, {
      ...this.buildStandardContext(ctx),
      planQualityFeedback: feedback,
      ...(agentProse ? { agentAnalysis: agentProse } : {}),
    });
    if (!this.isValidPlan(result)) this.throwInvalidFallbackPlan(agentProse, result);
    console.log(chalk.green('  ✔ Fallback produced valid plan'));
    return { plan: result, sessionId };
  }

  private async generatePlanAttempt(
    ctx: PlanGenerationContext, feedback?: string[]
  ): Promise<PlanResult> {
    if (this.stageAgentService.isEnabledForStage('plan')) {
      return this.generatePlanViaAgent(ctx, feedback);
    }
    const plan = await this.aiService.generatePlan(ctx.options.action, ctx.ticketContent, {
      ...this.buildStandardContext(ctx),
      planQualityFeedback: feedback,
    });
    return { plan };
  }
}
