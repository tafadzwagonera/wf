import type { z } from 'zod';
import type {
  crossRepoContextSchema,
  crossRepoPatternSchema,
  diSetupPatternSchema,
  ecosystemInfraSchema,
  ecosystemSchema,
  gitHooksContextSchema,
  goInfraSchema,
  nodeFrameworkSchema,
  nodeInfraSchema,
  planCorrelationMatchSchema,
  planCorrelationResultSchema,
  priorPlanContextSchema,
  priorPlanSummarySchema,
  pythonInfraSchema,
  repoConventionsContextSchema,
  repoLanguageSchema,
  sourceSnippetSchema,
  terraformInfraSchema,
  testInfraContextSchema,
} from '../schemas/detection.schema';

export type CrossRepoContext = z.infer<typeof crossRepoContextSchema>;
export type DiSetupPattern = z.infer<typeof diSetupPatternSchema>;
export type CrossRepoPattern = z.infer<typeof crossRepoPatternSchema>;
export type Ecosystem = z.infer<typeof ecosystemSchema>;
export type EcosystemInfra = z.infer<typeof ecosystemInfraSchema>;
export type GitHooksContext = z.infer<typeof gitHooksContextSchema>;
export type GoInfra = z.infer<typeof goInfraSchema>;
export type NodeFramework = z.infer<typeof nodeFrameworkSchema>;
export type NodeInfra = z.infer<typeof nodeInfraSchema>;
export type PlanCorrelationMatch = z.infer<typeof planCorrelationMatchSchema>;
export type PlanCorrelationResult = z.infer<typeof planCorrelationResultSchema>;
export type PriorPlanContext = z.infer<typeof priorPlanContextSchema>;
export type PriorPlanSummary = z.infer<typeof priorPlanSummarySchema>;
export type PythonInfra = z.infer<typeof pythonInfraSchema>;
export type RepoConventionsContext = z.infer<typeof repoConventionsContextSchema>;
export type RepoLanguage = z.infer<typeof repoLanguageSchema>;
export type SourceSnippet = z.infer<typeof sourceSnippetSchema>;
export type TerraformInfra = z.infer<typeof terraformInfraSchema>;
export type TestInfraContext = z.infer<typeof testInfraContextSchema>;
