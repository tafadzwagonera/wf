import { z } from 'zod';
import { planVerificationConfigSchema } from './verification.schema';

export const ecosystemSchema = z.enum(['node', 'terraform', 'python', 'go']);

export const nodeFrameworkSchema = z.enum(['jest', 'vitest', 'mocha', 'tap', 'ava']);

export const diSetupPatternSchema = z.enum(['testing-module', 'factory-function']).nullable();

export const nodeInfraSchema = z.object({
  ecosystem: z.literal('node'),
  nodeVersionMajor: z.number().nullable(),
  hasNodeTest: z.boolean(),
  frameworks: z.array(nodeFrameworkSchema),
  scripts: z.record(z.string(), z.string()),
  allScriptNames: z.array(z.string()),
  testPatterns: z
    .object({
      fileSuffix: z.enum(['.spec', '.test', 'mixed']),
      mockPrefix: z.string().nullable(),
      mockFactoryPrefix: z.string().nullable(),
      describeStyle: z.enum(['flat', 'nested']),
      helperPaths: z.array(z.string()),
      mockCleanup: z.object({
        namespace: z.string(),
        method: z.enum(['restoreAllMocks', 'resetAllMocks', 'clearAllMocks']),
      }).nullable(),
      diSetupPattern: diSetupPatternSchema,
      errorHandlerExits: z.boolean(),
    })
    .optional(),
});

export const terraformInfraSchema = z.object({
  ecosystem: z.literal('terraform'),
  hasTfFiles: z.boolean(),
  hasBackendConfig: z.boolean(),
});

export const pythonInfraSchema = z.object({
  ecosystem: z.literal('python'),
  frameworks: z.array(z.enum(['pytest', 'unittest', 'tox', 'nox'])),
  hasRequirementsTxt: z.boolean(),
});

export const goInfraSchema = z.object({
  ecosystem: z.literal('go'),
  hasGoMod: z.boolean(),
});

export const ecosystemInfraSchema = z.union([nodeInfraSchema, terraformInfraSchema, pythonInfraSchema, goInfraSchema]);

export const testInfraContextSchema = z.object({
  ecosystems: z.array(ecosystemInfraSchema),
  primary: ecosystemSchema,
});

export const repoLanguageSchema = z.enum(['typescript', 'javascript', 'go', 'python', 'terraform', 'unknown']);

export const gitHooksContextSchema = z.object({
  tool: z.enum(['lefthook', 'husky', 'simple-git-hooks']),
  hooks: z.record(z.string(), z.array(z.string())),
});

export const repoConventionsContextSchema = z.object({
  language: repoLanguageSchema,
  linter: z
    .object({
      tool: z.string(),
      keyRules: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  formatter: z
    .object({
      tool: z.string(),
      keyRules: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  typescript: z
    .object({
      strict: z.boolean(),
      module: z.string(),
      target: z.string(),
      paths: z.record(z.string(), z.array(z.string())),
    })
    .nullable(),
  go: z.object({ modulePath: z.string() }).nullable(),
  python: z
    .object({
      tool: z.string(),
      keySettings: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  terraform: z
    .object({
      providers: z.array(z.string()),
      backend: z.string().nullable(),
      modulePaths: z.array(z.string()),
    })
    .nullable(),
  folderStructure: z.array(z.string()),
  namingPattern: z.enum(['camelCase', 'kebab-case', 'PascalCase', 'mixed']),
  nestjsDetected: z.boolean(),
  importStyle: z.enum(['commonjs', 'esm', 'unknown']),
  keyDependencies: z.array(z.string()),
  errorHandlingPaths: z.array(z.string()),
  packageManager: z.enum(['bun', 'pnpm', 'yarn', 'npm']).default('npm'),
  gitHooks: z.array(gitHooksContextSchema).default([]),
});

export const priorPlanSummarySchema = z.object({
  title: z.string(),
  summary: z.string(),
  filename: z.string(),
  artifactPath: z.string(),
  keywords: z.array(z.string()),
  steps: z.array(z.string()).optional(),
  action: z.enum(['feature', 'fix', 'investigate']),
  estimatedComplexity: z.enum(['low', 'medium', 'high']).optional(),
  ticketKey: z.string().nullable(),
});

export const priorPlanContextSchema = z.object({
  plans: z.array(priorPlanSummarySchema),
  repoName: z.string(),
});

export const sourceSnippetSchema = z.object({
  filePath: z.string(),
  content: z.string(),
});

export const planCorrelationMatchSchema = z.object({
  summary: z.string(),
  filename: z.string(),
  action: z.enum(['feature', 'fix', 'investigate']),
  estimatedComplexity: z.enum(['low', 'medium', 'high']).optional(),
  overlapScore: z.number(),
  sharedKeywords: z.array(z.string()),
  matchSource: z.literal('keyword').default('keyword'),
  affectedFiles: z.array(z.string()).optional(),
  affectedFilesContext: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  verification: planVerificationConfigSchema.optional(),
  sourceSnippets: z.array(sourceSnippetSchema),
});

export const planCorrelationResultSchema = z.object({
  matches: z.array(planCorrelationMatchSchema),
  repoName: z.string(),
});

export const crossRepoPatternSchema = z.object({
  repoName: z.string(),
  deltas: z.array(z.string()),
});

export const crossRepoContextSchema = z.object({
  patterns: z.array(crossRepoPatternSchema),
});
