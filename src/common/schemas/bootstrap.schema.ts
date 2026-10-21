import { z } from 'zod';

export const commandHelpOptionSchema = z.object({
  flags: z.string(),
  description: z.string(),
});

export const commandHelpExampleSchema = z.object({
  comment: z.string().optional(),
  command: z.string(),
});

export const commandHelpEntrySchema = z.object({
  description: z.string(),
  usage: z.string(),
  options: z.array(commandHelpOptionSchema).optional(),
  examples: z.array(commandHelpExampleSchema).optional(),
});
