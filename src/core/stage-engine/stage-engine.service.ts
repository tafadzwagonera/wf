import { Injectable } from '@nestjs/common';
import {
  Workflow,
  ExecutionStep,
  StageContext,
  StageResult,
  StageStatus,
  WorkflowState,
  WorkflowStatus,
} from '../../common/interfaces';
import { StateManagerService } from '../state-manager/state-manager.service';
import { ApprovalSystemService } from '../approval-system/approval-system.service';
import { BashExecutor } from './action-executors/bash-executor';
import { AIExecutor } from './action-executors/ai-executor';
import { JiraExecutor } from './action-executors/jira-executor';
import { GitExecutor } from './action-executors/git-executor';
import { FileExecutor } from './action-executors/file-executor';
import { ActionExecutor } from './action-executors/base-executor';
import { LoggerService } from '../../shared/logger/logger.service';
import { ExecutionError, UserCancelledError } from '../../shared/utils/errors';
import { ApprovalDecision } from '../../common/interfaces';

@Injectable()
export class StageEngineService {
  private executors: Map<string, ActionExecutor>;

  constructor(
    private stateManager: StateManagerService,
    private approvalSystem: ApprovalSystemService,
    private bashExecutor: BashExecutor,
    private aiExecutor: AIExecutor,
    private jiraExecutor: JiraExecutor,
    private gitExecutor: GitExecutor,
    private fileExecutor: FileExecutor,
    private logger: LoggerService,
  ) {
    this.executors = new Map<string, ActionExecutor>([
      ['bash', this.bashExecutor as ActionExecutor],
      ['ai', this.aiExecutor as ActionExecutor],
      ['jira', this.jiraExecutor as ActionExecutor],
      ['git', this.gitExecutor as ActionExecutor],
      ['file', this.fileExecutor as ActionExecutor],
    ]);
  }

  async executeWorkflow(
    workflow: Workflow,
    parameters: Record<string, any>,
  ): Promise<WorkflowState> {
    this.logger.info(`Starting workflow: ${workflow.metadata.name}`);

    // Create initial state
    const state = await this.stateManager.createWorkflowState(
      workflow.metadata.name,
      parameters,
    );

    try {
      // Execute steps sequentially
      for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];

        // Display progress
        this.approvalSystem.displayProgress(
          i + 1,
          workflow.steps.length,
          step.title,
        );

        // Execute step with retry capability
        const stepResult = await this.executeStep(
          step,
          state,
          workflow.metadata.autoExecutionMode,
        );

        // Add result to state
        await this.stateManager.addStageResult(state.executionId, stepResult);

        // Create checkpoint
        await this.stateManager.createCheckpoint(
          state.executionId,
          step.id,
          i,
          stepResult.outputs,
        );

        // Check if workflow should continue
        if (stepResult.status === StageStatus.CANCELLED) {
          await this.stateManager.updateStatus(
            state.executionId,
            WorkflowStatus.CANCELLED,
          );
          throw new UserCancelledError();
        }

        if (stepResult.status === StageStatus.FAILURE && !step.retryable) {
          await this.stateManager.updateStatus(
            state.executionId,
            WorkflowStatus.FAILED,
          );
          throw new ExecutionError(
            `Step ${step.title} failed and is not retryable`,
            stepResult.error,
          );
        }
      }

      // Mark workflow as completed
      await this.stateManager.updateStatus(
        state.executionId,
        WorkflowStatus.COMPLETED,
      );

      this.logger.success(`Workflow completed: ${workflow.metadata.name}`);

      return await this.stateManager.loadState(state.executionId);
    } catch (error) {
      if (error instanceof UserCancelledError) {
        this.logger.warn('Workflow cancelled by user');
      } else {
        this.logger.error('Workflow execution failed', error);
        await this.stateManager.updateStatus(
          state.executionId,
          WorkflowStatus.FAILED,
        );
      }
      throw error;
    }
  }

  async resumeWorkflow(
    executionId: string,
    workflow: Workflow,
  ): Promise<WorkflowState> {
    this.logger.info(`Resuming workflow: ${executionId}`);

    const state = await this.stateManager.loadState(executionId);

    if (state.status === WorkflowStatus.COMPLETED) {
      this.logger.warn('Workflow is already completed');
      return state;
    }

    if (state.status === WorkflowStatus.FAILED) {
      this.logger.info('Retrying failed workflow from last checkpoint');
    }

    try {
      // Update status to running
      await this.stateManager.updateStatus(executionId, WorkflowStatus.RUNNING);

      // Resume from next step after last checkpoint
      const startIndex = state.currentStepIndex + 1;

      this.logger.info(
        `Resuming from step ${startIndex + 1}/${workflow.steps.length}`,
      );

      // Execute remaining steps
      for (let i = startIndex; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];

        // Display progress
        this.approvalSystem.displayProgress(
          i + 1,
          workflow.steps.length,
          step.title,
        );

        // Execute step with retry capability
        const stepResult = await this.executeStep(
          step,
          state,
          workflow.metadata.autoExecutionMode,
        );

        // Add result to state
        await this.stateManager.addStageResult(state.executionId, stepResult);

        // Create checkpoint
        await this.stateManager.createCheckpoint(
          state.executionId,
          step.id,
          i,
          stepResult.outputs,
        );

        // Reload state to get updated version
        const updatedState = await this.stateManager.loadState(executionId);
        Object.assign(state, updatedState);

        // Check if workflow should continue
        if (stepResult.status === StageStatus.CANCELLED) {
          await this.stateManager.updateStatus(
            state.executionId,
            WorkflowStatus.CANCELLED,
          );
          throw new UserCancelledError();
        }

        if (stepResult.status === StageStatus.FAILURE && !step.retryable) {
          await this.stateManager.updateStatus(
            state.executionId,
            WorkflowStatus.FAILED,
          );
          throw new ExecutionError(
            `Step ${step.title} failed and is not retryable`,
            stepResult.error,
          );
        }
      }

      // Mark workflow as completed
      await this.stateManager.updateStatus(
        state.executionId,
        WorkflowStatus.COMPLETED,
      );

      this.logger.success(`Workflow completed: ${workflow.metadata.name}`);

      return await this.stateManager.loadState(state.executionId);
    } catch (error) {
      if (error instanceof UserCancelledError) {
        this.logger.warn('Workflow cancelled by user');
      } else {
        this.logger.error('Workflow execution failed', error);
        await this.stateManager.updateStatus(
          state.executionId,
          WorkflowStatus.FAILED,
        );
      }
      throw error;
    }
  }

  private async executeStep(
    step: ExecutionStep,
    state: WorkflowState,
    autoExecutionMode: boolean,
  ): Promise<StageResult> {
    const context: StageContext = {
      workflowId: state.workflowId,
      stepId: step.id,
      parameters: state.context.parameters,
      previousOutputs: state.context.outputs,
      environment: state.context.environment,
      retryCount: 0,
    };

    let shouldRetry = true;
    let lastResult: StageResult | null = null;

    while (shouldRetry) {
      // Execute actions in the step
      const result = await this.executeStepActions(step, context);

      lastResult = {
        stepId: step.id,
        status: result.status || StageStatus.SUCCESS,
        outputs: result.outputs || {},
        artifacts: result.artifacts,
        error: result.error,
        startedAt: new Date(),
        completedAt: result.completedAt || new Date(),
        duration: result.duration,
      };

      // Check if approval is required
      if (step.requiresApproval && !autoExecutionMode) {
        const approvalResponse = await this.approvalSystem.requestApproval({
          stepId: step.id,
          stepTitle: step.title,
          result: lastResult,
          retryable: step.retryable,
          context: {
            workflowId: state.workflowId,
            currentStep: state.currentStepIndex + 1,
            totalSteps: state.results.length,
            previousResults: state.results,
          },
        });

        switch (approvalResponse.decision) {
          case ApprovalDecision.PROCEED:
            shouldRetry = false;
            break;

          case ApprovalDecision.RETRY:
            if (!step.retryable) {
              this.logger.warn('Step is not retryable, proceeding anyway');
              shouldRetry = false;
            } else {
              this.logger.info('Retrying step with modifications');
              context.retryCount++;

              // Apply modifications if provided
              if (approvalResponse.modifications) {
                if (approvalResponse.modifications.parameters) {
                  context.parameters = {
                    ...context.parameters,
                    ...approvalResponse.modifications.parameters,
                  };
                }
              }
              shouldRetry = true;
            }
            break;

          case ApprovalDecision.SKIP:
            lastResult.status = StageStatus.SKIPPED;
            shouldRetry = false;
            break;

          case ApprovalDecision.CANCEL:
            lastResult.status = StageStatus.CANCELLED;
            shouldRetry = false;
            break;
        }
      } else {
        shouldRetry = false;
      }
    }

    return lastResult!;
  }

  private async executeStepActions(
    step: ExecutionStep,
    context: StageContext,
  ): Promise<Partial<StageResult>> {
    const results: Partial<StageResult>[] = [];

    // If no actions defined, execute instructions as bash commands
    if (!step.actions || step.actions.length === 0) {
      // For now, just return success for steps without actions
      return {
        status: StageStatus.SUCCESS,
        outputs: { message: 'Step has no actions defined' },
        completedAt: new Date(),
      };
    }

    // Execute each action sequentially
    for (const action of step.actions) {
      const executor = this.executors.get(action.type);

      if (!executor) {
        throw new ExecutionError(`Unknown action type: ${action.type}`, {
          action,
        });
      }

      try {
        const result = await executor.execute(action.config, context);
        results.push(result);

        // If any action fails and is not retryable, stop execution
        if (result.status === StageStatus.FAILURE && !action.retryable) {
          return result;
        }
      } catch (error) {
        this.logger.error(`Action ${action.type} failed`, error);
        return {
          status: StageStatus.FAILURE,
          outputs: {},
          error: {
            code: 'ACTION_EXECUTION_ERROR',
            message: error instanceof Error ? error.message : String(error),
            details: error,
            recoverable: action.retryable || false,
          },
          completedAt: new Date(),
        };
      }
    }

    // Merge all results
    const mergedOutputs = results.reduce(
      (acc, result) => ({ ...acc, ...result.outputs }),
      {},
    );

    const mergedArtifacts = results.flatMap((result) => result.artifacts || []);

    const allSuccessful = results.every(
      (result) => result.status === StageStatus.SUCCESS,
    );

    return {
      status: allSuccessful ? StageStatus.SUCCESS : StageStatus.FAILURE,
      outputs: mergedOutputs,
      artifacts: mergedArtifacts,
      completedAt: new Date(),
    };
  }
}
