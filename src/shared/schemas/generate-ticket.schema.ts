import { z } from 'zod';

export const generateTicketSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['task', 'bug', 'story', 'epic', 'subtask']),
  priority: z.enum(['highest', 'high', 'medium', 'low', 'lowest']),
  description: z.string().min(1),
});

export type GenerateTicketOutput = z.infer<typeof generateTicketSchema>;
