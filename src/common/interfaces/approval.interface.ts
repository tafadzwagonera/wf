import { StageResult } from './stage.interface';

export interface ApprovalRequest {
  stepId: string;
  stepTitle: string;
  result: StageResult;
  retryable: boolean;
  context: ApprovalContext;
}

export interface ApprovalContext {
  workflowId: string;
  currentStep: number;
  totalSteps: number;
  previousResults?: StageResult[];
}

export interface ApprovalResponse {
  decision: ApprovalDecision;
  modifications?: ApprovalModifications;
  reason?: string;
}

export enum ApprovalDecision {
  PROCEED = 'proceed',
  RETRY = 'retry',
  CANCEL = 'cancel',
  SKIP = 'skip',
}

export interface ApprovalModifications {
  parameters?: Record<string, any>;
  promptChanges?: string;
  skipActions?: string[];
  additionalInstructions?: string;
}

export interface ApprovalDisplay {
  title: string;
  outputs: OutputSection[];
  artifacts?: ArtifactDisplay[];
  metadata?: Record<string, any>;
}

export interface OutputSection {
  label: string;
  content: string;
  type: 'text' | 'json' | 'code' | 'table';
  language?: string;
}

export interface ArtifactDisplay {
  name: string;
  type: string;
  preview?: string;
  path?: string;
}
