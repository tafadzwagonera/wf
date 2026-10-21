import type { z } from 'zod';
import type { commitDescriptionRecordSchema, commitDescriptionResponseSchema } from '../schemas/commit-description.schema';

export type CommitDescriptionResponse = z.infer<typeof commitDescriptionResponseSchema>;
export type CommitDescriptionRecord = z.infer<typeof commitDescriptionRecordSchema>;
