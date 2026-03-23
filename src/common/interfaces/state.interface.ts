import { StageResult } from './stage.interface';

export interface WorkflowState {
  executionId: string;
  workflowId: string;
  status: WorkflowStatus;
  currentStepIndex: number;
  context: WorkflowStateContext;
  results: StageResult[];
  checkpoints: Checkpoint[];
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export enum WorkflowStatus {
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  PENDING_APPROVAL = 'pending-approval',
  PAUSED = 'paused',
}

export interface WorkflowStateContext {
  workflowId: string;
  parameters: Record<string, any>;
  outputs: Record<string, any>;
  environment: Record<string, any>;
}

export interface Checkpoint {
  stepId: string;
  stepIndex: number;
  timestamp: Date;
  state: Record<string, any>;
  outputs: Record<string, any>;
}

export interface StateQuery {
  workflowId?: string;
  status?: WorkflowStatus;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
}
