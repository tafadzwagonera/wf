// src/agents/interfaces.ts
import { CodeReview, ResolutionPlan } from '../integrations/ai/ai.service';

export type ResolutionAction = 'feature' | 'fix' | 'investigate';

export interface TicketArtifact {
  ticketKey: string;
  content: string;
  path: string;
}

export interface PlanArtifact {
  plan: ResolutionPlan;
  action: ResolutionAction;
  path: string;
  fromCache?: boolean;
}

export interface ReviewArtifact {
  review: CodeReview;
  path: string;
  approved: boolean;
}

export interface FetcherOptions {
  platformName: string;
  repo?: string;
  skipExisting?: boolean;
  baseDir?: string;
}

export interface PlannerOptions {
  action: ResolutionAction;
  skipExisting?: boolean;
  affectedRepositories?: string[];
}

/** platformName is required to apply Atlassian vs GitHub ticket-key casing rules. */
export interface ImplementerOptions {
  platformName: string;
  repoDir?: string;
  suppressHeader?: boolean;
}

export interface ReviewerOptions {
  skipExisting?: boolean;
  repoDir?: string;
  suppressHeader?: boolean;
}

export interface FindingsArtifact {
  action: 'investigate';
  summary: string;
  findings: string[];
  recommendations: string[];
  conclusion: string;
  path: string;
}

export type ImplementerResult =
  | { type: 'implementation'; branchName: string }
  | { type: 'investigation'; artifact: FindingsArtifact };
