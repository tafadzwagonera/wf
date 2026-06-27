import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'WORKFLOW_PARSE_ERROR',
  'VALIDATION_ERROR',
  'EXECUTION_ERROR',
  'JIRA_API_ERROR',
  'GIT_ERROR',
  'AI_ERROR',
  'STATE_ERROR',
  'USER_CANCELLED',
  'APPROVAL_ERROR',
  'CONFIGURATION_ERROR',
  'FILE_SYSTEM_ERROR',
]);

export const ERROR_CODE = {
  WORKFLOW_PARSE_ERROR: 'WORKFLOW_PARSE_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  JIRA_API_ERROR: 'JIRA_API_ERROR',
  GIT_ERROR: 'GIT_ERROR',
  AI_ERROR: 'AI_ERROR',
  STATE_ERROR: 'STATE_ERROR',
  USER_CANCELLED: 'USER_CANCELLED',
  APPROVAL_ERROR: 'APPROVAL_ERROR',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  FILE_SYSTEM_ERROR: 'FILE_SYSTEM_ERROR',
} as const;

export const appErrorSchema = z.object({
  name: z.string(),
  code: errorCodeSchema,
  message: z.string(),
  details: z.any().optional(),
  recoverable: z.boolean(),
  stack: z.string().optional(),
});

export const apiErrorSchema = appErrorSchema.extend({
  statusCode: z.number().optional(),
  endpoint: z.string().optional(),
});

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type AppErrorData = z.infer<typeof appErrorSchema>;
export type ApiErrorData = z.infer<typeof apiErrorSchema>;
