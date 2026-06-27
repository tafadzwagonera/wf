import type { z } from 'zod';
import type {
  createPullRequestOptionsSchema,
  issueTrackerFeatureSchema,
  issueTrackerTicketReferenceSchema,
  ticketPrioritySchema,
  ticketStatusSchema,
  ticketTypeSchema,
} from '../schemas/ticket.schema';

export type CreatePullRequestOptions = z.infer<typeof createPullRequestOptionsSchema>;
export type IssueTrackerFeature = z.infer<typeof issueTrackerFeatureSchema>;
export type IssueTrackerTicketReference = z.infer<typeof issueTrackerTicketReferenceSchema>;
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;
export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export type TicketType = z.infer<typeof ticketTypeSchema>;
