import { z } from 'zod';

/** Structured response contract for batched review-diff summarisation: one Markdown-bullet summary per file. */
export const batchSummarySchema = z.object({
  summaries: z.array(
    z.object({
      file: z.string().min(1),
      summary: z.string().min(1),
    }),
  ),
});
