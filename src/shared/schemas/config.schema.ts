import { z } from 'zod';

/**
 * Predicate for Zod refines on regex-valued config fields: true when `pattern`
 * compiles as a regular expression.
 *
 * @param pattern - Candidate regex source
 * @returns True when the pattern compiles
 */
export const isValidRegexPattern = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

export const wfAiProviderNameSchema = z.enum(['anthropic', 'openai', 'google', 'deepseek']);

export const wfBackendModeSchema = z.enum(['agent', 'cli', 'standard']);

export const wfPlanSkillNameSchema = z.enum([
  'frontend-design-nuxt',
  'test-driven-development',
  'writing-plans',
]);

export const wfImplementSkillNameSchema = z.enum([
  'coding-style',
  'frontend-design-nuxt',
  'test-driven-development',
]);

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
  maxTokens: z.number().int().min(1).optional(),
  outputFormat: z.enum(['json', 'md', 'yaml', 'yml']).optional(),
  timeoutMs: z.number().int().min(0).optional(),
  inactivityTimeoutMs: z.number().int().min(0).optional(),
});

export const wfPlanStageConfigSchema = wfAiStageTargetConfigSchema.extend({
  figma: z.boolean().optional(),
  skills: z.array(wfPlanSkillNameSchema).optional(),
});

export const wfVerificationConditionsConfigSchema = z.object({
  policyFile: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

export const wfImplementStageModelsConfigSchema = z.object({
  default: z.string().optional(),
  mechanical: z.string().optional(),
});

export const wfImplementStageModelRoutingThresholdsConfigSchema = z.object({
  maxTargetedWritesForDefault: z.number().int().min(1).optional(),
  maxPlanStepsForDefault: z.number().int().min(1).optional(),
});

export const wfStepVerificationModeSchema = z.enum(['push', 'pull']);

export const wfPlanStepVerificationConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    stallWindow: z.number().int().min(1).optional(),
    mode: wfStepVerificationModeSchema.optional(),
    provider: wfAiProviderNameSchema.optional(),
    model: z.string().min(1).optional(),
    backend: wfBackendModeSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.provider || value.model) return;
    ctx.addIssue({
      code: 'custom',
      message: "'model' is required when 'provider' is set",
      path: ['model'],
    });
  })
  ;

type StepVerificationProviderTarget = {
  provider: z.infer<typeof wfAiProviderNameSchema>;
  planStepVerification?: z.infer<typeof wfPlanStepVerificationConfigSchema>;
};

export const validatePullStepVerificationProvider = (
  value: StepVerificationProviderTarget,
  ctx: z.RefinementCtx,
): void => {
  const verification = value.planStepVerification;
  const provider = verification?.provider ?? value.provider;
  if (verification?.mode !== 'pull' || provider === 'anthropic' || provider === 'openai') return;
  ctx.addIssue({
    code: 'custom',
    message: "planStepVerification.mode 'pull' requires an anthropic or openai provider",
    path: verification.provider ? ['planStepVerification', 'provider'] : ['provider'],
  });
};

export const wfImplementStageConfigSchema = wfAiStageTargetConfigSchema.extend({
  figma: z.boolean().optional(),
  stallThresholdForVerificationFix: z.number().int().min(1).optional(),
  models: wfImplementStageModelsConfigSchema.optional(),
  modelRoutingThresholds: wfImplementStageModelRoutingThresholdsConfigSchema.optional(),
  skills: z.array(wfImplementSkillNameSchema).optional(),
  verificationConditions: wfVerificationConditionsConfigSchema.optional(),
  planStepVerification: wfPlanStepVerificationConfigSchema.optional(),
}).superRefine(validatePullStepVerificationProvider);

export const wfReviewStageConfigSchema = wfAiStageTargetConfigSchema.extend({
  sonar: z.boolean().optional(),
  figma: z.boolean().optional(),
  maxDiffLength: z.number().int().min(1).optional(),
  epilogueTimeoutMs: z.number().int().min(0).optional(),
});

export const wfCreateStageConfigSchema = z.object({
  verificationConditions: wfVerificationConditionsConfigSchema.optional(),
}).strict();

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
      branchNamePattern: z
        .string()
        .refine(isValidRegexPattern, { message: 'must be a valid regular expression' })
        .optional(),
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
  state: z
    .object({
      directory: z.string().optional(),
    })
    .optional(),
  log: z
    .object({
      directory: z.string().optional(),
      level: logLevelSchema.optional(),
    })
    .optional(),
  logging: z
    .object({
      directory: z.string().optional(),
      level: logLevelSchema.optional(),
    })
    .optional(),
  slack: z
    .object({
      botToken: z.string().optional(),
      userToken: z.string().optional(),
    })
    .optional(),
  figma: z
    .object({
      token: z.string().optional(),
    })
    .optional(),
  stages: z
    .object({
      plan: wfPlanStageConfigSchema.optional(),
      implement: wfImplementStageConfigSchema.optional(),
      create: wfCreateStageConfigSchema.optional(),
      review: wfReviewStageConfigSchema.optional(),
      generate: wfAiStageTargetConfigSchema.optional(),
      fetch: z.string().optional(),
      commit: wfAiStageTargetConfigSchema.optional(),
    })
    .optional(),
});

export const normalizedAiProviderConfigSchema = wfAiProviderConfigSchema.extend({
  default: z.boolean(),
  model: z.string(),
});

export const normalizedAiStageTargetConfigSchema = z.object({
  provider: wfAiProviderNameSchema,
  model: z.string(),
  backend: wfBackendModeSchema,
  maxTokens: z.number().int().min(1).optional(),
  outputFormat: z.enum(['json', 'md', 'yaml', 'yml']).optional(),
  timeoutMs: z.number().int().min(0).optional(),
  inactivityTimeoutMs: z.number().int().min(0).optional(),
});

export const normalizedPlanStageConfigSchema = normalizedAiStageTargetConfigSchema.extend({
  figma: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
});

export const normalizedReviewStageConfigSchema = normalizedAiStageTargetConfigSchema.extend({
  sonar: z.boolean().optional(),
  figma: z.boolean().optional(),
  maxDiffLength: z.number().int().min(1).optional(),
  epilogueTimeoutMs: z.number().int().min(0).optional(),
});

export const normalizedVerificationConditionsConfigSchema = z.object({
  policyFile: z.string().optional(),
  scripts: z.record(z.string(), z.string()),
});

export const normalizedImplementStageConfigSchema = z.object({
  provider: wfAiProviderNameSchema,
  figma: z.boolean().optional(),
  stallThresholdForVerificationFix: z.number().int().min(1).optional(),
  model: z.string().optional(),
  models: z.object({ default: z.string().optional(), mechanical: z.string().optional() }).optional(),
  modelRoutingThresholds: wfImplementStageModelRoutingThresholdsConfigSchema.optional(),
  backend: wfBackendModeSchema,
  maxTokens: z.number().int().min(1).optional(),
  timeoutMs: z.number().int().min(0).optional(),
  inactivityTimeoutMs: z.number().int().min(0).optional(),
  verificationConditions: normalizedVerificationConditionsConfigSchema.optional(),
  skills: z.array(z.string()).optional(),
  planStepVerification: wfPlanStepVerificationConfigSchema.optional(),
}).superRefine(validatePullStepVerificationProvider);

export const normalizedCreateStageConfigSchema = z.object({
  verificationConditions: normalizedVerificationConditionsConfigSchema.optional(),
});
