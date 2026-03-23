export interface Workflow {
  metadata: WorkflowMetadata;
  invocation: WorkflowInvocation;
  steps: ExecutionStep[];
  evaluationCriteria: string[];
}

export interface WorkflowMetadata {
  name: string;
  description: string;
  autoExecutionMode: boolean;
  version?: string;
  tags?: string[];
}

export interface WorkflowInvocation {
  command: string;
  parameters: WorkflowParameter[];
  examples?: string[];
}

export interface WorkflowParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'file' | 'directory' | 'choice';
  description: string;
  required: boolean;
  default?: any;
  choices?: string[];
  validation?: string;
}

export interface ExecutionStep {
  id: string;
  title: string;
  order: number;
  instructions: string[];
  actions: StepAction[];
  requiresApproval: boolean;
  retryable: boolean;
  dependencies?: string[];
  timeout?: number;
}

export interface StepAction {
  type: 'bash' | 'ai' | 'jira' | 'git' | 'file' | 'approval';
  executor: string;
  config: Record<string, any>;
  retryable?: boolean;
}

export interface WorkflowContext {
  workflowId: string;
  executionId: string;
  parameters: Record<string, any>;
  environment: Record<string, any>;
  startedAt: Date;
}
