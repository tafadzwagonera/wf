import type { z } from 'zod';
import type {
  apiCallPreviewSchema,
  fileReadPreviewSchema,
  fileWritePreviewSchema,
  gitOperationPreviewSchema,
  dryRunSummarySchema,
} from '../schemas/preview.schema';

export type ApiCallPreview = z.infer<typeof apiCallPreviewSchema>;
export type DryRunSummary = z.infer<typeof dryRunSummarySchema>;
export type FileReadPreview = z.infer<typeof fileReadPreviewSchema>;
export type FileWritePreview = z.infer<typeof fileWritePreviewSchema>;
export type GitOperationPreview = z.infer<typeof gitOperationPreviewSchema>;
