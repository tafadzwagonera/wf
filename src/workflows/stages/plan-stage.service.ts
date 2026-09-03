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
import { extractFigmaLinks, resolvePostParseFigmaLinks } from '../../shared/utils/extract-figma-links';
import { PlanArtifact, PlannerOptions, ResolutionAction, TicketArtifact } from '../../agents/interfaces';
import { AiProviderError, AppError, isAiProviderErrorLike, PlanArtifactNotFoundError, ValidationError, WorkflowParseError } from '../../shared/utils/errors';
import { appendToLogFile } from '../../shared/logger/log-file-writer';
import { detectTestInfra, type TestInfraContext } from '../../shared/utils/detect-test-infra';
import { validatePlanQuality } from '../../shared/utils/plan-quality';
import type { RepoConventionsContext,
  PriorPlanContext,
  PlanCorrelationResult,
  CrossRepoContext
} from '../../shared/types/detection.types';

type PlanResult = { plan: ResolutionPlan; sessionId?: string };

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

  async generatePlan(
    ticketContent: string,
    options: GeneratePlanOptions
  ): Promise<PlanResult> {
    const ctx = await this.buildPlanContext(ticketContent, options);
    const firstAttempt = await this.generatePlanAttempt(ctx);
    const firstViolations = this.validatePlanViolations(firstAttempt.plan, ctx);
    if (firstViolations.length === 0) return firstAttempt;
    const retryAttempt = await this.generatePlanAttempt(ctx, firstViolations);
    const retryViolations = this.validatePlanViolations(retryAttempt.plan, ctx);
    if (retryViolations.length > 0) return this.applyQualityViolationsToRisks(retryAttempt, retryViolations);
    return retryAttempt;
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
    try {
      return await this.resolveCachedPlan(ticket, options, artifactDir);
    } catch (error) {
      if (error instanceof PlanArtifactNotFoundError) return null;
      throw error;
    }
  }

  private persistPlanArtifact(
    plan: ResolutionPlan, action: ResolutionAction, artifactDir: string,
    planHash: string, sourceName: string, sourceKind: 'ticket' | 'custom' | undefined,
    figmaLinks: string[]
  ): PlanArtifact {
    const createdAt = new Date();
    const filename = buildPlanArtifactFilename({ createdAt, hash: planHash, action, format: 'json' });
    const planPath = path.join(artifactDir, filename);
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: action, format: 'json', hash: planHash, sourceName: sourceName, sourceKind: sourceKind ?? 'ticket', createdAt: createdAt, figmaLinks: figmaLinks.length ? figmaLinks : undefined });
    writePlanArtifactManifest(manifest);
    this.deleteStalePlanArtifacts(artifactDir, planHash, action, planPath);
    return { plan, action, path: planPath, fromCache: false };
  }

  private warnNoFigmaLinks(reason: 'no-links-found' | 'non-interactive-session'): void {
    appendToLogFile('WARN', `No Figma frame links found in ticket (${reason}) — figma-implement/figma-design-check will be skipped.`, 'figma-stage');
  }

  async createPlanArtifact(ticket: TicketArtifact, options: PlannerOptions): Promise<PlanArtifact> {
    const cached = await this.tryReuseCachedPlan(ticket, options, path.dirname(ticket.path));
    if (cached) return cached;
    const { plan, sessionId, figmaLinks } = await this.executePlanGeneration(ticket, options);
    if (!figmaLinks.length) this.warnNoFigmaLinks(this.isInteractiveSession() ? 'no-links-found' : 'non-interactive-session');
    this.enrichPlanWithDirectoryConfigs(plan, options.repoDir ?? process.cwd());
    const result = this.persistPlanArtifact(plan, options.action, path.dirname(ticket.path),
      hashPlanArtifactSources([ticket.ticketKey]), ticket.ticketKey, options.sourceKind, figmaLinks);
    return { ...result, sessionId };
  }

  private async executePlanGeneration(ticket: TicketArtifact, options: PlannerOptions) {
    const autoLinks = extractFigmaLinks(ticket.content);
    const { plan, sessionId } = await this.generatePlan(ticket.content, {
      action: options.action, ticketKey: ticket.ticketKey,
      affectedRepositories: options.affectedRepositories, onProgress: options.onProgress,
      figmaLinks: autoLinks,
    });
    const figmaLinks = await resolvePostParseFigmaLinks(
      ticket.content, autoLinks, { allowPrompt: this.isInteractiveSession(), repoDir: options.repoDir }
    );
    return { plan, sessionId, figmaLinks };
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

  private async buildPlanContext(
    ticketContent: string, options: GeneratePlanOptions
  ): Promise<PlanGenerationContext> {
    const testInfra = detectTestInfra(options.repoDir ?? process.cwd());
    const skillIds = this.configService.get<string[]>('stages.plan.skills') ?? [];
    const skills = skillIds.length
      ? await resolveSkills(skillIds, { interactive: this.isInteractiveSession(), stage: 'plan' })
      : [];
    const skillRules = collectQualityRules(skills);
    return { ticketContent, options, testInfra, skillIds, skillRules };
  }

  private validatePlanViolations(plan: ResolutionPlan, ctx: PlanGenerationContext): string[] {
    const violations = validatePlanQuality({
      plan,
      affectedRepositories: ctx.options.affectedRepositories,
      testInfra: ctx.testInfra,
      skillRules: ctx.skillRules,
    });
    return violations.map(v => `[${v.ruleId}] ${v.message}`);
  }

  private applyQualityViolationsToRisks(attempt: PlanResult, violations: string[]): PlanResult {
    const bullets = violations.map(v => '      ' + v).join('\n');
    console.log(chalk.yellow(`  ⚠ Plan quality violations persisted after retry:\n${bullets}`));
    const existingRisks = attempt.plan.risks ?? [];
    const qualityRisks = violations.map(v => `[plan-quality] ${v}`);
    return {
      ...attempt,
      plan: { ...attempt.plan, risks: [...existingRisks, ...qualityRisks] },
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
      figmaLinks: o.figmaLinks,
      skillNames: skillIds.length ? skillIds : undefined,
    };
  }

  private buildAgentPlanParams(ctx: PlanGenerationContext, feedback?: string[]) {
    const { options: o, ticketContent, testInfra, skillIds } = ctx;
    return {
      action: o.action, issueContent: ticketContent, planQualityFeedback: feedback,
      ticketKey: o.ticketKey, affectedRepositories: o.affectedRepositories, testInfra,
      conventions: o.conventions, priorPlans: o.priorPlans, planCorrelation: o.planCorrelation,
      crossRepoPatterns: o.crossRepoPatterns, figmaLinks: o.figmaLinks,
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

  private async handleAgentPlanError(
    error: unknown, ctx: PlanGenerationContext, feedback?: string[]
  ): Promise<PlanResult> {
    if (!isAiProviderErrorLike(error)) throw error;
    const eligible = error.message.includes('Failed to parse resolution plan')
      || error.message.includes('CLI finished without returning a result');
    if (!eligible) throw error;
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
    console.log(chalk.yellow(`  ⚠ Agent returned ${fallbackReason} — falling back to structured completion`));
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
