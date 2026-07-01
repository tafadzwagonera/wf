import { z } from 'zod';

export const ecosystemSchema = z.enum(['node', 'terraform', 'python', 'go']);

export const nodeFrameworkSchema = z.enum(['jest', 'vitest', 'mocha', 'tap', 'ava']);

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
      mockCleanup: z.enum(['restoreAllMocks', 'resetAllMocks', 'clearAllMocks']).nullable(),
      diSetupPattern: z.enum(['testing-module', 'factory-function']).nullable(),
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

export const repoConventionsContextSchema = z.object({
  language: repoLanguageSchema,
  linter: z
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
});

export const priorTicketSummarySchema = z.object({
  title: z.string(),
  summary: z.string(),
  filename: z.string(),
  keywords: z.array(z.string()),
});

export const priorTicketContextSchema = z.object({
  tickets: z.array(priorTicketSummarySchema),
  repoName: z.string(),
});

export const commitEvidenceSchema = z.object({
  hash: z.string(),
  message: z.string(),
  filesChanged: z.array(z.string()),
});

export const recurrenceCandidateSchema = z.object({
  title: z.string(),
  summary: z.string(),
  ticketKey: z.string().nullable(),
  overlapScore: z.number(),
  sharedKeywords: z.array(z.string()),
  commits: z.array(commitEvidenceSchema),
});

export const recurrenceGapAnalysisSchema = z.object({
  isRecurrence: z.boolean(),
  candidates: z.array(recurrenceCandidateSchema),
  gaps: z.array(z.string()),
  rootCauseHypothesis: z.string().nullable(),
});

export const crossRepoPatternSchema = z.object({
  repoName: z.string(),
  deltas: z.array(z.string()),
});

export const crossRepoContextSchema = z.object({
  patterns: z.array(crossRepoPatternSchema),
});
