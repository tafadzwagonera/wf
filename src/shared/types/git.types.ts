import type { z } from 'zod';
import type { branchInfoSchema, commitOptionsSchema, commitInfoSchema } from '../schemas/git.schema';

export type BranchInfo = z.infer<typeof branchInfoSchema>;
export type CommitOptions = z.infer<typeof commitOptionsSchema>;
export type CommitInfo = z.infer<typeof commitInfoSchema>;
