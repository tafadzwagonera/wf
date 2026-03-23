export interface StageContext {
  workflowId: string;
  stepId: string;
  parameters: Record<string, any>;
  previousOutputs: Record<string, any>;
  environment: Record<string, any>;
  retryCount: number;
}

export interface StageResult {
  stepId: string;
  status: StageStatus;
  outputs: Record<string, any>;
  artifacts?: Artifact[];
  error?: StageError;
  startedAt: Date;
  completedAt?: Date;
  duration?: number;
}

export enum StageStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  SUCCESS = 'success',
  FAILURE = 'failure',
  PENDING_APPROVAL = 'pending-approval',
  SKIPPED = 'skipped',
  CANCELLED = 'cancelled',
}

export interface Artifact {
  type: 'file' | 'url' | 'text' | 'json';
  name: string;
  path?: string;
  content?: string;
  metadata?: Record<string, any>;
}

export interface StageError {
  code: string;
  message: string;
  details?: any;
  recoverable: boolean;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
  totalSteps: number;
  estimatedDuration?: number;
}

interface ExecutionStep {
  id: string;
  title: string;
  order: number;
  dependencies: string[];
}
