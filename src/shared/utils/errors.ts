// Legacy enum — kept for backward compatibility during migration
export enum ErrorCode {
  WORKFLOW_PARSE_ERROR = 'WORKFLOW_PARSE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  EXECUTION_ERROR = 'EXECUTION_ERROR',
  JIRA_API_ERROR = 'JIRA_API_ERROR',
  GIT_ERROR = 'GIT_ERROR',
  AI_PROVIDER_ERROR = 'AI_PROVIDER_ERROR',
  STATE_ERROR = 'STATE_ERROR',
  USER_CANCELLED = 'USER_CANCELLED',
  APPROVAL_ERROR = 'APPROVAL_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  FILE_SYSTEM_ERROR = 'FILE_SYSTEM_ERROR',
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace ErrorCode {
  export const AI_ERROR = ErrorCode.AI_PROVIDER_ERROR;
}

export {
  AppError,
  ApiError,
  WorkflowParseError,
  ValidationError,
  ExecutionError,
  JiraApiError,
  GitError,
  AiProviderError,
  isAiProviderErrorLike,
  StateError,
  UserCancelledError,
  ApprovalError,
  ConfigurationError,
  FileSystemError,
  PlanArtifactNotFoundError,
  ERROR_CODE,
} from '../errors/app.error';
