import { z } from 'zod';

export const apiCallPreviewSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'CLI']),
  endpoint: z.string(),
  platform: z.string(),
  description: z.string(),
  estimatedResponse: z.string().optional(),
  payloadPreviewLines: z.array(z.string()).optional(),
});

export const fileWritePreviewSchema = z.object({
  filePath: z.string(),
  operation: z.enum(['create', 'overwrite']),
  sizeEstimate: z.string(),
  format: z.string().optional(),
  contentPreview: z.string().optional(),
});

export const fileReadPreviewSchema = z.object({
  filePath: z.string(),
  exists: z.boolean(),
  sizeInKb: z.string().optional(),
});

export const gitOperationPreviewSchema = z.object({
  operation: z.enum(['commit', 'branch', 'checkout', 'push']),
  description: z.string(),
  fileCount: z.number().optional(),
  message: z.string().optional(),
});

export const dryRunSummarySchema = z.object({
  apiCallCount: z.number(),
  fileCreatedCount: z.number(),
  fileModifiedCount: z.number(),
  gitOperationCount: z.number(),
  terminalOutputLines: z.array(z.string()).optional(),
});
