// Legacy enum — kept for backward compatibility during migration
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

// Re-export everything from new locations
export {
  AppError,
  ApiError,
  WorkflowParseError,
  ValidationError,
  ExecutionError,
  JiraApiError,
  GitError,
  AIError,
  isAIErrorLike,
  StateError,
  UserCancelledError,
  ConfigurationError,
  FileSystemError,
  ERROR_CODE,
} from '../errors/app.error';
