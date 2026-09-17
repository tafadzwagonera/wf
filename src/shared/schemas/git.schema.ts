import { z } from 'zod';

export const branchInfoSchema = z.object({
  current: z.string(),
  all: z.array(z.string()),
  development: z.string().optional(),
  isClean: z.boolean(),
  hasUncommittedChanges: z.boolean(),
});

export const commitOptionsSchema = z.object({
  message: z.string(),
  files: z.array(z.string()).optional(),
  allowEmpty: z.boolean().optional(),
  cwd: z.string().optional(),
});

export const createBranchOptionsSchema = z.object({
  baseBranch: z.string().optional(),
  cwd: z.string().optional(),
  patternOverride: z.string().optional(),
});

export const commitInfoSchema = z.object({
  hash: z.string(),
  message: z.string(),
  author: z.string(),
  date: z.date(),
});
