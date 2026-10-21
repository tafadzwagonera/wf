import { z } from 'zod';

export const createTicketRequestSchema = z.object({
  project: z.string(),
  summary: z.string(),
  description: z.string(),
  issueType: z.string(),
  priority: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  components: z.array(z.string()).optional(),
});

export const jiraTicketSchema = z.object({
  key: z.string(),
  id: z.string(),
  summary: z.string(),
  description: z.string(),
  status: z.string(),
  issueType: z.string(),
  priority: z.string(),
  assignee: z.string().optional(),
  reporter: z.string().optional(),
  created: z.date(),
  updated: z.date(),
  labels: z.array(z.string()),
  components: z.array(z.string()),
});

export const updateTicketRequestSchema = z.object({
  summary: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assignee: z.string().optional(),
});

export const jiraSearchRequestSchema = z.object({
  jql: z.string(),
  maxResults: z.number().optional(),
  fields: z.array(z.string()).optional(),
});
