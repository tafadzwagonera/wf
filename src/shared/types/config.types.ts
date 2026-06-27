import type { z } from 'zod';
import type {
  logLevelSchema,
  normalizedAiStageTargetConfigSchema,
  normalizedCreateStageConfigSchema,
  normalizedImplementStageConfigSchema,
  normalizedVerificationConditionsConfigSchema,
  wfAiProviderConfigSchema,
  wfAiProviderNameSchema,
  wfAiStageTargetConfigSchema,
  wfBackendModeSchema,
  wfConfigSchema,
  wfCreateStageConfigSchema,
  wfImplementStageConfigSchema,
  wfImplementStageModelsConfigSchema,
  wfVerificationConditionsConfigSchema,
} from '../schemas/config.schema';

export type LogLevel = z.infer<typeof logLevelSchema>;
export type NormalizedAiStageTargetConfig = z.infer<typeof normalizedAiStageTargetConfigSchema>;
export type NormalizedCreateStageConfig = z.infer<typeof normalizedCreateStageConfigSchema>;
export type NormalizedImplementStageConfig = z.infer<typeof normalizedImplementStageConfigSchema>;
export type NormalizedVerificationConditionsConfig = z.infer<typeof normalizedVerificationConditionsConfigSchema>;
export type WfAiProviderConfig = z.infer<typeof wfAiProviderConfigSchema>;
export type WfAiProviderName = z.infer<typeof wfAiProviderNameSchema>;
export type WfAiStageTargetConfig = z.infer<typeof wfAiStageTargetConfigSchema>;
export type WfBackendMode = z.infer<typeof wfBackendModeSchema>;
export type WfConfig = z.infer<typeof wfConfigSchema>;
export type WfCreateStageConfig = z.infer<typeof wfCreateStageConfigSchema>;
export type WfImplementStageConfig = z.infer<typeof wfImplementStageConfigSchema>;
export type WfImplementStageModelsConfig = z.infer<typeof wfImplementStageModelsConfigSchema>;
export type WfVerificationConditionsConfig = z.infer<typeof wfVerificationConditionsConfigSchema>;
