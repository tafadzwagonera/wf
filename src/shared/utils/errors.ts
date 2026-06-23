export enum ErrorCode {
  WORKFLOW_PARSE_ERROR = 'WORKFLOW_PARSE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  EXECUTION_ERROR = 'EXECUTION_ERROR',
  JIRA_API_ERROR = 'JIRA_API_ERROR',
  GIT_ERROR = 'GIT_ERROR',
  AI_ERROR = 'AI_ERROR',
  STATE_ERROR = 'STATE_ERROR',
  USER_CANCELLED = 'USER_CANCELLED',
  APPROVAL_ERROR = 'APPROVAL_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  FILE_SYSTEM_ERROR = 'FILE_SYSTEM_ERROR',
}

export class AgentError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: any,
    public recoverable: boolean = false
  ) {
    super(message);
    this.name = 'AgentError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class WorkflowParseError extends AgentError {
  constructor(message: string, details?: any) {
    super(ErrorCode.WORKFLOW_PARSE_ERROR, message, details, false);
    this.name = 'WorkflowParseError';
  }
}

export class ValidationError extends AgentError {
  constructor(message: string, details?: any) {
    super(ErrorCode.VALIDATION_ERROR, message, details, false);
    this.name = 'ValidationError';
  }
}

export class ExecutionError extends AgentError {
  constructor(message: string, details?: any, recoverable: boolean = false) {
    super(ErrorCode.EXECUTION_ERROR, message, details, recoverable);
    this.name = 'ExecutionError';
  }
}

export class JiraApiError extends AgentError {
  constructor(message: string, details?: any, recoverable: boolean = true) {
    super(ErrorCode.JIRA_API_ERROR, message, details, recoverable);
    this.name = 'JiraApiError';
  }
}

export class GitError extends AgentError {
  constructor(message: string, details?: any, recoverable: boolean = true) {
    super(ErrorCode.GIT_ERROR, message, details, recoverable);
    this.name = 'GitError';
  }
}

export class AIError extends AgentError {
  constructor(message: string, details?: any, recoverable: boolean = true) {
    super(ErrorCode.AI_ERROR, message, details, recoverable);
    this.name = 'AIError';
  }
}

/**
 * Detects AI errors even when they cross module or runtime boundaries.
 *
 * @param error - Unknown thrown value
 * @returns True when the value represents an AI error
 */
export const isAIErrorLike = (error: unknown): error is AIError => {
  if (error instanceof AIError) {
    return true;
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeError = error as { code?: unknown; name?: unknown };
  return maybeError.code === ErrorCode.AI_ERROR || maybeError.name === 'AIError';
};

export class StateError extends AgentError {
  constructor(message: string, details?: any, recoverable: boolean = true) {
    super(ErrorCode.STATE_ERROR, message, details, recoverable);
    this.name = 'StateError';
  }
}

export class UserCancelledError extends AgentError {
  constructor(message: string = 'Operation cancelled by user') {
    super(ErrorCode.USER_CANCELLED, message, null, false);
    this.name = 'UserCancelledError';
  }
}

export class FileSystemError extends AgentError {
  constructor(message: string, details?: any) {
    super(ErrorCode.FILE_SYSTEM_ERROR, message, details, true);
    this.name = 'FileSystemError';
  }
}
