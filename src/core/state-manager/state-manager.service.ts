import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  WorkflowState,
  WorkflowStatus,
  StateQuery,
  Checkpoint,
  StageResult,
} from '../../common/interfaces';
import { StateError } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';
import { getWfStateDir } from '../../shared/utils/wf-paths';

@Injectable()
export class StateManagerService {
  private stateDirectory: string;

  constructor(
    private configService: ConfigService,
    private logger: LoggerService,
  ) {
    this.stateDirectory = this.configService.get<string>(
      'state.directory',
      getWfStateDir(),
    );
    this.ensureStateDirectory();
  }

  private ensureStateDirectory(): void {
    if (!fs.existsSync(this.stateDirectory)) {
      fs.mkdirSync(this.stateDirectory, { recursive: true });
    }
  }

  async createWorkflowState(
    workflowId: string,
    parameters: Record<string, any>,
  ): Promise<WorkflowState> {
    const executionId = crypto.randomUUID();

    const state: WorkflowState = {
      executionId,
      workflowId,
      status: WorkflowStatus.RUNNING,
      currentStepIndex: 0,
      context: {
        workflowId,
        parameters,
        outputs: {},
        environment: process.env as Record<string, any>,
      },
      results: [],
      checkpoints: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.saveState(state);
    this.logger.debug(`Created workflow state: ${executionId}`);

    return state;
  }

  async saveState(state: WorkflowState): Promise<void> {
    const filePath = this.getStateFilePath(state.executionId);

    try {
      state.updatedAt = new Date();
      const jsonContent = JSON.stringify(state, null, 2);
      fs.writeFileSync(filePath, jsonContent, 'utf-8');
    } catch (error) {
      throw new StateError(
        `Failed to save workflow state: ${state.executionId}`,
        error,
      );
    }
  }

  async loadState(executionId: string): Promise<WorkflowState> {
    const filePath = this.getStateFilePath(executionId);

    if (!fs.existsSync(filePath)) {
      throw new StateError(`Workflow state not found: ${executionId}`);
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const state = JSON.parse(content) as WorkflowState;

      // Convert date strings to Date objects
      state.createdAt = new Date(state.createdAt);
      state.updatedAt = new Date(state.updatedAt);
      if (state.completedAt) {
        state.completedAt = new Date(state.completedAt);
      }

      return state;
    } catch (error) {
      throw new StateError(
        `Failed to load workflow state: ${executionId}`,
        error,
      );
    }
  }

  async updateStatus(
    executionId: string,
    status: WorkflowStatus,
  ): Promise<void> {
    const state = await this.loadState(executionId);
    state.status = status;

    if (
      status === WorkflowStatus.COMPLETED ||
      status === WorkflowStatus.FAILED ||
      status === WorkflowStatus.CANCELLED
    ) {
      state.completedAt = new Date();
    }

    await this.saveState(state);
  }

  async addStageResult(
    executionId: string,
    result: StageResult,
  ): Promise<void> {
    const state = await this.loadState(executionId);
    state.results.push(result);

    // Update context outputs with result outputs
    state.context.outputs = {
      ...state.context.outputs,
      ...result.outputs,
    };

    await this.saveState(state);
  }

  async createCheckpoint(
    executionId: string,
    stepId: string,
    stepIndex: number,
    outputs: Record<string, any>,
  ): Promise<void> {
    const state = await this.loadState(executionId);

    const checkpoint: Checkpoint = {
      stepId,
      stepIndex,
      timestamp: new Date(),
      state: { status: state.status },
      outputs,
    };

    state.checkpoints.push(checkpoint);
    state.currentStepIndex = stepIndex;

    await this.saveState(state);
    this.logger.debug(`Created checkpoint for step: ${stepId}`);
  }

  async listStates(query?: StateQuery): Promise<WorkflowState[]> {
    const files = fs.readdirSync(this.stateDirectory);
    const stateFiles = files.filter((file) => file.endsWith('.json'));

    const states: WorkflowState[] = [];

    for (const file of stateFiles) {
      try {
        const filePath = path.join(this.stateDirectory, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const state = JSON.parse(content) as WorkflowState;

        // Convert dates
        state.createdAt = new Date(state.createdAt);
        state.updatedAt = new Date(state.updatedAt);
        if (state.completedAt) {
          state.completedAt = new Date(state.completedAt);
        }

        // Apply filters
        if (query) {
          if (query.workflowId && state.workflowId !== query.workflowId) {
            continue;
          }
          if (query.status && state.status !== query.status) {
            continue;
          }
          if (query.fromDate && state.createdAt < query.fromDate) {
            continue;
          }
          if (query.toDate && state.createdAt > query.toDate) {
            continue;
          }
        }

        states.push(state);
      } catch {
        this.logger.warn(`Failed to read state file: ${file}`);
      }
    }

    // Sort by creation date (newest first)
    states.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Apply limit
    if (query?.limit) {
      return states.slice(0, query.limit);
    }

    return states;
  }

  async deleteState(executionId: string): Promise<void> {
    const filePath = this.getStateFilePath(executionId);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this.logger.debug(`Deleted workflow state: ${executionId}`);
    }
  }

  private getStateFilePath(executionId: string): string {
    return path.join(this.stateDirectory, `${executionId}.json`);
  }
}
