// src/agents/interfaces.ts
export type ResolutionAction = 'implement' | 'fix' | 'investigate';

export interface TicketArtifact {
  ticketKey: string;
  content: string;
  path: string;
}

export interface PlanArtifact {
  plan: any;
  action: ResolutionAction;
  path: string;
}

export interface ReviewArtifact {
  review: any;
  path: string;
  approved: boolean;
}

export interface FetcherOptions {
  platformName: string;
  repo?: string;
  skipExisting?: boolean;
}

export interface PlannerOptions {
  action: ResolutionAction;
  skipExisting?: boolean;
  affectedRepositories?: string[];
}

/** platformName is required to apply Atlassian vs GitHub ticket-key casing rules. */
export interface ImplementerOptions {
  platformName: string;
}

export interface ReviewerOptions {
  skipExisting?: boolean;
}
