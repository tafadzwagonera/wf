import type { z } from 'zod';
import type { batchSummarySchema } from '../schemas/batch-summary.schema';

export type BatchSummary = z.infer<typeof batchSummarySchema>;
