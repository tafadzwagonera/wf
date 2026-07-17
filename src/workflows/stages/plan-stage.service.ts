import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
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
import { AIError, isAIErrorLike, ValidationError } from '../../shared/utils/errors';
import { detectTestInfra, type TestInfraContext } from '../../shared/utils/detect-test-infra';
import { validatePlanQuality } from '../../shared/utils/plan-quality';
import type { RepoConventionsContext } from '../../shared/utils/detect-repo-conventions';
import type { PriorPlanContext, PlanCorrelationResult } from '../../shared/utils/detect-prior-plans';
import type { CrossRepoContext } from '../../shared/utils/detect-cross-repo-patterns';

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
    private readonly stageAgentService: StageAgentService
  ) {}

  async generatePlan(
    ticketContent: string,
    options: GeneratePlanOptions
  ): Promise<{ plan: ResolutionPlan; sessionId?: string }> {
    const testInfra = detectTestInfra(options.repoDir ?? process.cwd());

    const standardContext = {
      ticketKey: options.ticketKey,
      summary: this.extractSummary(ticketContent),
      affectedRepositories: options.affectedRepositories,
      testInfra,
      conventions: options.conventions,
      priorPlans: options.priorPlans,
      planCorrelation: options.planCorrelation,
      crossRepoPatterns: options.crossRepoPatterns,
    };

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

          const label = agentProse ? 'Agent returned prose' : 'Agent returned no result';
          console.log(chalk.yellow(`  \u26A0\uFE0F ${label}   \u2014 falling back to structured completion`));
          const action = options.action as 'fix' | 'implement' | 'investigate';
          const fallbackResult = await this.aiService.generatePlan(action, ticketContent, {
            ...standardContext,
            planQualityFeedback,
            ...(agentProse ? { agentAnalysis: agentProse } : {}),
          });

          if (!fallbackResult?.action || !fallbackResult?.summary || !Array.isArray(fallbackResult?.steps)) {
            throw new AIError(
              'Fallback completion did not produce a valid resolution plan. Both agent and standard completion failed to return JSON.',
              { agentResponse: agentProse?.slice(0, 500), fallbackResult }
            );
          }

          console.log(chalk.green('  ✓ Fallback produced valid plan'));
          return { plan: fallbackResult, sessionId };
        }
      }

      const plan = await this.aiService.generatePlan(
        options.action as 'fix' | 'implement' | 'investigate',
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
          `  ⚠️ Plan quality violations persisted after retry:\n${retryViolations.map(v => `    • ${v}`).join('\n')}`
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
        const plan = this.readPlan(existing.artifactPath);

        if (plan.action === options.action) {
          return { plan, action: plan.action, path: existing.artifactPath, fromCache: true };
        }

        const resolvedAction = await this.resolveActionMismatch(
          plan.action, options.action, path.basename(existing.artifactPath)
        );

        if (resolvedAction === plan.action) {
          return { plan, action: plan.action, path: existing.artifactPath, fromCache: true };
        }

        // User chose the requested action — fall through to regeneration below.
      } catch (error) {
        if (error instanceof ValidationError) throw error;
        // No existing plan artifact could be resolved; fall through to generation.
      }
    }

    const { plan, sessionId } = await this.generatePlan(ticket.content, {
      action: options.action,
      ticketKey: ticket.ticketKey,
      affectedRepositories: options.affectedRepositories,
      onProgress: options.onProgress,
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
    return { plan, action: options.action, path: planPath, fromCache: false, sessionId };
  }

  async loadPlanArtifact(ticketPath: string, action?: ResolutionAction): Promise<PlanArtifact> {
    const artifactDir = path.dirname(ticketPath);
    const sourceName = path.basename(ticketPath, '.md');
    const resolved = resolvePlanArtifactReference(sourceName, {
      artifactDir,
      action,
    });

    const plan = this.readPlan(resolved.artifactPath);
    const filename = path.basename(resolved.artifactPath);

    if (!action || plan.action === action) {
      return { plan, action: plan.action, path: resolved.artifactPath, fromCache: true };
    }

    const resolvedAction = await this.resolveActionMismatch(plan.action, action, filename);

    if (resolvedAction === plan.action) {
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
   * Warn about a cached plan action mismatch and let the user pick the correct action.
   *
   * @param planAction - The action stored inside the cached plan file
   * @param requestedAction - The action requested by the caller
   * @param filename - The basename of the cached plan file (for display)
   * @returns The action the user selected
   * @throws ValidationError when the session is non-interactive
   */
  private async resolveActionMismatch(
    planAction: ResolutionAction,
    requestedAction: ResolutionAction,
    filename: string
  ): Promise<ResolutionAction> {
    console.log(
      chalk.yellow(
        `  ⚠️  Cached plan action mismatch for ${filename}: plan contains '${planAction}', requested '${requestedAction}'.`
      )
    );

    if (!this.isInteractiveSession()) {
      throw new ValidationError(
        `Cached plan action mismatch: '${filename}' contains '${planAction}' but '${requestedAction}' was requested. `
        + `Re-run with --from plan to regenerate, or re-run interactively to choose.`
      );
    }

    const { selectedAction } = await inquirer.prompt<{ selectedAction: ResolutionAction }>([{
      type: 'list',
      name: 'selectedAction',
      message: 'Which action should be used?',
      prefix: ' ',
      choices: [
        { name: `Use '${planAction}' (from cached plan)`, value: planAction },
        { name: `Use '${requestedAction}' (requested — may require re-running from plan stage)`, value: requestedAction },
      ],
      default: planAction,
    }]);

    return selectedAction;
  }

  private isInteractiveSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
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
