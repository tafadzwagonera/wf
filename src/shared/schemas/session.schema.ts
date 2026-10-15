import { z } from 'zod';
import { wfAiProviderNameSchema, wfBackendModeSchema } from './config.schema';

export const stageConfigFingerprintSchema = z.object({
  provider: wfAiProviderNameSchema,
  backend: wfBackendModeSchema,
  model: z.string().optional(),
});

export const stageRecordEntrySchema = z.object({
  kind: z.enum(['plan-problem', 'deviation']),
  repo: z.string().nullable(),
  stepIndex: z.number().int().nullable(),
  text: z.string(),
  at: z.string(),
});

const sanitiseRecords = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.filter(item => stageRecordEntrySchema.safeParse(item).success) : [];

export const stageRecordSchema = z.object({
  config: stageConfigFingerprintSchema,
  model: z.string(),
  /**
   * Models the stage actually ran with.
   *
   * `model` is the configured model resolved at stage start, which the implement stage then
   * overrides per step when auto-routing to a mechanical model — so on its own it reports a
   * model that may never have run. Defaults to empty so sessions written before this field
   * existed still parse.
   */
  modelsUsed: z.array(z.string()).default([]),
  providerSessionId: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  records: z.preprocess(sanitiseRecords, z.array(stageRecordEntrySchema)).default([]),
});

export const sessionStateSchema = z.object({
  sessionId: z.string(),
  ticketKey: z.string(),
  toStage: z.string().nullable().default(null),
  action: z.string().nullable().default(null),
  sourceType: z.enum(['ticket', 'custom']).nullable().default(null),
  customPlanRef: z.string().nullable().default(null),
  sourceBranch: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  stages: z.record(z.string(), stageRecordSchema),
});
