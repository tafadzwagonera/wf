import { z } from 'zod';

export const wfAiProviderNameSchema = z.enum(['anthropic', 'openai', 'google', 'deepseek']);

export const wfBackendModeSchema = z.enum(['agent', 'cli', 'standard']);

export const wfAiProviderConfigSchema = z.object({
  provider: wfAiProviderNameSchema,
  apiKey: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().int().min(1).optional(),
  default: z.boolean().optional(),
});

export const wfAiStageTargetConfigSchema = z.object({
  provider: wfAiProviderNameSchema,
  model: z.string().optional(),
  backend: wfBackendModeSchema.optional(),
  outputFormat: z.enum(['json', 'md', 'yaml', 'yml']).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  inactivityTimeoutMs: z.number().int().min(1000).optional(),
});

export const wfVerificationConditionsConfigSchema = z.object({
  policyFile: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

export const wfImplementStageModelsConfigSchema = z.object({
  default: z.string().optional(),
  mechanical: z.string().optional(),
});

export const wfImplementStageConfigSchema = wfAiStageTargetConfigSchema.extend({
  models: wfImplementStageModelsConfigSchema.optional(),
  verificationConditions: wfVerificationConditionsConfigSchema.optional(),
});

export const wfCreateStageConfigSchema = z.object({
  provider: wfAiProviderNameSchema.optional(),
  model: z.string().optional(),
  backend: wfBackendModeSchema.optional(),
  verificationConditions: wfVerificationConditionsConfigSchema.optional(),
});

export const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug']);

export const wfConfigSchema = z.object({
  tracker: z.enum(['jira', 'github', 'bitbucket']).optional(),
  ai: z.array(wfAiProviderConfigSchema).optional(),
  atlassian: z
    .object({
      baseUrl: z.string().optional(),
      email: z.string().optional(),
      apiToken: z.string().optional(),
      jira: z
        .object({
          apiToken: z.string().optional(),
          defaultProject: z.string().optional(),
        })
        .optional(),
      bitbucket: z
        .object({
          workspace: z.string().optional(),
          apiToken: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  github: z
    .object({
      token: z.string().optional(),
      defaultRepo: z.string().optional(),
    })
    .optional(),
  git: z
    .object({
      commitFormat: z.enum(['conventional', 'freeform', 'auto']).optional(),
      branchNamePattern: z.string().optional(),
      branchPrefixMapping: z
        .object({
          feature: z.string().optional(),
          fix: z.string().optional(),
          investigate: z.string().optional(),
        })
        .optional(),
      protectedBranches: z.array(z.string()).optional(),
    })
    .optional(),
  log: z
    .object({
      level: logLevelSchema.optional(),
    })
    .optional(),
  logging: z
    .object({
      level: logLevelSchema.optional(),
    })
    .optional(),
  slack: z
    .object({
      botToken: z.string().optional(),
      userToken: z.string().optional(),
    })
    .optional(),
  stages: z
    .object({
      plan: wfAiStageTargetConfigSchema.optional(),
      implement: wfImplementStageConfigSchema.optional(),
      create: wfCreateStageConfigSchema.optional(),
      review: wfAiStageTargetConfigSchema.optional(),
      generate: wfAiStageTargetConfigSchema.optional(),
      fetch: z.string().optional(),
      commit: wfAiStageTargetConfigSchema.optional(),
    })
    .optional(),
});

// Normalized config schemas
export const normalizedAiStageTargetConfigSchema = z.object({
  provider: wfAiProviderNameSchema,
  model: z.string(),
  backend: wfBackendModeSchema,
  outputFormat: z.enum(['json', 'md', 'yaml', 'yml']).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  inactivityTimeoutMs: z.number().int().min(1000).optional(),
});

export const normalizedVerificationConditionsConfigSchema = z.object({
  policyFile: z.string().optional(),
  scripts: z.record(z.string(), z.string()),
});

export const normalizedImplementStageConfigSchema = z.object({
  provider: wfAiProviderNameSchema,
  model: z.string().optional(),
  models: z.object({ default: z.string().optional(), mechanical: z.string().optional() }).optional(),
  backend: wfBackendModeSchema,
  verificationConditions: normalizedVerificationConditionsConfigSchema.optional(),
});

export const normalizedCreateStageConfigSchema = z.object({
  provider: wfAiProviderNameSchema.optional(),
  model: z.string().optional(),
  backend: wfBackendModeSchema.optional(),
  verificationConditions: normalizedVerificationConditionsConfigSchema.optional(),
});
