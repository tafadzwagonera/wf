import type { ErrorCode } from '../schemas/error.schema';
import { ERROR_CODE } from '../schemas/error.schema';
export { ERROR_CODE } from '../schemas/error.schema';

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: any,
    public recoverable: boolean = false
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ApiError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    public statusCode?: number,
    public endpoint?: string,
    details?: any,
    recoverable: boolean = false
  ) {
    super(code, message, details, recoverable);
    this.name = 'ApiError';
  }
}

export class WorkflowParseError extends AppError {
  constructor(message: string, details?: any) {
    super(ERROR_CODE.WORKFLOW_PARSE_ERROR, message, details, false);
    this.name = 'WorkflowParseError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(ERROR_CODE.VALIDATION_ERROR, message, details, false);
    this.name = 'ValidationError';
  }
}

export class ExecutionError extends AppError {
  constructor(message: string, details?: any, recoverable: boolean = false) {
    super(ERROR_CODE.EXECUTION_ERROR, message, details, recoverable);
    this.name = 'ExecutionError';
  }
}

export class JiraApiError extends AppError {
  constructor(message: string, details?: any, recoverable: boolean = true) {
    super(ERROR_CODE.JIRA_API_ERROR, message, details, recoverable);
    this.name = 'JiraApiError';
  }
}

export class GitError extends AppError {
  constructor(message: string, details?: any, recoverable: boolean = true) {
    super(ERROR_CODE.GIT_ERROR, message, details, recoverable);
    this.name = 'GitError';
  }
}

export type AiProviderErrorCategory = 'auth' | 'api' | 'parse' | 'timeout' | 'truncation' | 'stall' | 'config';

export class AiProviderError extends AppError {
  constructor(
    message: string,
    details?: any,
    recoverable: boolean = true,
    public category?: AiProviderErrorCategory
  ) {
    super(ERROR_CODE.AI_PROVIDER_ERROR, message, details, recoverable);
    this.name = 'AiProviderError';
  }
}

export const isAiProviderErrorLike = (error: unknown): error is AiProviderError => {
  if (error instanceof AiProviderError) return true;
  if (error instanceof AppError && error.code === ERROR_CODE.AI_PROVIDER_ERROR) {
    return true;
  }
  if (!error || typeof error !== 'object') return false;
  const maybeError = error as { code?: unknown; name?: unknown };
  return (
    maybeError.code === ERROR_CODE.AI_PROVIDER_ERROR || maybeError.code === 'AI_ERROR' || maybeError.name === 'AiProviderError'
  );
};

export class StateError extends AppError {
  constructor(message: string, details?: any, recoverable: boolean = true) {
    super(ERROR_CODE.STATE_ERROR, message, details, recoverable);
    this.name = 'StateError';
  }
}

export class UserCancelledError extends AppError {
  constructor(message: string = 'Operation cancelled by user') {
    super(ERROR_CODE.USER_CANCELLED, message, null, false);
    this.name = 'UserCancelledError';
  }
}

export class ApprovalError extends AppError {
  constructor(message: string, details?: any) {
    super(ERROR_CODE.APPROVAL_ERROR, message, details, false);
    this.name = 'ApprovalError';
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, details?: any) {
    super(ERROR_CODE.CONFIGURATION_ERROR, message, details, false);
    this.name = 'ConfigurationError';
  }
}

export class FileSystemError extends AppError {
  constructor(message: string, details?: any) {
    super(ERROR_CODE.FILE_SYSTEM_ERROR, message, details, true);
    this.name = 'FileSystemError';
  }
}

export class PlanArtifactNotFoundError extends ValidationError {
  constructor(message: string, details?: any) {
    super(message, details);
    this.name = 'PlanArtifactNotFoundError';
  }
}

export class RepoLockError extends AppError {
  constructor(message: string, details?: any) {
    super(ERROR_CODE.REPO_LOCK_ERROR, message, details, true);
    this.name = 'RepoLockError';
  }
}
