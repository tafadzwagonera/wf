import type { z } from 'zod';
import type {
  logLevelSchema,
  normalizedAiProviderConfigSchema,
  normalizedAiStageTargetConfigSchema,
  normalizedCreateStageConfigSchema,
  normalizedImplementStageConfigSchema,
  normalizedReviewStageConfigSchema,
  normalizedVerificationConditionsConfigSchema,
  wfAiProviderConfigSchema,
  wfAiProviderNameSchema,
  wfAiStageTargetConfigSchema,
  wfBackendModeSchema,
  wfConfigSchema,
  wfCreateStageConfigSchema,
  wfImplementSkillNameSchema,
  wfImplementStageModelRoutingThresholdsConfigSchema,
  wfImplementStageConfigSchema,
  wfImplementStageModelsConfigSchema,
  wfPlanSkillNameSchema,
  wfPlanStepVerificationConfigSchema,
  wfPlanStageConfigSchema,
  wfReviewSkillNameSchema,
  wfReviewStageConfigSchema,
  wfStepVerificationModeSchema,
  wfVerificationConditionsConfigSchema,
} from '../schemas/config.schema';

export type LogLevel = z.infer<typeof logLevelSchema>;
export type NormalizedAiProviderConfig = z.infer<typeof normalizedAiProviderConfigSchema>;
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
export type WfImplementSkillName = z.infer<typeof wfImplementSkillNameSchema>;
export type WfImplementStageConfig = z.infer<typeof wfImplementStageConfigSchema>;
export type WfImplementStageModelRoutingThresholdsConfig = z.infer<
  typeof wfImplementStageModelRoutingThresholdsConfigSchema
>;
export type WfImplementStageModelsConfig = z.infer<typeof wfImplementStageModelsConfigSchema>;
export type WfPlanSkillName = z.infer<typeof wfPlanSkillNameSchema>;
export type WfPlanStepVerificationConfig = z.infer<typeof wfPlanStepVerificationConfigSchema>;
export type WfPlanStageConfig = z.infer<typeof wfPlanStageConfigSchema>;
export type NormalizedReviewStageConfig = z.infer<typeof normalizedReviewStageConfigSchema>;
export type WfReviewSkillName = z.infer<typeof wfReviewSkillNameSchema>;
export type WfReviewStageConfig = z.infer<typeof wfReviewStageConfigSchema>;
export type WfStepVerificationMode = z.infer<typeof wfStepVerificationModeSchema>;
export type WfVerificationConditionsConfig = z.infer<typeof wfVerificationConditionsConfigSchema>;
