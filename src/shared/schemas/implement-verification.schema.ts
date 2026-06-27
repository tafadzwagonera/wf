import { z } from 'zod';
import {
  implementRunArtifactSchema,
  verificationAttemptArtifactSchema,
  verificationFailureCategorySchema,
  retryScopeStrategySchema,
} from './agent.schema';

export const implementVerificationRunFileSchema = z.object({
  run: implementRunArtifactSchema,
  attempts: z.array(verificationAttemptArtifactSchema),
});

export const verificationSignalSchema = z.object({
  category: verificationFailureCategorySchema,
  rootSignal: z.string(),
  strategy: retryScopeStrategySchema,
  confidence: z.enum(['high', 'medium', 'low']),
});

export const implementProgressVerdictSchema = z.enum(['complete', 'continue', 'revisit', 'regress']);

export const implementProgressSignalSchema = z.object({
  score: z.number(),
  verdict: implementProgressVerdictSchema,
  reasons: z.array(z.string()),
  nextAction: z.string(),
});

export const implementProgressVerificationSnapshotSchema = z.object({
  command: z.string(),
  commandIndex: z.number(),
  exitCode: z.number(),
  diagnosticLineCount: z.number(),
  errorClasses: z.custom<Set<string>>(),
});

export const implementProgressMutationSchema = z.object({
  change: z.enum(['created', 'updated', 'deleted']),
  path: z.string(),
  changedFilesSinceLastVerification: z.array(z.string()),
});

export const implementProgressStreamEventSchema = z.object({
  kind: z.enum(['task_progress', 'tool_progress']),
  summary: z.string().optional(),
  lastToolName: z.string().optional(),
  toolName: z.string().optional(),
  elapsedTimeSeconds: z.number().optional(),
  taskId: z.string().optional(),
});
