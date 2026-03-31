import { Injectable } from '@nestjs/common';
import { BaseExecutor } from './base-executor';
import {
  StageContext,
  StageResult,
  Artifact,
} from '../../../common/interfaces';
import { AiService } from '../../../integrations/ai/ai.service';
import { LoggerService } from '../../../shared/logger/logger.service';

export interface AIActionConfig {
  type: 'plan' | 'commit-message' | 'code-review' | 'custom';
  prompt?: string;
  systemPrompt?: string;
  context?: Record<string, any>;
  maxTokens?: number;
  temperature?: number;
}

@Injectable()
export class AIExecutor extends BaseExecutor {
  constructor(
    private aiService: AiService,
    private logger: LoggerService,
  ) {
    super();
  }

  async execute(
    action: AIActionConfig,
    context: StageContext,
  ): Promise<Partial<StageResult>> {
    const { type, prompt, systemPrompt, maxTokens, temperature } = action;

    this.logger.debug(`Executing AI action: ${type}`);

    try {
      const startTime = Date.now();
      let result: any;

      switch (type) {
        case 'plan':
          result = await this.generatePlan(action, context);
          break;

        case 'commit-message':
          result = await this.generateCommitMessage(action, context);
          break;

        case 'code-review':
          result = await this.performCodeReview(action, context);
          break;

        case 'custom': {
          if (!prompt) {
            throw new Error('Custom AI action requires a prompt');
          }
          const response = await this.aiService.execute({
            prompt,
            systemPrompt,
            maxTokens,
            temperature,
          });
          result = { response: response.content };
          break;
        }

        default:
          throw new Error(`Unknown AI action type: ${type}`);
      }

      const duration = Date.now() - startTime;

      const artifacts: Artifact[] = [
        {
          type: 'json',
          name: 'AI Response',
          content: JSON.stringify(result, null, 2),
        },
      ];

      this.logger.success(`AI action completed in ${duration}ms`);

      return {
        ...this.createSuccessResult({ aiResult: result }),
        artifacts,
        duration,
      };
    } catch (error: any) {
      this.logger.error(`AI action failed: ${error.message}`);
      return this.createFailureResult(error, 'AI_EXECUTION_ERROR');
    }
  }

  private async generatePlan(
    action: AIActionConfig,
    context: StageContext,
  ): Promise<any> {
    const issueContent = action.context?.issueContent || action.prompt || '';
    const actionType = action.context?.action || 'implement';

    const plan = await this.aiService.generatePlan(
      actionType,
      issueContent,
      context.parameters,
    );

    return plan;
  }

  private async generateCommitMessage(
    action: AIActionConfig,
    context: StageContext,
  ): Promise<any> {
    void context;
    const diff = action.context?.diff || '';
    const commitHistory = action.context?.commitHistory || [];
    const format = action.context?.format || 'auto';

    const message = await this.aiService.generateCommitMessage(
      diff,
      commitHistory,
      format,
    );

    return { message };
  }

  private async performCodeReview(
    action: AIActionConfig,
    context: StageContext,
  ): Promise<any> {
    void context;
    const diff = action.context?.diff || '';
    const guidelines = action.context?.guidelines || [];

    const review = await this.aiService.reviewCode(diff, guidelines);

    return review;
  }
}
