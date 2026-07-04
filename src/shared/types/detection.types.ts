import type { z } from 'zod';
import type {
  commitEvidenceSchema,
  crossRepoContextSchema,
  crossRepoPatternSchema,
  ecosystemInfraSchema,
  ecosystemSchema,
  goInfraSchema,
  nodeFrameworkSchema,
  nodeInfraSchema,
  priorPlanContextSchema,
  priorPlanSummarySchema,
  priorTicketContextSchema,
  priorTicketSummarySchema,
  pythonInfraSchema,
  recurrenceCandidateSchema,
  recurrenceGapAnalysisSchema,
  repoConventionsContextSchema,
  repoLanguageSchema,
  terraformInfraSchema,
  testInfraContextSchema,
} from '../schemas/detection.schema';

export type CommitEvidence = z.infer<typeof commitEvidenceSchema>;
export type CrossRepoContext = z.infer<typeof crossRepoContextSchema>;
export type CrossRepoPattern = z.infer<typeof crossRepoPatternSchema>;
export type Ecosystem = z.infer<typeof ecosystemSchema>;
export type EcosystemInfra = z.infer<typeof ecosystemInfraSchema>;
export type GoInfra = z.infer<typeof goInfraSchema>;
export type NodeFramework = z.infer<typeof nodeFrameworkSchema>;
export type NodeInfra = z.infer<typeof nodeInfraSchema>;
export type PriorPlanContext = z.infer<typeof priorPlanContextSchema>;
export type PriorPlanSummary = z.infer<typeof priorPlanSummarySchema>;
export type PriorTicketContext = z.infer<typeof priorTicketContextSchema>;
export type PriorTicketSummary = z.infer<typeof priorTicketSummarySchema>;
export type PythonInfra = z.infer<typeof pythonInfraSchema>;
export type RecurrenceCandidate = z.infer<typeof recurrenceCandidateSchema>;
export type RecurrenceGapAnalysis = z.infer<typeof recurrenceGapAnalysisSchema>;
export type RepoConventionsContext = z.infer<typeof repoConventionsContextSchema>;
export type RepoLanguage = z.infer<typeof repoLanguageSchema>;
export type TerraformInfra = z.infer<typeof terraformInfraSchema>;
export type TestInfraContext = z.infer<typeof testInfraContextSchema>;
