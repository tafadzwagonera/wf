import { z } from 'zod';

export const ticketTypeSchema = z.enum(['task', 'bug', 'story', 'todo', 'epic', 'subtask']);

export const ticketPrioritySchema = z.enum(['highest', 'high', 'medium', 'low', 'lowest']);

export const ticketStatusSchema = z.enum(['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']);

export const issueTrackerTicketReferenceSchema = z.object({
  tracker: z.string(),
  id: z.string(),
  key: z.string().optional(),
  url: z.string().optional(),
});

export const createPullRequestOptionsSchema = z.object({
  title: z.string(),
  body: z.string(),
  head: z.string(),
  base: z.string(),
  repo: z.string().optional(),
});

export const issueTrackerFeatureSchema = z.enum([
  'create_ticket',
  'get_ticket',
  'update_ticket',
  'delete_ticket',
  'search_tickets',
  'get_pull_request',
  'create_comment',
  'assign_ticket',
  'add_labels',
  'create_inline_comment',
  'create_pull_request',
]);
