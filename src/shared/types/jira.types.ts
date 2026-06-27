import type { z } from 'zod';
import type {
  createTicketRequestSchema,
  jiraSearchRequestSchema,
  jiraTicketSchema,
  updateTicketRequestSchema,
} from '../schemas/jira.schema';

export type CreateTicketRequest = z.infer<typeof createTicketRequestSchema>;
export type JiraSearchRequest = z.infer<typeof jiraSearchRequestSchema>;
export type JiraTicket = z.infer<typeof jiraTicketSchema>;
export type UpdateTicketRequest = z.infer<typeof updateTicketRequestSchema>;
